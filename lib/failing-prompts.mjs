/**
 * mcp-evolve — Failing prompts store.
 *
 * Persists prompts and error-patterns that the reviewer has deemed
 * unfixable (fabrication triggers, contaminated invariants, adversarial
 * misfires, etc.). Fed back into the generator as anti-examples and
 * into the model-error fixer as a pre-filter.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = 1;

function emptyStore() {
  return { version: VERSION, entries: [] };
}

export function loadFailingPrompts(config) {
  try {
    const raw = JSON.parse(readFileSync(config.failingPromptsPath, 'utf-8'));
    if (!raw.entries) raw.entries = [];
    if (!raw.version) raw.version = VERSION;
    return raw;
  } catch {
    return emptyStore();
  }
}

export function saveFailingPrompts(config, store) {
  const dir = dirname(config.failingPromptsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(config.failingPromptsPath, JSON.stringify(store, null, 2) + '\n');
}

/**
 * Add a failing entry. Accepts a partial entry; fills in id, markedAt,
 * rejectedByReviewer, and any missing required fields with sensible defaults.
 * Returns the persisted entry.
 */
export function addFailingEntry(config, partial) {
  const store = loadFailingPrompts(config);
  const entry = {
    id: `fp-${randomUUID()}`,
    kind: partial.kind || 'prompt',
    reason: partial.reason || 'reviewer_discretion',
    persona: partial.persona ?? null,
    prompt: partial.prompt ?? null,
    triggeringError: partial.triggeringError ?? null,
    contextInvariant: partial.contextInvariant ?? null,
    patternRegex: partial.patternRegex ?? null,
    rejectedInRun: partial.rejectedInRun ?? null,
    rejectedByReviewer: true,
    markedAt: new Date().toISOString(),
  };
  store.entries.push(entry);
  saveFailingPrompts(config, store);
  return entry;
}

export function getFailingForPersona(config, personaId) {
  const store = loadFailingPrompts(config);
  return store.entries.filter(e => e.kind === 'prompt' && e.persona === personaId);
}

export function getFailingPatterns(config) {
  const store = loadFailingPrompts(config);
  return store.entries.filter(e => e.kind === 'pattern');
}

export function clearAllFailing(config) {
  saveFailingPrompts(config, emptyStore());
}

export function removeFailing(config, id) {
  const store = loadFailingPrompts(config);
  store.entries = store.entries.filter(e => e.id !== id);
  saveFailingPrompts(config, store);
}

/**
 * Normalize an error text into a signature suitable for matching.
 * Lowercases, collapses whitespace, and strips common volatile tokens
 * (UUIDs, hyphenated IDs, long digit sequences).
 */
export function normalizeErrorText(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[a-f0-9]{8}-[a-f0-9-]{4,}/g, '')        // UUID-like
    // Dash-separated ID tokens: require at least one digit somewhere so domain
    // vocabulary like "walk-in", "fast-book", "end-of-day" survives intact.
    .replace(/\b(?=[a-z0-9-]*\d)[a-z0-9]{2,}(?:-[a-z0-9]+){1,}\b/gi, '')
    .replace(/\b\d{4,}\b/g, '')                         // long digit runs
    .replace(/\s+/g, ' ')
    .trim();
}
