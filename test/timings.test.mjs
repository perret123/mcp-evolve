import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendEvent,
  createLogger,
  loadTimings,
  query,
  getTimingsPath,
  newRunId,
  SCHEMA_VERSION,
} from '../lib/timings.mjs';

function makeTmpConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-evolve-timings-'));
  return { dataDir: dir, __cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('appendEvent writes a valid JSONL line and loadTimings reads it back', () => {
  const config = makeTmpConfig();
  try {
    const runId = newRunId();
    appendEvent(config, { run_id: runId, type: 'phase_start', phase: 'prefetch' });
    appendEvent(config, { run_id: runId, type: 'phase_end', phase: 'prefetch', dur_ms: 1234 });

    const path = getTimingsPath(config);
    assert.ok(existsSync(path), 'timings.jsonl should exist');

    const events = loadTimings(config);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'phase_start');
    assert.equal(events[0].run_id, runId);
    assert.equal(events[0].v, SCHEMA_VERSION);
    assert.ok(events[0].ts);
    assert.equal(events[1].dur_ms, 1234);
  } finally {
    config.__cleanup();
  }
});

test('createLogger binds run_id to every emitted event', () => {
  const config = makeTmpConfig();
  try {
    const logger = createLogger(config, 'fixed-run-id');
    logger.phaseStart('seed');
    logger.phaseEnd('seed', 500);
    logger.promptStart({ persona: 'owner', prompt: 'What is X?', prompt_id: 'p1' });
    logger.promptEnd({ persona: 'owner', prompt_id: 'p1', dur_ms: 2000, success: true, errors: 0 });
    logger.runComplete({ total_ms: 10000, prompts: 1, errors: 0, fixes: 0 });

    const events = loadTimings(config);
    assert.equal(events.length, 5);
    for (const e of events) {
      assert.equal(e.run_id, 'fixed-run-id', 'every event should carry the run id');
    }
  } finally {
    config.__cleanup();
  }
});

test('loadTimings skips malformed lines and legacy events without v', () => {
  const config = makeTmpConfig();
  try {
    const path = getTimingsPath(config);
    // Mix of: good, bad JSON, legacy (no v), future version, missing type.
    const lines = [
      JSON.stringify({ v: 1, ts: new Date().toISOString(), run_id: 'r1', type: 'phase_end', phase: 'prefetch', dur_ms: 100 }),
      '{not json at all',
      JSON.stringify({ ts: '2024-01-01T00:00:00Z', phase: 'prefetch', dur_ms: 999 }), // legacy
      JSON.stringify({ v: 99, type: 'phase_end', phase: 'prefetch', dur_ms: 500 }),   // future
      JSON.stringify({ v: 1, run_id: 'r1', phase: 'prefetch' }),                       // missing type
      JSON.stringify({ v: 1, ts: new Date().toISOString(), run_id: 'r1', type: 'phase_end', phase: 'prefetch', dur_ms: 200 }),
      '',
    ];
    // Ensure directory exists via appendEvent side effect, then overwrite.
    appendEvent(config, { run_id: 'init', type: 'phase_start', phase: 'x' });
    writeFileSync(path, lines.join('\n') + '\n');

    const events = loadTimings(config);
    assert.equal(events.length, 2, 'only the two valid v=1 events should load');
    assert.equal(events[0].dur_ms, 100);
    assert.equal(events[1].dur_ms, 200);
  } finally {
    config.__cleanup();
  }
});

test('query.avgPhaseMs averages phase durations (and honours filters)', () => {
  const config = makeTmpConfig();
  try {
    const l = createLogger(config, 'r1');
    l.phaseEnd('prefetch', 1000);
    l.phaseEnd('prefetch', 3000);
    l.phaseEnd('fix_batch', 5000);
    const l2 = createLogger(config, 'r2');
    l2.phaseEnd('prefetch', 2000);

    const events = loadTimings(config);
    assert.equal(query.avgPhaseMs(events, 'prefetch'), 2000);
    assert.equal(query.avgPhaseMs(events, 'fix_batch'), 5000);
    assert.equal(query.avgPhaseMs(events, 'nonexistent'), 0);
    // Filter by run_id
    assert.equal(query.avgPhaseMs(events, 'prefetch', { run_id: 'r2' }), 2000);
    assert.equal(query.avgPhaseMs(events, 'prefetch', { run_id: 'r1' }), 2000);
  } finally {
    config.__cleanup();
  }
});

