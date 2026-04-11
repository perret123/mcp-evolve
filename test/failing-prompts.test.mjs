import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadFailingPrompts,
  saveFailingPrompts,
  addFailingEntry,
  getFailingForPersona,
  getFailingPatterns,
  clearAllFailing,
  removeFailing,
  normalizeErrorText,
} from '../lib/failing-prompts.mjs';

function makeCfg() {
  const dir = mkdtempSync(join(tmpdir(), 'failing-'));
  return { failingPromptsPath: join(dir, 'failing-prompts.json'), _dir: dir };
}

test('loadFailingPrompts returns empty store when file missing', () => {
  const cfg = makeCfg();
  try {
    const store = loadFailingPrompts(cfg);
    assert.equal(store.version, 1);
    assert.deepEqual(store.entries, []);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('addFailingEntry persists a prompt entry with id and timestamp', () => {
  const cfg = makeCfg();
  try {
    const entry = addFailingEntry(cfg, {
      kind: 'prompt',
      reason: 'fabrication_trigger',
      persona: 'waiter-orders',
      prompt: 'seat a walk-in at Tisch 5',
      triggeringError: {
        tool: 'mcp__pubman__manage_guest',
        errorTextKey: 'already occupied',
        fullError: '⛔ Table 5 is already occupied',
      },
      rejectedInRun: '2026-04-11T18:00:00Z',
    });
    assert.match(entry.id, /^fp-[a-f0-9-]+$/);
    assert.ok(entry.markedAt);
    assert.equal(entry.rejectedByReviewer, true);

    const store = loadFailingPrompts(cfg);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].id, entry.id);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('getFailingForPersona returns only matching persona entries', () => {
  const cfg = makeCfg();
  try {
    addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p1' });
    addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'b', prompt: 'p2' });
    addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p3' });
    const aEntries = getFailingForPersona(cfg, 'a');
    assert.equal(aEntries.length, 2);
    assert.deepEqual(aEntries.map(e => e.prompt).sort(), ['p1', 'p3']);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('getFailingPatterns returns only pattern-kind entries', () => {
  const cfg = makeCfg();
  try {
    addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p1' });
    addFailingEntry(cfg, { kind: 'pattern', reason: 'reviewer_discretion', patternRegex: 'already occupied', triggeringError: { tool: 'mcp__x__seat', errorTextKey: 'already occupied' } });
    const patterns = getFailingPatterns(cfg);
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0].kind, 'pattern');
    assert.equal(patterns[0].patternRegex, 'already occupied');
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('removeFailing deletes one entry by id', () => {
  const cfg = makeCfg();
  try {
    const e1 = addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p1' });
    const e2 = addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p2' });
    removeFailing(cfg, e1.id);
    const store = loadFailingPrompts(cfg);
    assert.equal(store.entries.length, 1);
    assert.equal(store.entries[0].id, e2.id);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('clearAllFailing empties the store', () => {
  const cfg = makeCfg();
  try {
    addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p1' });
    addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'b', prompt: 'p2' });
    clearAllFailing(cfg);
    const store = loadFailingPrompts(cfg);
    assert.deepEqual(store.entries, []);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('normalizeErrorText lowercases and strips volatile ids', () => {
  const raw = 'Order ID abc-123-XYZ is already occupied (2 guests seated)';
  const key = normalizeErrorText(raw);
  assert.equal(key.includes('abc-123-xyz'), false);
  assert.match(key, /already occupied/);
});

test('saveFailingPrompts is idempotent and preserves version', () => {
  const cfg = makeCfg();
  try {
    const store = { version: 1, entries: [{ id: 'fp-1', kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p', markedAt: '2026-04-11T00:00:00Z' }] };
    saveFailingPrompts(cfg, store);
    saveFailingPrompts(cfg, store);
    const loaded = loadFailingPrompts(cfg);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.entries.length, 1);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});
