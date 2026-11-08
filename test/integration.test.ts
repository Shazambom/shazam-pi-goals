import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../src/index.ts';
import { verifySaved } from '../src/checkpoint.ts';

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

function fixture(failTrace = false, verifyHistory?: typeof verifySaved) {
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
  let closes = 0;
  const trace: TraceRecorder = {
    beginSession() {}, event(kind, input) { observations.push({kind, input}); },
    async summary() { return 'Synthetic trace summary'; }, async close() { closes++; },
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
  registerGoals(pi, () => { if (failTrace) throw new Error('PRIVATE_TRACE_FAILURE'); return trace; }, verifyHistory);
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
    confirmations:()=>confirmations, closes:()=>closes, cleanup:()=>rmSync(root,{recursive:true,force:true}),
  };
}

test('canonical host identity admits a session opened through a symlink', async () => {
  const f = fixture(); try {
    const alias = join(f.root, 'alias'); symlinkSync(f.root, alias, 'dir');
    f.ctx.sessionManager.getSessionFile = () => join(alias, 'session.jsonl');
    await f.emit('session_start', {reason:'startup'});
    assert.equal((await f.replace()).details.provenance, 'saved');
  } finally { f.cleanup(); }
});

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

test('failed provider attempts retain the cue for retry without rearming successful requests', async () => {
  const f = fixture(); try {
    await f.emit('session_start'); await f.replace();
    await f.emit('before_provider_request');
    await f.emit('message_end', {message:{role:'assistant',stopReason:'error'}});
    assert.equal((await f.emit('context', {messages:[]}))!.messages!.length, 1);
    await f.emit('before_provider_request');
    await f.emit('message_end', {message:{role:'assistant',stopReason:'stop'}});
    assert.equal((await f.emit('context', {messages:[]}))!.messages!.length, 0);
    await f.emit('before_provider_request');
    await f.emit('message_end', {message:{role:'assistant',stopReason:'error'}});
    assert.equal((await f.emit('context', {messages:[]}))!.messages!.length, 0, 'later errors must not revive an already delivered cue');
  } finally { f.cleanup(); }
});

test('every session runtime teardown closes its recorder', async () => {
  for (const reason of ['new','resume','fork','quit','reload']) {
    const f = fixture(); try {
      await f.emit('session_start'); await f.emit('session_shutdown', {reason});
      assert.equal(f.closes(), 1, reason);
    } finally { f.cleanup(); }
  }
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}
function verificationGate() {
  type Gate = { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> };
  let next: Gate | undefined;
  const verify: typeof verifySaved = async (...args) => {
    const gate = next; next = undefined;
    const checked = verifySaved(...args);
    if (gate) { gate.entered.resolve(); await gate.release.promise; }
    return checked;
  };
  return {
    verify,
    holdNext() {
      assert.equal(next, undefined);
      next = {entered:deferred<void>(),release:deferred<void>()};
      return next;
    },
  };
}

test('competing expected-revision mutations serialize across asynchronous verification', async () => {
  const gate = verificationGate(), f = fixture(false, gate.verify);
  try {
    await f.emit('session_start');
    const hold = gate.holdNext();
    const first = f.call({action:'replace',expected_revision:null,note:{...f.note,outcome:'First'}});
    await hold.entered.promise;
    const second = assert.rejects(f.call({action:'replace',expected_revision:null,note:{...f.note,outcome:'Second'}}), /revision/i);
    hold.release.resolve();
    assert.equal((await first).details.view.note!.outcome,'First');
    await second;
    assert.equal(f.entries.filter(entry=>entry.customType===CHECKPOINT_ENTRY).length,1);
    assert.equal((await f.read()).view.note!.outcome,'First');
  } finally { f.cleanup(); }
});

test('owner change while verification is pending cannot publish a saved cue or write', async () => {
  const gate = verificationGate(), f = fixture(false, gate.verify);
  try {
    await f.emit('session_start'); await f.replace();
    const before = f.entries.length;
    const hold = gate.holdNext();
    const writing = assert.rejects(f.call({action:'replace',expected_revision:f.entries.at(-1)!.id,note:{...f.note,outcome:'Stale'}}), /changed/);
    await hold.entered.promise;
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,0);
    f.setGeneration('next-owner'); hold.release.resolve();
    await writing;
    assert.equal(f.entries.length,before);
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,0);
  } finally { f.cleanup(); }
});

