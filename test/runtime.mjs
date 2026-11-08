// Actual Pi RPC + SDK fixture. The local provider is scripted, not a model.
// Host identity/lifecycle replies are synthetic; production-host compatibility
// requires its own deployment qualification.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [pluginArg, piArg, cliArg] = process.argv.slice(2);
assert(pluginArg && piArg && cliArg, 'Explicit plugin, Pi package and real CLI paths required');
const plugin = resolve(pluginArg), piPackage = resolve(piArg), cli = resolve(cliArg);
const base = await mkdtemp(join(tmpdir(), 'shazam-goals-runtime-'));
const children = new Set(), requests = [], responses = new Set();
let planned, held, providerCalls = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await delay(20); }
  throw new Error(`Timed out: ${label}`);
}
const server = createServer(async (req, res) => {
  responses.add(res); res.on('close', () => responses.delete(res));
  try {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body); providerCalls++;
    const operation = planned; planned = undefined;
    if (operation === 'hold') { held = true; return; }
    if (operation === 'error') { res.writeHead(500); res.end('{"error":{"message":"synthetic failure"}}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = operation ? { role: 'assistant', tool_calls: [{ index: 0, id: `raw-private-call-${providerCalls}`, type: 'function', function: { name: 'task_checkpoint', arguments: JSON.stringify(operation) } }] }
      : { role: 'assistant', content: 'SYNTHETIC_FINAL_CONTENT' };
    const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.write(chunk(delta, null)); res.write(chunk({}, operation ? 'tool_calls' : 'stop')); res.end('data: [DONE]\n\n');
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const host = join(base, 'host.ts');
await writeFile(host, `import {realpathSync} from 'node:fs';
import {dirname,basename,join} from 'node:path';
export default function(pi) {
 let ctx;
 pi.events.on('subagents:identity', ({respond}) => { if(ctx) respond({status:'root',sessionFile:ctx.sessionManager.getSessionFile()}); });
 pi.events.on('session-lifecycle:admission', ({respond}) => { if(ctx) respond({managed:true,status:'owned',sessionFile:join(realpathSync(dirname(ctx.sessionManager.getSessionFile())),basename(ctx.sessionManager.getSessionFile())),generation:'synthetic-owner'}); });
 pi.on('session_start', (_e,c) => {ctx=c;});
}`);
async function environment(name) {
  const home = join(base, name), agent = join(home, '.pi', 'agent'), temp = join(home, 'tmp');
  await mkdir(agent, { recursive: true }); await mkdir(temp);
  await writeFile(join(agent, 'auth.json'), '{}');
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', apiKey: 'synthetic', baseUrl: endpoint, models: [{ id: 'fixture', input: ['text'], contextWindow: 32000, maxTokens: 1000 }] } } }));
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'fixture', defaultThinkingLevel: 'off', defaultTools: ['bash'], retry: { enabled: false }, compaction: { enabled: false }, packages: [plugin], enableAnalytics: false, enableInstallTelemetry: false }));
  return { home, agent, temp };
}
async function launch(env, session, withHost = true) {
  const args = [cli, '--mode', 'rpc', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp', '--session', session];
  if (withHost) args.push('-e', withHost === true ? host : withHost);
  const child = spawn(process.execPath, args, { cwd: env.home, env: { PATH: process.env.PATH, HOME: env.home, TMPDIR: env.temp, PI_CODING_AGENT_DIR: env.agent, LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child); let buffer = '', stderr = '', ended = false; const events = [];
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => { buffer += data; let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); try { events.push(JSON.parse(line)); } catch {} } });
  child.on('exit', () => { ended = true; children.delete(child); });
  const send = data => child.stdin.write(JSON.stringify(data) + '\n');
  let id = 0;
  async function command(type, fields = {}) {
    const requestId = `rpc-${++id}`; send({ id: requestId, type, ...fields });
    return until(() => { assert(!ended, `Pi exited: ${stderr}`); return events.find(e => e.type === 'response' && e.id === requestId); }, type);
  }
  await command('get_state');
  return { child, events, send, command,
    async turn(operation, message = 'ORIGINAL_TASK_SENTINEL: finish the requested fixture task') {
      const start = events.length; planned = operation;
      await command('prompt', { message });
      await until(() => events.slice(start).find(e => e.type === 'agent_end'), `agent_end (${stderr})`);
      await command('get_state');
      return events.slice(start);
    },
    async stop() { child.stdin.end(); await delay(100); if (!ended) child.kill('SIGTERM'); await until(() => ended, 'owned CLI shutdown', 5000); },
  };
}
const note = outcome => ({ schema_version: 1, outcome, source_ref: 'user-message:fixture', origin: 'user_request', next_deliverable: 'PRIVATE_NEXT_DELIVERABLE', decisions: [] });
const saved = async file => (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
const checkpointEntries = entries => entries.filter(e => e.type === 'custom' && e.customType === 'shazam-goals.checkpoint');
function result(events) {
  const tool = events.find(e => e.type === 'tool_execution_end' && e.toolName === 'task_checkpoint');
  assert(tool, 'Actual task_checkpoint execution observed'); assert.equal(tool.isError, false, JSON.stringify(tool));
  return tool.result.details;
}
try {
  const env = await environment('owned'), session = join(env.home, 'session.jsonl');
  let rpc = await launch(env, session);
  const first = result(await rpc.turn({ action: 'replace', expected_revision: null, note: note('PRIVATE_OUTCOME_A') }));
  assert.equal(first.provenance, 'saved'); assert.equal(first.view.note.outcome, 'PRIVATE_OUTCOME_A');
  assert(requests[0].tools.some(t => t.function.name === 'task_checkpoint'), 'Manifest autoload exposes tool');
  const afterWrite = JSON.stringify(requests[1].messages);
  assert(afterWrite.includes('Checkpoint advisory: recorded claims, not authorization.'), 'Actual advisory, distinct from tool result, reaches provider');
  assert(afterWrite.includes('Outcome (recorded user request): PRIVATE_OUTCOME_A'), 'Cue contains saved outcome');
  assert(afterWrite.includes('ORIGINAL_TASK_SENTINEL'), 'Original task survives context transformation');
  assert.equal(result(await rpc.turn({ action: 'read' })).view.revision, first.view.revision);
  const second = result(await rpc.turn({ action: 'replace', expected_revision: first.view.revision, note: note('PRIVATE_OUTCOME_B') }));
  assert.notEqual(second.view.revision, first.view.revision);
  const beforeRestart = checkpointEntries(await saved(session));
  assert.equal(beforeRestart[0].data.note.outcome, 'PRIVATE_OUTCOME_A', 'Earlier snapshot preserved');
  await rpc.stop();
  rpc = await launch(env, session);
  assert.equal(result(await rpc.turn({ action: 'read' })).view.note.outcome, 'PRIVATE_OUTCOME_B', 'Restart restores saved note');
  // Branch selection uses the actual installed SDK, then the actual CLI reads it.
  await rpc.stop();
  const branchFile = join(env.home, 'branch.jsonl'); await copyFile(session, branchFile);
  const { SessionManager } = await import(pathToFileURL(join(piPackage, 'dist/core/session-manager.js')));
  const manager = SessionManager.open(branchFile); manager.branch(first.view.revision); manager.appendCustomEntry('fixture.branch', {});
  rpc = await launch(env, branchFile);
  assert.equal(result(await rpc.turn({ action: 'read' })).view.note.outcome, 'PRIVATE_OUTCOME_A', 'Branch excludes later checkpoint');
  // Exercise the actual RPC confirmation exchange, rejecting a mutation.
  async function pauseControl(id, confirmed) {
    const start = rpc.events.length; rpc.send({ id, type: 'prompt', message: '/checkpoint pause' });
    const confirmation = await until(() => rpc.events.slice(start).find(e => e.type === 'extension_ui_request' && e.method === 'confirm'), 'native control confirmation');
    rpc.send({ type: 'extension_ui_response', id: confirmation.id, confirmed });
    await until(() => rpc.events.find(e => e.type === 'response' && e.id === id), 'control completion');
  }
  await pauseControl('pause-decline', false);
  assert.equal(result(await rpc.turn({ action: 'read' })).view.paused, false, 'Declined control does not mutate');
  await pauseControl('pause-confirm', true);
  const pauseRequest = requests.length;
  const paused = result(await rpc.turn({ action: 'read' }));
  assert.equal(paused.view.paused, true, 'Confirmed control persists pause');
  assert(!JSON.stringify(requests[pauseRequest].messages).includes('Checkpoint advisory:'), 'Paused note does not inject cue');
  assert.equal(result(await rpc.turn({ action: 'replace', expected_revision: paused.view.revision, note: note('PRIVATE_PAUSED_UPDATE') })).view.paused, true, 'Model replacement cannot undo human pause');
  planned = 'hold'; held = false; const cancelStart = rpc.events.length;
  await rpc.command('prompt', { message: 'CANCEL_TASK_SENTINEL' }); await until(() => held, 'provider cancellation barrier');
  await rpc.command('abort'); await until(() => rpc.events.slice(cancelStart).some(e => e.type === 'agent_end'), 'cancel settlement');
  await rpc.turn('error', 'ERROR_TASK_SENTINEL');
  await rpc.stop();
  const unavailable = await environment('unavailable'), unavailableSession = join(unavailable.home, 'session.jsonl');
  rpc = await launch(unavailable, unavailableSession, false);
  const unavailableEvents = await rpc.turn({ action: 'replace', expected_revision: null, note: note('MUST_NOT_SAVE') });
  assert(unavailableEvents.some(e => e.type === 'tool_execution_end' && e.isError), 'Missing host refuses checkpoint');
  assert.equal(checkpointEntries(await saved(unavailableSession)).length, 0);
  assert(unavailableEvents.some(e => e.type === 'message_end' && e.message?.role === 'assistant' && e.message.content.some(c => c.text === 'SYNTHETIC_FINAL_CONTENT')), 'Ordinary task continues without host');
  await rpc.stop();
  const childHost = join(base, 'child-host.ts');
  await writeFile(childHost, (await readFile(host, 'utf8')).replace("status:'root'", "status:'child'"));
  const childEnv = await environment('child'), childSession = join(childEnv.home, 'session.jsonl');
  rpc = await launch(childEnv, childSession, childHost);
  const childRequest = requests.length;
  const childEvents = await rpc.turn({ action: 'replace', expected_revision: null, note: note('CHILD_MUST_NOT_SAVE') });
  assert(childEvents.some(e => e.type === 'tool_execution_end' && e.isError), 'Child identity refuses checkpoint');
  assert.equal(checkpointEntries(await saved(childSession)).length, 0);
  assert(!JSON.stringify(requests[childRequest].messages).includes('Checkpoint advisory:'), 'Child context has no checkpoint advisory');
  await rpc.stop();
  const traces = [];
  for (const e of [env, unavailable, childEnv]) {
    const directory = join(e.agent, 'diagnostics', 'phase-trace');
    for (const file of await readdir(directory)) traces.push(await saved(join(directory, file)));
  }
  assert(traces.length >= 5, 'Each CLI process records trace, including unavailable host');
  for (const records of traces) {
    const text = JSON.stringify(records);
    for (const secret of ['PRIVATE_', 'ORIGINAL_TASK_SENTINEL', 'CANCEL_TASK_SENTINEL', 'ERROR_TASK_SENTINEL', 'SYNTHETIC_FINAL_CONTENT', 'raw-private-call-', base]) assert(!text.includes(secret), `Trace excludes ${secret}`);
    const kinds = records.map(r => r.event);
    assert(kinds.includes('request_start')); assert(kinds.includes('settled'), JSON.stringify(kinds));
    assert.equal(kinds[0], 'header');
    for (let i = 1; i < records.length; i++) {
      assert(records[i].seq > records[i - 1].seq, 'Record sequence increases');
      assert(records[i].elapsed_ms >= records[i - 1].elapsed_ms, 'Elapsed time is monotonic');
    }
    assert(kinds.includes('before_settle'));
    assert(kinds.indexOf('before_settle') < kinds.indexOf('settled'), 'Settlement follows before-settle');
    assert(!records[0].capabilities.includes('cancel_requested'), 'Unobserved cancel timing is not advertised');
    const request = kinds.indexOf('request_start'), provider = kinds.indexOf('first_provider_event');
    assert(provider > request, 'Provider first event follows request start');
  }
  const records = traces.flat();
  assert(records.some(r => r.event === 'tool_start')); assert(records.some(r => r.event === 'tool_end'));
  assert(records.some(r => r.outcome === 'aborted'), 'Cancellation outcome recorded');
  assert(records.some(r => r.outcome === 'error'), 'Provider error outcome recorded');
  console.log(JSON.stringify({ passed: true, node: process.version, pi: JSON.parse(await readFile(join(piPackage, 'package.json'), 'utf8')).version, scriptedProviderRequests: providerCalls, traceProcesses: traces.length, proof: ['manifest autoload', 'native checkpoint save/read', 'provider cue and original task', 'snapshot independence', 'restart', 'SDK branch + CLI restore', 'RPC confirmed/declined control and pause ownership', 'RPC abort', 'provider error', 'missing-host task continuation', 'child suppression', 'content-free traces'], limits: ['Synthetic host admission; production host not qualified', 'No model quality or long-task benchmark', 'No sandbox-level network isolation; fixture credentials and provider are local-only'] }));
} finally {
  for (const child of children) { child.kill('SIGKILL'); }
  for (const response of responses) response.destroy();
  await new Promise(resolve => server.close(resolve));
  await rm(base, { recursive: true, force: true });
}
