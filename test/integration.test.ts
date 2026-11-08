import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../src/index.ts';

test('actual extension entry registers the checkpoint tool and both commands', () => {
  const tools: string[] = [], commands: string[] = [];
  extension({ on() {}, events: { emit() {} }, appendEntry() {},
    registerTool(tool: {name: string}) { tools.push(tool.name); },
    registerCommand(name: string) { commands.push(name); } });
  assert.deepEqual(tools, ['task_checkpoint']);
  assert.deepEqual(commands, ['checkpoint', 'phase-trace']);
});

import { registerGoals, type GoalContext, type GoalHandler, type GoalPi, type GoalTool } from '../src/integration.ts';
import { CHECKPOINT_ENTRY, type BranchEntry, type Note, type TraceInput, type TraceKind, type TraceRecorder } from '../src/contracts.ts';

function fixture(failTrace = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shazam-integration-')));
  const file = join(root, 'session.jsonl');
  let session = 'synthetic-session';
  let parentSession: string | undefined;
  const entries: BranchEntry[] = [];
  const hooks = new Map<string, GoalHandler[]>();
  const tools = new Map<string, GoalTool>();
  const commands = new Map<string, {handler(args: string, ctx: GoalContext): Promise<void>}>();
  const notices: string[] = [];
  const observations: { kind: TraceKind; input?: TraceInput }[] = [];
  let roles: string[] = ['root'];
  let generation = 'generation-1';
  let failWrite = false, noWrite = false;
  let confirmations = 0;
  const trace: TraceRecorder = {
    beginSession() {}, event(kind, input) { observations.push({kind, input}); },
    async summary() { return 'Synthetic trace summary'; }, async close() {},
  };
  const write = () => writeFileSync(file, [JSON.stringify({type:'session',id:session}), ...entries.map(value => JSON.stringify(value))].join('\n') + '\n');
  write();
  const ctx: GoalContext = {
    sessionManager: {
      getSessionFile: () => file, getSessionId: () => session,
      getBranch: () => entries, getHeader: () => parentSession ? {parentSession} : {},
    },
    ui: { notify(message) { notices.push(message); }, async confirm() { confirmations++; return true; } },
  };
  const pi: GoalPi = {
    on(event, handler) { hooks.set(event, [...hooks.get(event) ?? [], handler]); },
    events: { emit(event, request) {
      if (event === 'subagents:identity') for (const status of roles) request.respond({status,sessionFile:file});
      if (event === 'session-lifecycle:admission') request.respond({managed:true,status:'owned',generation,sessionFile:file});
    } },
    appendEntry(customType, data) {
      if (noWrite) return;
      const entry = {id:`entry-${entries.length}`,type:'custom',customType,data:structuredClone(data)};
      entries.push(entry);
      if (failWrite) throw new Error('private disk error');
      appendFileSync(file, JSON.stringify(entry)+'\n');
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  registerGoals(pi, () => { if (failTrace) throw new Error('PRIVATE_TRACE_FAILURE'); return trace; });
  const emit = async (type: string, value: Record<string, unknown> = {}) => {
    let result: unknown;
    for (const handler of hooks.get(type) ?? []) result = await handler({type, ...value}, ctx);
    return result as {messages?: unknown[]; action?: string} | undefined;
  };
  const note: Note = {schema_version:1,outcome:'Deliver artifact',source_ref:'input-1',origin:'agent_interpretation',next_deliverable:'Verify artifact',decisions:[]};
  const call = (parameters: unknown, signal?: AbortSignal) => tools.get('task_checkpoint')!.execute('synthetic-call', parameters, signal, undefined, ctx);
  const read = async () => (await call({action:'read'})).details;
  const replace = async (value: Note = note) => call({action:'replace', expected_revision:(await read()).view.revision, note:value});
  const command = (args: string) => commands.get('checkpoint')!.handler(args, ctx);
  return {root,file,entries,notices,observations,ctx,pi,note,emit,call,read,replace,command,
    setRoles(value:string[]) { roles=value; }, setGeneration(value:string) { generation=value; },
    setFailWrite(value:boolean) { failWrite=value; }, setNoWrite(value:boolean) { noWrite=value; },
    setFork() { parentSession='synthetic-parent'; session='fork-session'; write(); },
    confirmations:()=>confirmations, cleanup:()=>rmSync(root,{recursive:true,force:true}),
  };
}

test('checkpoint writes are saved, cues preserve inputs, and only boundaries rearm them', async () => {
  const f = fixture(); try {
    await f.emit('session_start',{reason:'startup'});
    const write = await f.replace();
    assert.equal(write.details.provenance,'saved');
    const original = {role:'user',content:[{type:'image',data:'synthetic'}]};
    const input = [original];
    const first = await f.emit('context',{messages:input});
    assert.equal(first!.messages!.length,2);
    assert.equal(first!.messages![0],original);
    assert.deepEqual(input,[original]);
    const again = await f.emit('context',{messages:first!.messages});
    assert.equal(again!.messages!.length,2);
    await f.emit('before_provider_request');
    assert.equal((await f.emit('context',{messages:input}))!.messages!.length,1);
    await f.emit('input',{source:'extension'});
    assert.equal((await f.emit('context',{messages:input}))!.messages!.length,1);
    await f.emit('input',{source:'rpc'});
    assert.equal((await f.emit('context',{messages:input}))!.messages!.length,2);
    await assert.rejects(f.call({action:'replace',expected_revision:null,note:f.note}));
  } finally { f.cleanup(); }
});

test('human pause survives replacement and restart; control needs native confirmation', async () => {
  const f = fixture(); try {
    await f.emit('session_start',{reason:'startup'}); await f.replace();
    await f.command('pause'); assert.equal(f.confirmations(),1);
    await f.replace({...f.note,next_deliverable:'A changed deliverable'});
    await f.emit('session_start',{reason:'reload'});
    assert.equal((await f.read()).view.paused,true);
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,0);
    delete f.ctx.ui.confirm;
    await f.command('resume'); assert.equal((await f.read()).view.paused,true);
    f.ctx.ui.confirm = async () => false;
    await f.command('resume'); assert.equal((await f.read()).view.paused,true);
    f.ctx.ui.confirm = async () => true;
    await f.command('resume'); assert.equal((await f.read()).view.paused,false);
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,1);
    assert(f.notices.some(message=>message.includes('native UI confirmation')));
  } finally { f.cleanup(); }
});