test('branch changes during verification refuse the stale replacement', async () => {
  const gate = verificationGate(), f = fixture(false, gate.verify);
  try {
    await f.emit('session_start'); await f.replace();
    const revision = (await f.read()).view.revision;
    const hold = gate.holdNext();
    const writing = assert.rejects(f.call({action:'replace',expected_revision:revision,note:{...f.note,outcome:'Stale'}}), /changed/);
    await hold.entered.promise;
    f.pi.appendEntry(CHECKPOINT_ENTRY,{version:1,action:'replace',note:{...f.note,outcome:'External branch change'}});
    hold.release.resolve(); await writing;
    assert.equal((await f.read()).view.note!.outcome,'External branch change');
    assert.equal(f.entries.filter(entry=>entry.customType===CHECKPOINT_ENTRY).length,2);
  } finally { f.cleanup(); }
});

test('cancellation during verification prevents mutation but fresh idle controls still work', async () => {
  const gate = verificationGate(), f = fixture(false, gate.verify);
  try {
    await f.emit('session_start'); await f.replace();
    const before = f.entries.length, revision = (await f.read()).view.revision;
    const hold = gate.holdNext(), controller = new AbortController();
    const writing = assert.rejects(f.call({action:'replace',expected_revision:revision,note:{...f.note,outcome:'Cancelled'}},controller.signal), /changed/);
    await hold.entered.promise;
    controller.abort(); hold.release.resolve(); await writing;
    assert.equal(f.entries.length,before);
    await f.emit('agent_settled',{aborted:true});
    await f.command('');
    assert(f.notices.at(-1)!.includes('Deliver artifact'));
    await f.command('pause'); assert.equal((await f.read()).view.paused,true);
    await f.command('resume'); assert.equal((await f.read()).view.paused,false);
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,0,'controls do not resume aborted work');
  } finally { f.cleanup(); }
});

test('native UI confirmation does not hold the checkpoint operation queue', {timeout:2000}, async () => {
  const f = fixture();
  try {
    await f.emit('session_start'); await f.replace();
    const entered = deferred<void>(), confirmation = deferred<boolean>();
    f.ctx.ui.confirm = async () => { entered.resolve(); return confirmation.promise; };
    const pausing = f.command('pause'); await entered.promise;
    await f.replace({...f.note,outcome:'Updated while confirming'});
    confirmation.resolve(true); await pausing;
    const current = await f.read();
    assert.equal(current.view.note!.outcome,'Updated while confirming');
    assert.equal(current.view.paused,true);
  } finally { f.cleanup(); }
});

test('cancellation after append refuses saved success and later read recovers the written note', async () => {
  const gate = verificationGate(), f = fixture(false, gate.verify);
  try {
    await f.emit('session_start');
    const beforeWrite = gate.holdNext(), controller = new AbortController();
    const writing = assert.rejects(f.call({action:'replace',expected_revision:null,note:f.note},controller.signal), /changed/);
    await beforeWrite.entered.promise;
    const afterWrite = gate.holdNext();
    beforeWrite.release.resolve(); await afterWrite.entered.promise;
    assert.equal(f.entries.length,1,'append happened before cancellation');
    controller.abort(); afterWrite.release.resolve(); await writing;
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,0);
    const recovered = await f.read();
    assert.equal(recovered.provenance,'saved');
    assert.equal(recovered.view.note!.outcome,f.note.outcome);
  } finally { f.cleanup(); }
});

test('new input invalidates pending refresh before rearming its own current cue', async () => {
  const gate = verificationGate(), f = fixture(false, gate.verify);
  try {
    await f.emit('session_start'); await f.replace();
    const hold = gate.holdNext();
    const oldRead = assert.rejects(f.read(), /changed/);
    await hold.entered.promise;
    const input = f.emit('input',{source:'interactive'});
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,0);
    hold.release.resolve(); await oldRead;
    assert.equal((await input)!.action,'continue');
    assert.equal((await f.emit('context',{messages:[]}))!.messages!.length,1);
  } finally { f.cleanup(); }
});
