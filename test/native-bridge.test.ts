import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTrace } from '../src/trace.ts';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('native trace bridge retains missing tool IDs as unknown correlation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shazam-native-bridge-'));
  try {
    const trace = createTrace(directory);
    trace.beginSession();
    trace.event('run_start');
    trace.event('request_start');
    trace.event('tool_start', { toolCallId: undefined });
    trace.event('tool_end', { toolCallId: undefined, outcome: 'ok' });
    await trace.close();
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const content = await readFile(join(directory, files[0]!), 'utf8');
    assert(!content.includes('PRIVATE_SESSION'));
    const records = content.trim().split('\n').map(line => JSON.parse(line));
    for (const event of ['tool_start', 'tool_end']) {
      const record = records.find(record => record.event === event);
      assert(record, `${event} crosses TypeScript/NAPI/Rust boundary`);
      assert.equal(record.gap, 'unknown_correlation');
      assert.equal(record.tool, undefined);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('saved-history verification leaves Node responsive while filesystem IO waits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shazam-native-io-'));
  try {
    const fifo = join(directory, 'session.jsonl');
    execFileSync('mkfifo', [fifo]);
    const addon = fileURLToPath(new URL('../native/index.node', import.meta.url));
    const program = `
      const {open} = require('node:fs/promises');
      const native = require(process.argv[1]);
      const file = process.argv[2];
      setTimeout(() => open(file, 'w').then(handle => handle.close()), 20);
      native.checkpointVerifySaved(file, 'fixture', '[]').then(saved => {
        if (saved) process.exitCode = 1;
        else process.stdout.write('responsive');
      });
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', program, addon, fifo], { timeout: 5000 });
    assert.equal(stdout, 'responsive');
  } finally { await rm(directory, {recursive:true,force:true}); }
});
