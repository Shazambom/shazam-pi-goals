import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECKPOINT_ENTRY, type BranchEntry, type Note } from '../src/contracts.ts';
import { control, renderCue, replacement, restoreCheckpoint } from '../src/checkpoint.ts';

function note(outcome = 'Ship the accepted change'): Note {
  return { schema_version: 1, outcome, source_ref: 'user-entry-1', origin: 'user_request',
    next_deliverable: 'Report verified results', decisions: [
      { statement: 'Use the existing adapter', source_ref: 'user-entry-2', provenance: 'accepted' },
    ] };
}
function entry(id: string, data: unknown): BranchEntry {
  return { id, type: 'custom', customType: CHECKPOINT_ENTRY, data };
}

test('current branch recovers its note and decisions without sibling state', () => {
  const empty = restoreCheckpoint([]);
  const a = entry('a', replacement(empty, null, note('Goal A')));
  const b = entry('b', replacement(restoreCheckpoint([a]), 'a', note('Goal B')));
  assert.equal(restoreCheckpoint([a, b]).note?.outcome, 'Goal B');
  const restored = restoreCheckpoint([a]);
  assert.equal(restored.note?.outcome, 'Goal A');
  assert.equal(restored.revision, 'a');
  assert.match(renderCue(restored)!, /Goal A/);
  assert.doesNotMatch(renderCue(restored)!, /Goal B/);
});

test('human pause survives replacement and clear until explicit resume', () => {
  const history = [entry('a', replacement(restoreCheckpoint([]), null, note())), entry('p', control('pause'))];
  const paused = restoreCheckpoint(history);
  assert.equal(paused.paused, true);
  history.push(entry('b', replacement(paused, 'p', note('Updated task'))));
  assert.equal(renderCue(restoreCheckpoint(history)), null);
  history.push(entry('c', control('clear')));
  assert.deepEqual(restoreCheckpoint(history), { revision: 'c', paused: true, note: null });
  history.push(entry('d', replacement(restoreCheckpoint(history), 'c', note())));
  assert.equal(renderCue(restoreCheckpoint(history)), null);
  history.push(entry('r', control('resume')));
  assert.notEqual(renderCue(restoreCheckpoint(history)), null);
});

test('snapshots detach input, restored state and nested decisions', () => {
  const input = note();
  const event = replacement(restoreCheckpoint([]), null, input);
  input.decisions[0]!.statement = 'MUTATED INPUT';
  input.outcome = 'MUTATED INPUT';
  const history = [entry('a', event)];
  const first = restoreCheckpoint(history);
  first.note!.decisions[0]!.statement = 'MUTATED VIEW';
  first.note!.outcome = 'MUTATED VIEW';
  const second = restoreCheckpoint(history);
  assert.equal(second.note!.outcome, 'Ship the accepted change');
  assert.equal(second.note!.decisions[0]!.statement, 'Use the existing adapter');
});

test('revision conflicts and invalid notes do not mutate state or expose data', () => {
  const view = restoreCheckpoint([entry('a', { version: 1, action: 'replace', note: note() })]);
  const before = structuredClone(view);
  assert.throws(() => replacement(view, null, note()), /revision/i);
  const invalid = { ...note(), secret: 'SENSITIVE_SENTINEL' };
  assert.throws(() => replacement(view, 'a', invalid), error => error instanceof Error
    && !error.message.includes('SENSITIVE_SENTINEL') && /invalid/i.test(error.message));
  assert.deepEqual(view, before);
});

test('unknown, malformed and unrelated history never supersedes valid state', () => {
  const valid = entry('a', { version: 1, action: 'replace', note: note() });
  const malformed = [
    entry('b', { version: 2, action: 'clear' }),
    entry('c', { version: 1, action: 'resume', extra: true }),
    entry('d', { version: 1, action: 'replace', note: { ...note(), schema_version: 2 } }),
    { ...entry('e', control('clear')), type: 'message' },
    { ...entry('f', control('clear')), customType: 'another-extension' },
    entry('', control('clear')),
    entry('g', null),
  ];
  assert.deepEqual(restoreCheckpoint([valid, ...malformed]), restoreCheckpoint([valid]));
});

test('rejects extra fields, inherited values, non-JSON data and accessors without invoking them', () => {
  let invoked = 0;
  const accessor = { ...note() };
  Object.defineProperty(accessor, 'outcome', { enumerable: true, get() { invoked++; return 'bad'; } });
  const inherited = Object.create(note()) as Note;
  const customPrototype = Object.assign(Object.create({ extra: 'bad' }), note()) as Note;
  const cycle: Record<string, unknown> = { ...note() };
  cycle.blocker = cycle;
  for (const input of [accessor, inherited, customPrototype, cycle, new Date(),
    { ...note(), decisions: [{ ...note().decisions[0], extra: true }] },
    { ...note(), blocker: undefined }, { ...note(), outcome: 1 },
    { ...note(), toJSON() { invoked++; return note(); } }]) {
    assert.throws(() => replacement(restoreCheckpoint([]), null, input), /invalid/i);
  }
  assert.equal(invoked, 0);
});

test('encoded size is measured in UTF-8 bytes and malformed oversized history is ignored', () => {
  const large = { ...note(), outcome: '😀'.repeat(2200) };
  assert.throws(() => replacement(restoreCheckpoint([]), null, large), /invalid/i);
  assert.equal(restoreCheckpoint([entry('a', { version: 1, action: 'replace', note: large })]).note, null);
  const within = { ...note(), outcome: '😀'.repeat(1200) };
  assert.doesNotThrow(() => replacement(restoreCheckpoint([]), null, within));
});

test('cue has explicit provenance, priorities and escaped control/bidi characters', () => {
  const characters = '\u0000\n\t\u007f\u0085\u061c\u200e\u200f\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';
  const data = { ...note(), outcome: `Safe café ${characters}`, origin: 'agent_interpretation' as const };
  const cue = renderCue(restoreCheckpoint([entry('a', { version: 1, action: 'replace', note: data })]))!;
  assert.match(cue, /agent interpretation/);
  assert.match(cue, /Newer user instructions/);
  assert.match(cue, /recorded accepted/);
  assert.match(cue, /café/);
  for (const value of characters) if (value !== '\n') assert(!cue.includes(value));
  assert(cue.includes('\\u061c'));
  assert(cue.includes('\\u202e'));
});

test('cue stays within Unicode limit and declares truncated or omitted fields', () => {
  const data = { ...note(), next_deliverable: '🚀'.repeat(1400), blocker: 'A blocker',
    decisions: Array.from({ length: 8 }, (_, i) => ({ statement: `Decision ${i}`, source_ref: `source-${i}`, provenance: 'accepted' as const })) };
  const cue = renderCue(restoreCheckpoint([entry('a', { version: 1, action: 'replace', note: data })]))!;
  assert(Array.from(cue).length <= 1200);
  assert.match(cue, /omitted|truncated/i);
  assert.match(cue, /task_checkpoint/);
  assert(!cue.includes('\ufffd'));
});

test('absent, paused and completed notes do not produce active cues', () => {
  assert.equal(renderCue(restoreCheckpoint([])), null);
  const completed = { ...note(), next_deliverable: null };
  assert.equal(renderCue(restoreCheckpoint([entry('a', { version: 1, action: 'replace', note: completed })])), null);
  assert.throws(() => control('replace' as 'pause'), /invalid/i);
});