test('fork activation belongs to the new session and persists through reload', async () => {
  const f = fixture(); try {
    await f.emit('session_start',{reason:'startup'}); await f.replace(); await f.command('resume');
    f.setFork(); await f.emit('session_start',{reason:'fork'});
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,0);
    await f.replace();
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,0);
    await f.command('resume');
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,1);
    await f.emit('session_start',{reason:'reload'});
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,1);
  } finally { f.cleanup(); }
});

test('missing, child, duplicate and stale ownership refuse checkpoint actions but preserve trace events', async () => {
  for (const roles of [[],['child'],['root','root']]) {
    const f = fixture(); try {
      f.setRoles(roles); await f.emit('session_start',{reason:'startup'});
      await assert.rejects(f.read(),/root identity/);
      await f.emit('before_provider_request');
      assert.equal(f.observations.at(-1)!.kind,'request_start');
      assert.deepEqual(await f.emit('context',{messages:['original']}),{messages:['original']});
    } finally { f.cleanup(); }
  }
  const f = fixture(); try {
    await f.emit('session_start',{reason:'startup'}); await f.replace();
    f.setGeneration('generation-2');
    await assert.rejects(f.read(),/root identity/);
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,0);
  } finally { f.cleanup(); }
});

test('ownership changes during confirmation cannot mutate the new owner', async () => {
  const f = fixture(); try {
    await f.emit('session_start',{reason:'startup'}); await f.replace();
    const before = f.entries.length;
    f.ctx.ui.confirm = async () => { f.setGeneration('generation-2'); return true; };
    await f.command('clear');
    assert.equal(f.entries.length,before);
  } finally { f.cleanup(); }
});