test('query.avgPromptMs filters by persona', () => {
  const config = makeTmpConfig();
  try {
    const l = createLogger(config, 'r1');
    l.promptEnd({ persona: 'owner', prompt_id: 'a', dur_ms: 1000, success: true, errors: 0 });
    l.promptEnd({ persona: 'owner', prompt_id: 'b', dur_ms: 3000, success: true, errors: 0 });
    l.promptEnd({ persona: 'guest', prompt_id: 'c', dur_ms: 500, success: true, errors: 0 });

    const events = loadTimings(config);
    assert.equal(query.avgPromptMs(events, { persona: 'owner' }), 2000);
    assert.equal(query.avgPromptMs(events, { persona: 'guest' }), 500);
    assert.equal(query.avgPromptMs(events), 1500);
  } finally {
    config.__cleanup();
  }
});

test('query.lastRunDurations returns the last N run_complete events, most recent first', () => {
  const config = makeTmpConfig();
  try {
    for (let i = 0; i < 5; i++) {
      const l = createLogger(config, `run-${i}`);
      l.runComplete({ total_ms: (i + 1) * 1000, prompts: 10, errors: 0, fixes: 0 });
    }
    const events = loadTimings(config);
    const durs = query.lastRunDurations(events, 3);
    assert.deepEqual(durs, [5000, 4000, 3000]);

    const allDurs = query.lastRunDurations(events, 100);
    assert.equal(allDurs.length, 5);
    assert.equal(allDurs[0], 5000);
  } finally {
    config.__cleanup();
  }
});

test('query.toolStats aggregates from tool_call and prompt_end.tools_used', () => {
  const config = makeTmpConfig();
  try {
    const l = createLogger(config, 'r1');
    l.toolCall({ tool: 'list_businesses', dur_ms: 100 });
    l.toolCall({ tool: 'list_businesses', dur_ms: 200 });
    l.toolCall({ tool: 'get_orders', dur_ms: 50 });
    l.promptEnd({
      persona: 'owner', prompt_id: 'a', dur_ms: 1000, success: true, errors: 0,
      tools_used: ['list_businesses', 'get_menu_data'],
    });

    const events = loadTimings(config);
    const stats = query.toolStats(events);

    const byName = Object.fromEntries(stats.map(s => [s.tool, s]));
    assert.equal(byName.list_businesses.count, 3);
    assert.equal(byName.list_businesses.totalMs, 300);
    assert.equal(byName.get_orders.count, 1);
    assert.equal(byName.get_menu_data.count, 1);
  } finally {
    config.__cleanup();
  }
});

test('query.slowestPrompts returns top N prompts by duration', () => {
  const config = makeTmpConfig();
  try {
    const l = createLogger(config, 'r1');
    l.promptEnd({ persona: 'owner', prompt: 'A', prompt_id: 'a', dur_ms: 3000, success: true, errors: 0 });
    l.promptEnd({ persona: 'owner', prompt: 'B', prompt_id: 'b', dur_ms: 1000, success: true, errors: 0 });
    l.promptEnd({ persona: 'guest', prompt: 'C', prompt_id: 'c', dur_ms: 5000, success: true, errors: 0 });
    l.promptEnd({ persona: 'guest', prompt: 'D', prompt_id: 'd', dur_ms: 2000, success: true, errors: 0 });

    const events = loadTimings(config);
    const slow = query.slowestPrompts(events, 2);
    assert.equal(slow.length, 2);
    assert.equal(slow[0].dur_ms, 5000);
    assert.equal(slow[0].prompt, 'C');
    assert.equal(slow[1].dur_ms, 3000);
  } finally {
    config.__cleanup();
  }
});

test('query.phaseBreakdown groups by phase and sorts by total time', () => {
  const config = makeTmpConfig();
  try {
    const l = createLogger(config, 'r1');
    l.phaseEnd('prefetch', 1000);
    l.phaseEnd('prefetch', 2000);
    l.phaseEnd('fix_batch', 10000);
    l.phaseEnd('replay', 3000);

    const events = loadTimings(config);
    const breakdown = query.phaseBreakdown(events);
    assert.equal(breakdown[0].phase, 'fix_batch');
    assert.equal(breakdown[0].totalMs, 10000);
    assert.equal(breakdown[0].count, 1);
    assert.equal(breakdown[0].avgMs, 10000);

    const prefetch = breakdown.find(p => p.phase === 'prefetch');
    assert.equal(prefetch.count, 2);
    assert.equal(prefetch.totalMs, 3000);
    assert.equal(prefetch.avgMs, 1500);
  } finally {
    config.__cleanup();
  }
});

test('query.eventsForRun isolates a specific run id', () => {
  const config = makeTmpConfig();
  try {
    const a = createLogger(config, 'ra');
    const b = createLogger(config, 'rb');
    a.phaseStart('x');
    b.phaseStart('y');
    a.phaseEnd('x', 10);
    b.phaseEnd('y', 20);

    const events = loadTimings(config);
    const forA = query.eventsForRun(events, 'ra');
    assert.equal(forA.length, 2);
    for (const e of forA) assert.equal(e.run_id, 'ra');
  } finally {
    config.__cleanup();
  }
});

test('query.avgPhaseMs handles empty events safely', () => {
  assert.equal(query.avgPhaseMs([], 'prefetch'), 0);
  assert.equal(query.avgPromptMs([]), 0);
  assert.deepEqual(query.lastRunDurations([]), []);
  assert.deepEqual(query.toolStats([]), []);
  assert.deepEqual(query.slowestPrompts([]), []);
});

test('progress.mjs emits events to timings.jsonl via createProgress -> setPhase -> completePrompt -> completeRun', async () => {
  const { createProgress, setPhase, startPrompt, completePrompt, completeRun } =
    await import('../lib/progress.mjs');

  const config = makeTmpConfig();
  try {
    const prog = createProgress(config, {
      totalPrompts: 2,
      personaCount: 1,
      currentRun: 1,
      totalRuns: 1,
    });

    setPhase(prog, 'prefetch');
    // Simulate some time passing
    await new Promise(r => setTimeout(r, 10));
    setPhase(prog, 'prompts_run');

    startPrompt(prog, 'first prompt', { persona: 'owner' });
    await new Promise(r => setTimeout(r, 10));
    completePrompt(prog, { success: true, errors: 0, toolCount: 2, toolsUsed: ['tool_a', 'tool_b'] });

    startPrompt(prog, 'second prompt', { persona: 'guest' });
    await new Promise(r => setTimeout(r, 10));
    completePrompt(prog, { success: false, errors: 1, toolCount: 1, toolsUsed: ['tool_a'] });

    completeRun(prog);

    const events = loadTimings(config);
    const types = events.map(e => e.type);

    assert.ok(types.includes('run_start'));
    assert.ok(types.includes('phase_start'));
    assert.ok(types.includes('phase_end'));
    assert.ok(types.includes('prompt_start'));
    assert.ok(types.includes('prompt_end'));
    assert.ok(types.includes('run_complete'));

    // Run id consistency
    const runIds = new Set(events.map(e => e.run_id));
    assert.equal(runIds.size, 1, 'all events should share a single run id');

    // run_complete should have sensible totals
    const runComplete = events.find(e => e.type === 'run_complete');
    assert.ok(runComplete.total_ms >= 0);
    assert.equal(runComplete.prompts, 2);
    assert.equal(runComplete.errors, 1);

    // prompt_end events should have persona info
    const promptEnds = events.filter(e => e.type === 'prompt_end');
    assert.equal(promptEnds.length, 2);
    assert.equal(promptEnds[0].persona, 'owner');
    assert.equal(promptEnds[1].persona, 'guest');
    assert.deepEqual(promptEnds[0].tools_used, ['tool_a', 'tool_b']);
  } finally {
    config.__cleanup();
  }
});

test('loadTimings.sinceMs filters out old events', () => {
  const config = makeTmpConfig();
  try {
    const path = getTimingsPath(config);
    appendEvent(config, { run_id: 'seed', type: 'phase_start', phase: 'x' });
    // Manually write an ancient event (1 year ago)
    const ancient = JSON.stringify({
      v: 1,
      ts: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      run_id: 'old',
      type: 'phase_end',
      phase: 'prefetch',
      dur_ms: 9999,
    });
    const existing = readFileSync(path, 'utf-8');
    writeFileSync(path, existing + ancient + '\n');

    const recent = loadTimings(config, { sinceMs: 60 * 1000 });
    assert.ok(recent.every(e => e.run_id !== 'old'));
    assert.ok(recent.length >= 1);

    const all = loadTimings(config);
    assert.ok(all.some(e => e.run_id === 'old'));
  } finally {
    config.__cleanup();
  }
});