test('memory ghosts and silent append refusal are never successful saved writes', async () => {
  const f = fixture(); try {
    await f.emit('session_start',{reason:'startup'});
    f.setNoWrite(true); await assert.rejects(f.replace(),/save uncertain/);
    f.setNoWrite(false); f.setFailWrite(true);
    await assert.rejects(f.replace(),/save uncertain/);
    assert.equal((await f.read()).provenance,'live-only');
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,0);
  } finally { f.cleanup(); }
});

test('aborted runs suppress cues until external input and never invent cancel request timing', async () => {
  const f = fixture(); try {
    await f.emit('session_start',{reason:'startup'}); await f.replace();
    const controller = new AbortController(); f.ctx.signal=controller.signal;
    await f.emit('agent_start'); controller.abort();
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,0);
    await f.emit('message_end',{message:{role:'assistant',stopReason:'aborted'}});
    await f.emit('agent_settled',{aborted:true});
    assert.equal(f.observations.some(event=>event.kind==='cancel_requested'),false);
    delete f.ctx.signal;
    await f.emit('input',{source:'extension'});
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,0);
    await f.emit('input',{source:'interactive'});
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,1);
  } finally { f.cleanup(); }
});

test('trace translation forwards only declared metadata, not model or tool content', async () => {
  const f = fixture(); try {
    await f.emit('session_start',{reason:'startup'});
    await f.emit('message_update',{assistantMessageEvent:{type:'text_delta',delta:'PRIVATE_SENTINEL'}});
    await f.emit('message_update',{assistantMessageEvent:{type:'thinking_delta',delta:''}});
    await f.emit('message_end',{message:{role:'assistant',content:'PRIVATE_SENTINEL',usage:{input:12,output:NaN,cacheRead:3,secret:'PRIVATE_SENTINEL'}}});
    await f.emit('tool_execution_start',{toolCallId:'opaque-tool',toolName:'PRIVATE_SENTINEL',args:{secret:'PRIVATE_SENTINEL'}});
    await f.emit('tool_execution_end',{toolCallId:'opaque-tool',result:'PRIVATE_SENTINEL',isError:true});
    assert.equal(JSON.stringify(f.observations).includes('PRIVATE_SENTINEL'),false);
    assert.equal(f.observations.some(event=>event.kind==='first_reasoning'),false);
    assert.deepEqual(f.observations.find(event=>event.kind==='message_end')!.input!.usage,{input:12,cacheRead:3});
  } finally { f.cleanup(); }
});

test('human-readable JSON escapes bidi controls while typed note data remains unchanged', async () => {
  const f = fixture(); try {
    await f.emit('session_start',{reason:'startup'});
    const note = {...f.note,outcome:'direction\u202econtrol\u061c'};
    const written = await f.replace(note);
    assert.equal(written.details.view.note!.outcome,note.outcome);
    assert.equal(written.content[0]!.text.includes('\u202e'),false);
    assert.equal(written.content[0]!.text.includes('\\u202e'),true);
    await f.command('');
    assert.equal(f.notices.at(-1)!.includes('\u061c'),false);
  } finally { f.cleanup(); }
});

test('trace failure does not prevent registration, user input or checkpoint operation', async () => {
  const f = fixture(true); try {
    await f.emit('session_start',{reason:'startup'});
    await f.replace();
    assert.equal((await f.read()).provenance,'saved');
    assert.equal((await f.emit('input',{source:'interactive'}))!.action,'continue');
    assert.equal(f.notices.some(message=>message.includes('PRIVATE_TRACE_FAILURE')),false);
  } finally { f.cleanup(); }
});
