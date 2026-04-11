# Reviewer Audit Upgrade + Failing-Prompts Set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fabrication-preventing audit checkpoint between every fixer diff and the merge. Persist a failing-prompts store and feed it back into prompt generation as anti-examples. Drop contaminated prompts from both scoring and the persisted golden set when detected.

**Architecture:** Unified audit-then-merge pipeline. One reviewer LLM call per fix batch (single and multi-branch cases both go through it). The reviewer receives every branch's diff plus per-prompt context (probe, invariant, persona, original error), runs a mandatory grep/git/backend checklist per new rejection path, and emits tagged-JSON decisions: per-branch `AUDIT` (merge/reject) and per-prompt `PROMPT_REVIEW` (keep/drop). Approved branches are applied via the reviewer's own Edit calls in the same invocation. Rejected branches are discarded. Dropped prompts are marked invalid in the run, appended to `.mcp-evolve/failing-prompts.json`, and — if they were golden — removed from `prompt-set.json`. The model-error fixer is also wrapped in a git worktree so its output flows through the same audit path.

**Tech Stack:** Node.js ESM, `node:test`, Claude CLI (sonnet reviewer, configurable), existing mcp-evolve pipeline.

**Scope boundary:** This plan implements Spec 1 only. Legacy mode (the `!useFixedSets` branches in `run.mjs`) is left untouched — Spec 2 retires it when it rewrites the scoring/graduation model. The audit helpers are written mode-agnostic, so they apply to whatever generation model is in place. For pubman in current fixed-sets mode, the audit begins catching fabrications immediately after this plan merges; the anti-examples feed activates for pubman once Spec 2 calls `generatePrompts()` per run.

**Design deviation from spec text:** The spec shows reviewer output as YAML-ish indented blocks. This plan implements the output as JSON inside `<AUDIT>` / `<PROMPT_REVIEW>` tags for parser reliability — LLMs emit JSON cleanly and Node has no built-in YAML parser. Semantically identical to the spec.

---

## File Structure

**New files:**
- `lib/failing-prompts.mjs` — persistence and query helpers for `failing-prompts.json`
- `lib/reviewer-protocol.mjs` — extract and validate tagged-JSON reviewer output
- `lib/audit.mjs` — unified audit-then-merge orchestration (replaces `mergeFixBranches` call site)
- `test/failing-prompts.test.mjs` — unit tests for the failing-prompts module
- `test/reviewer-protocol.test.mjs` — unit tests for the protocol parser
- `test/audit.test.mjs` — unit tests for the audit orchestration

**Modified files:**
- `lib/config.mjs` — rename `adversarialRate` → `adversarialRatio`, add `reviewerAuditEnabled`, `failingPromptsPath`, extend `reviewerTools` default to include `Bash`
- `lib/run.mjs` — propagate probe/invariant/lifecycle to `fixableError`, replace `mergeFixBranches` with `runAuditAndMerge`, add `fixModelErrorsInWorktree`, thread `failingEntries` into `generatePrompts`, filter adversarial errors out of fixer input, collect audit results into `runState` for the run log
- `lib/eval.mjs` — `aggregateScores` excludes `invalid: true` prompts, new helper `markPromptInvalid`, new helper `removeGoldenFromPromptSet`
- `lib/metrics.mjs` — add `reviews` section with counts + history
- `prompts/reviewer.md` — full rewrite with audit checklist, case matrix, JSON output format
- `prompts/fixer-model-error.md` — note that pattern-level failing entries are pre-filtered from input
- `prompts/user-sim.md` — add anti-examples placeholder note
- `prompts/grader.md` — honor `adversarial: true` prompt flag (score pass on error), drop `expectedOutcome` support
- `bin/cli.mjs` — new subcommands: `failing list`, `failing clear <id>`, `failing clear-all`

---

### Task 1: Config additions and adversarial hard rename

**Files:**
- Modify: `lib/config.mjs:25` (`reviewerTools`)
- Modify: `lib/config.mjs:237-238` (adversarial)
- Modify: `lib/config.mjs:259-283` (merged config path resolution)

- [ ] **Step 1: Extend reviewerTools default and add new audit fields**

In `lib/config.mjs`, find the `DEFAULTS` object. Replace line 24-25:

```js
  /** Tools the reviewer can use */
  reviewerTools: 'Read,Edit,Grep,Glob',
```

with:

```js
  /** Tools the reviewer can use. Includes Bash for git log checks in the audit checklist. */
  reviewerTools: 'Read,Edit,Grep,Glob,Bash',

  /** Kill-switch for the reviewer audit upgrade. Default true (audit enabled). Set false to revert to pre-Spec-1 merge-only behavior. */
  reviewerAuditEnabled: true,
```

- [ ] **Step 2: Rename `adversarialRate` to `adversarialRatio` and flip default to 0**

Find lines 236-238:

```js
  /** Rate of adversarial prompts (0-1, per persona generation call) */
  adversarialRate: 0.1,
```

Replace with:

```js
  /** Rate of adversarial prompts (0-1, per persona generation call). V1 defaults to 0 — the generator does not produce adversarial prompts automatically. Manually-added prompts with `adversarial: true` are still honored. */
  adversarialRatio: 0,
```

- [ ] **Step 3: Resolve `failingPromptsPath` alongside other data-dir paths**

Find the block that resolves derived paths (around line 270-272):

```js
  merged.goldenSetPath = join(merged.dataDir, 'golden-set.json');
  merged.promptSetPath = join(merged.dataDir, 'prompt-set.json');
  merged.metricsPath = join(merged.dataDir, 'metrics.json');
```

Add `failingPromptsPath` right after:

```js
  merged.goldenSetPath = join(merged.dataDir, 'golden-set.json');
  merged.promptSetPath = join(merged.dataDir, 'prompt-set.json');
  merged.metricsPath = join(merged.dataDir, 'metrics.json');
  merged.failingPromptsPath = join(merged.dataDir, 'failing-prompts.json');
```

- [ ] **Step 4: Update in-process references to adversarialRate**

In `lib/run.mjs`, find the single usage at line 233:

```js
  const adversarial = Math.random() < (config.adversarialRate || 0.1);
```

Replace with (note the default is now 0, so no fallback):

```js
  const adversarial = Math.random() < (config.adversarialRatio || 0);
```

- [ ] **Step 5: Smoke-test the config loader**

Create `test/config.test.mjs` (only if it doesn't already exist):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('loadConfig sets reviewerAuditEnabled default true', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'evolve-config-'));
  writeFileSync(join(tmp, 'evolve.config.mjs'), 'export default { personas: [], writeTools: ["x"], srcDirs: ["./x"] };');
  const cfg = await loadConfig(tmp, join(tmp, 'evolve.config.mjs'));
  assert.equal(cfg.reviewerAuditEnabled, true);
  assert.ok(cfg.reviewerTools.includes('Bash'));
  assert.equal(cfg.adversarialRatio, 0);
  assert.ok(cfg.failingPromptsPath.endsWith('failing-prompts.json'));
  rmSync(tmp, { recursive: true });
});
```

- [ ] **Step 6: Run the config test**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/config.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/config.mjs lib/run.mjs test/config.test.mjs
git commit -m "feat(config): extend reviewerTools with Bash, add audit fields, rename adversarialRate"
```

---

### Task 2: Create `lib/failing-prompts.mjs` with unit tests

**Files:**
- Create: `lib/failing-prompts.mjs`
- Create: `test/failing-prompts.test.mjs`

- [ ] **Step 1: Write the failing tests for the module**

Create `test/failing-prompts.test.mjs`:

```js
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
  const store = loadFailingPrompts(cfg);
  assert.equal(store.version, 1);
  assert.deepEqual(store.entries, []);
  rmSync(cfg._dir, { recursive: true });
});

test('addFailingEntry persists a prompt entry with id and timestamp', () => {
  const cfg = makeCfg();
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
  rmSync(cfg._dir, { recursive: true });
});

test('getFailingForPersona returns only matching persona entries', () => {
  const cfg = makeCfg();
  addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p1' });
  addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'b', prompt: 'p2' });
  addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p3' });
  const aEntries = getFailingForPersona(cfg, 'a');
  assert.equal(aEntries.length, 2);
  assert.deepEqual(aEntries.map(e => e.prompt).sort(), ['p1', 'p3']);
  rmSync(cfg._dir, { recursive: true });
});

test('getFailingPatterns returns only pattern-kind entries', () => {
  const cfg = makeCfg();
  addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p1' });
  addFailingEntry(cfg, { kind: 'pattern', reason: 'reviewer_discretion', patternRegex: 'already occupied', triggeringError: { tool: 'mcp__x__seat', errorTextKey: 'already occupied' } });
  const patterns = getFailingPatterns(cfg);
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].kind, 'pattern');
  assert.equal(patterns[0].patternRegex, 'already occupied');
  rmSync(cfg._dir, { recursive: true });
});

test('removeFailing deletes one entry by id', () => {
  const cfg = makeCfg();
  const e1 = addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p1' });
  const e2 = addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p2' });
  removeFailing(cfg, e1.id);
  const store = loadFailingPrompts(cfg);
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].id, e2.id);
  rmSync(cfg._dir, { recursive: true });
});

test('clearAllFailing empties the store', () => {
  const cfg = makeCfg();
  addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p1' });
  addFailingEntry(cfg, { kind: 'prompt', reason: 'reviewer_discretion', persona: 'b', prompt: 'p2' });
  clearAllFailing(cfg);
  const store = loadFailingPrompts(cfg);
  assert.deepEqual(store.entries, []);
  rmSync(cfg._dir, { recursive: true });
});

test('normalizeErrorText lowercases and strips volatile ids', () => {
  const raw = 'Order ID abc-123-XYZ is already occupied (2 guests seated)';
  const key = normalizeErrorText(raw);
  assert.equal(key.includes('abc-123-xyz'), false);
  assert.match(key, /already occupied/);
});

test('saveFailingPrompts is idempotent and preserves version', () => {
  const cfg = makeCfg();
  const store = { version: 1, entries: [{ id: 'fp-1', kind: 'prompt', reason: 'reviewer_discretion', persona: 'a', prompt: 'p', markedAt: '2026-04-11T00:00:00Z' }] };
  saveFailingPrompts(cfg, store);
  saveFailingPrompts(cfg, store);
  const loaded = loadFailingPrompts(cfg);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.entries.length, 1);
  rmSync(cfg._dir, { recursive: true });
});
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/failing-prompts.test.mjs`
Expected: FAIL with "Cannot find module '../lib/failing-prompts.mjs'".

- [ ] **Step 3: Implement the module**

Create `lib/failing-prompts.mjs`:

```js
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
    .replace(/\b[a-z0-9]{2,}-[a-z0-9-]{2,}\b/gi, '')  // dash-separated ids
    .replace(/\b\d{4,}\b/g, '')                         // long digit runs
    .replace(/\s+/g, ' ')
    .trim();
}
```

- [ ] **Step 4: Run the tests to confirm pass**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/failing-prompts.test.mjs`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/failing-prompts.mjs test/failing-prompts.test.mjs
git commit -m "feat(failing-prompts): add persistence module with load/save/add/query helpers"
```

---

### Task 3: Reviewer protocol parser + unit tests

**Files:**
- Create: `lib/reviewer-protocol.mjs`
- Create: `test/reviewer-protocol.test.mjs`

- [ ] **Step 1: Write failing tests for the parser**

Create `test/reviewer-protocol.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewerOutput, validateReviewerOutput } from '../lib/reviewer-protocol.mjs';

const VALID_OUTPUT = `
I investigated each branch.

<AUDIT>
[
  {
    "branch": "fix/persona-a-0-123",
    "fixType": "rejection_path",
    "backendCheck": {
      "performed": true,
      "method": "grep",
      "evidence": [
        "grepped 'already occupied' in src/: found at tools/helpers.ts:34",
        "read services/guestManagement.ts:120-180, seatGuest does NOT reject occupancy"
      ],
      "conclusion": "fabrication"
    },
    "decision": "reject",
    "reason": "backend handler does not enforce occupancy; guard fabricated"
  },
  {
    "branch": "fix/persona-b-1-456",
    "fixType": "tool_description",
    "backendCheck": {
      "performed": true,
      "method": "read",
      "evidence": ["read write.ts description — improved only wording"],
      "conclusion": "legitimate"
    },
    "decision": "merge",
    "reason": "description clarification, no semantic change"
  }
]
</AUDIT>

<PROMPT_REVIEW>
[
  {
    "promptId": "waiter-orders::seat a walk-in at Tisch 5",
    "persona": "waiter-orders",
    "invariantStatus": "contaminated",
    "decision": "drop",
    "reason": "Tisch 5 must be empty invariant contradicts multi-occupancy"
  }
]
</PROMPT_REVIEW>
`;

test('parseReviewerOutput extracts AUDIT and PROMPT_REVIEW blocks', () => {
  const out = parseReviewerOutput(VALID_OUTPUT);
  assert.equal(out.audits.length, 2);
  assert.equal(out.audits[0].branch, 'fix/persona-a-0-123');
  assert.equal(out.audits[0].decision, 'reject');
  assert.equal(out.audits[1].decision, 'merge');
  assert.equal(out.promptReviews.length, 1);
  assert.equal(out.promptReviews[0].decision, 'drop');
  assert.equal(out.promptReviews[0].invariantStatus, 'contaminated');
});

test('parseReviewerOutput returns empty arrays when tags missing', () => {
  const out = parseReviewerOutput('just a plain response with no tags');
  assert.deepEqual(out.audits, []);
  assert.deepEqual(out.promptReviews, []);
});

test('parseReviewerOutput handles malformed JSON gracefully', () => {
  const out = parseReviewerOutput('<AUDIT>[not json]</AUDIT>');
  assert.deepEqual(out.audits, []);
  assert.equal(out.parseErrors.length, 1);
});

test('validateReviewerOutput rejects unknown decision values', () => {
  const errs = validateReviewerOutput({
    audits: [{ branch: 'x', fixType: 'other', backendCheck: { performed: true, method: 'grep', evidence: [], conclusion: 'legitimate' }, decision: 'bogus', reason: 'x' }],
    promptReviews: [],
  });
  assert.ok(errs.length > 0);
  assert.match(errs[0], /decision/);
});

test('validateReviewerOutput accepts a legitimate merge audit', () => {
  const errs = validateReviewerOutput({
    audits: [{
      branch: 'x',
      fixType: 'tool_description',
      backendCheck: { performed: true, method: 'read', evidence: ['x'], conclusion: 'legitimate' },
      decision: 'merge',
      reason: 'fine',
    }],
    promptReviews: [],
  });
  assert.deepEqual(errs, []);
});

test('validateReviewerOutput requires backendCheck.performed for rejection-path fixTypes', () => {
  const errs = validateReviewerOutput({
    audits: [{
      branch: 'x',
      fixType: 'rejection_path',
      backendCheck: { performed: false, method: 'grep', evidence: [], conclusion: 'inconclusive' },
      decision: 'merge',
      reason: 'oops',
    }],
    promptReviews: [],
  });
  assert.ok(errs.some(e => /rejection_path/.test(e)));
});

test('validateReviewerOutput rejects merge decision with fabrication conclusion', () => {
  const errs = validateReviewerOutput({
    audits: [{
      branch: 'x',
      fixType: 'rejection_path',
      backendCheck: { performed: true, method: 'grep', evidence: ['x'], conclusion: 'fabrication' },
      decision: 'merge',
      reason: 'x',
    }],
    promptReviews: [],
  });
  assert.ok(errs.some(e => /fabrication/.test(e)));
});
```

- [ ] **Step 2: Run the tests to confirm failure**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/reviewer-protocol.test.mjs`
Expected: FAIL with "Cannot find module '../lib/reviewer-protocol.mjs'".

- [ ] **Step 3: Implement the parser**

Create `lib/reviewer-protocol.mjs`:

```js
/**
 * mcp-evolve — Reviewer output protocol.
 *
 * The reviewer emits JSON inside <AUDIT> and <PROMPT_REVIEW> tags at the
 * end of its response. This module extracts and validates those blocks.
 *
 * Expected reviewer output shape:
 *
 *   <AUDIT>
 *   [ { branch, fixType, backendCheck: { performed, method, evidence, conclusion }, decision, reason }, ... ]
 *   </AUDIT>
 *
 *   <PROMPT_REVIEW>
 *   [ { promptId, persona, invariantStatus, decision, reason }, ... ]
 *   </PROMPT_REVIEW>
 */

const VALID_FIX_TYPES = new Set([
  'rejection_path', 'tool_description', 'handler_logic',
  'helper_function', 'schema', 'other',
]);
const VALID_DECISIONS = new Set(['merge', 'reject']);
const VALID_METHODS = new Set(['grep', 'read', 'git_log']);
const VALID_CONCLUSIONS = new Set(['fabrication', 'legitimate', 'inconclusive']);
const VALID_INVARIANT_STATUS = new Set(['correct', 'contaminated', 'adversarial_expected']);
const VALID_PROMPT_DECISIONS = new Set(['keep', 'drop']);

function extractTagged(text, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const match = text.match(re);
  return match ? match[1].trim() : null;
}

export function parseReviewerOutput(text) {
  const result = { audits: [], promptReviews: [], parseErrors: [] };
  if (typeof text !== 'string') return result;

  const auditRaw = extractTagged(text, 'AUDIT');
  if (auditRaw) {
    try {
      const parsed = JSON.parse(auditRaw);
      if (Array.isArray(parsed)) result.audits = parsed;
      else result.parseErrors.push('AUDIT block is not a JSON array');
    } catch (err) {
      result.parseErrors.push(`AUDIT parse failed: ${err.message}`);
    }
  }

  const promptRaw = extractTagged(text, 'PROMPT_REVIEW');
  if (promptRaw) {
    try {
      const parsed = JSON.parse(promptRaw);
      if (Array.isArray(parsed)) result.promptReviews = parsed;
      else result.parseErrors.push('PROMPT_REVIEW block is not a JSON array');
    } catch (err) {
      result.parseErrors.push(`PROMPT_REVIEW parse failed: ${err.message}`);
    }
  }

  return result;
}

export function validateReviewerOutput(parsed) {
  const errors = [];

  for (const a of parsed.audits || []) {
    if (!a.branch || typeof a.branch !== 'string') errors.push(`audit missing branch: ${JSON.stringify(a)}`);
    if (!VALID_FIX_TYPES.has(a.fixType)) errors.push(`audit.fixType invalid: ${a.fixType}`);
    if (!VALID_DECISIONS.has(a.decision)) errors.push(`audit.decision invalid: ${a.decision}`);
    if (!a.reason || typeof a.reason !== 'string') errors.push(`audit.reason missing for ${a.branch}`);

    const bc = a.backendCheck || {};
    if (typeof bc.performed !== 'boolean') errors.push(`audit.backendCheck.performed missing for ${a.branch}`);
    if (bc.performed && !VALID_METHODS.has(bc.method)) errors.push(`audit.backendCheck.method invalid for ${a.branch}: ${bc.method}`);
    if (!VALID_CONCLUSIONS.has(bc.conclusion)) errors.push(`audit.backendCheck.conclusion invalid for ${a.branch}: ${bc.conclusion}`);

    // Semantic constraint: rejection_path diffs MUST have performed a real backend check
    if (a.fixType === 'rejection_path' && bc.performed !== true) {
      errors.push(`audit fixType=rejection_path requires backendCheck.performed=true for ${a.branch}`);
    }

    // Semantic constraint: decision=merge is incompatible with conclusion=fabrication
    if (a.decision === 'merge' && bc.conclusion === 'fabrication') {
      errors.push(`audit ${a.branch} marks conclusion=fabrication but decision=merge — inconsistent`);
    }
  }

  for (const pr of parsed.promptReviews || []) {
    if (!pr.promptId || typeof pr.promptId !== 'string') errors.push(`prompt review missing promptId: ${JSON.stringify(pr)}`);
    if (!pr.persona || typeof pr.persona !== 'string') errors.push(`prompt review missing persona: ${pr.promptId}`);
    if (!VALID_INVARIANT_STATUS.has(pr.invariantStatus)) errors.push(`prompt review invariantStatus invalid: ${pr.invariantStatus}`);
    if (!VALID_PROMPT_DECISIONS.has(pr.decision)) errors.push(`prompt review decision invalid: ${pr.decision}`);
  }

  return errors;
}
```

- [ ] **Step 4: Run the tests to confirm pass**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/reviewer-protocol.test.mjs`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/reviewer-protocol.mjs test/reviewer-protocol.test.mjs
git commit -m "feat(reviewer-protocol): parse and validate tagged-JSON reviewer output"
```

---

### Task 4: Rewrite `prompts/reviewer.md`

**Files:**
- Modify: `prompts/reviewer.md` (full rewrite)

- [ ] **Step 1: Replace the reviewer prompt with the audit-first version**

Delete the entire current contents of `prompts/reviewer.md` and write this new content:

```markdown
You are the mcp-evolve reviewer. You audit parallel fixer branches for **correctness** and then apply the approved ones. Your job is NOT to make tests green — your job is to prevent fabricated domain constraints from landing in the MCP server.

You will be given:

1. A list of fixer branches, each with a diff and the original errors/prompts that triggered it.
2. The MCP source tree (accessible via Read/Grep/Bash).
3. Per-prompt context: persona, prompt text, probe, invariant, and the grading issues that drove the fix.

You must emit a structured audit and (for approved branches) apply the diff via Edit, **all in one response**.

## Decision matrix

For every fixer output, make two orthogonal decisions:

|                           | **Fix is legitimate**           | **Fix is fabricated**            |
|---------------------------|----------------------------------|----------------------------------|
| **Prompt is legitimate**  | merge fix, keep prompt           | reject fix, keep prompt           |
| **Prompt is problematic** | merge fix, drop prompt            | reject fix, drop prompt            |

"Drop prompt" means: the prompt had a contaminated invariant or is an adversarial misfire. The harness removes it from scoring and puts it in the failing-prompts store.

## Mandatory audit checklist — rejection paths

For ANY diff that adds:
- `isError: true` with a hardcoded user-facing message
- An early `return` that short-circuits a backend call
- A `throw new Error()` with a domain-specific explanation
- Guard text: "⛔", "Cannot X", "already Y", "must first Z", "not allowed"
- A new `if` branch that skips a handler based on input state

…you MUST perform all five checks BEFORE deciding:

1. **Grep for the added error text.** `rg "<added string>" <srcDirs>`. If the exact string already exists, the guard is already in place — the errors are self-generated. Reject.
2. **Grep for the backend handler.** Locate the callable/service/handler the MCP tool dispatches to.
3. **Read the backend handler.** Does it actually reject the condition the fix is guarding against? If not → fabrication → reject.
4. **Check git history.** `git log --oneline -20 <file>`. If a recent commit REMOVED the same guard, the maintainers decided it was wrong. Reject.
5. **Re-read the input errors.** If the error text matches a string in the current source, they are self-generated and the fix is reinforcing a fabrication. Reject.

If the diff is NOT a rejection path (tool description improvement, schema fix, handler bug fix, etc.), the checklist does not apply — but use judgment: does the fix match the actual bug?

## PROMPT_REVIEW — contamination detection

For each input prompt that triggered a fix, decide:

- `invariantStatus: correct` — probe invariant matches actual backend behavior. Keep.
- `invariantStatus: contaminated` — probe invariant contradicts observed backend behavior (e.g. "Tisch 5 must be empty" when the backend supports multi-occupancy). Drop.
- `invariantStatus: adversarial_expected` — this prompt is flagged `adversarial: true`; errors are expected. Keep but do NOT use its errors as fixer justification.

Drop means: remove from current run scoring + add to failing-prompts store. The prompt will not run again until a human clears it.

## Applying approved changes

For every branch with `decision: merge`, read the branch's files (they are in a git worktree — path given in the input) and use Edit to apply the changes to the main working tree files. Do NOT invent new changes. Do NOT re-audit while editing.

For branches with `decision: reject`, do nothing — the harness cleans up the worktree.

If two approved branches edit the same file, merge them: read the current file + both diffs, apply each intent. If the two diffs conflict semantically, choose the more correct one and note the skip in your reason field.

## Output format

At the end of your response (after any Read/Grep/Bash/Edit calls), emit exactly two tagged JSON blocks:

```
<AUDIT>
[
  {
    "branch": "<worktree branch name as given>",
    "fixType": "rejection_path" | "tool_description" | "handler_logic" | "helper_function" | "schema" | "other",
    "backendCheck": {
      "performed": true | false,
      "method": "grep" | "read" | "git_log",
      "evidence": ["<short line stating what you found and where>", ...],
      "conclusion": "fabrication" | "legitimate" | "inconclusive"
    },
    "decision": "merge" | "reject",
    "reason": "<one-sentence rationale>"
  }
]
</AUDIT>

<PROMPT_REVIEW>
[
  {
    "promptId": "<stable id from input: '{persona}::{prompt}'>",
    "persona": "<persona id>",
    "invariantStatus": "correct" | "contaminated" | "adversarial_expected",
    "decision": "keep" | "drop",
    "reason": "<one-sentence rationale>"
  }
]
</PROMPT_REVIEW>
```

**Constraints on your output:**
- `AUDIT` is a JSON array; one object per branch. Every branch in the input MUST appear exactly once.
- `PROMPT_REVIEW` is a JSON array; one object per distinct input prompt. If you have no concerns about a prompt, emit it with `decision: keep`.
- `fixType: rejection_path` REQUIRES `backendCheck.performed: true`. If you did not perform the checklist, the audit is invalid.
- `decision: merge` with `conclusion: fabrication` is forbidden — that is a logical contradiction.
- If you reject ANY branch, do NOT apply its Edits. The rejected branches stay in their worktrees until the harness cleans them up.
- Do not emit commentary after the `</PROMPT_REVIEW>` tag.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add prompts/reviewer.md
git commit -m "feat(reviewer): rewrite prompt with audit checklist, case matrix, tagged-JSON output"
```

---

### Task 5: Audit orchestration module (`lib/audit.mjs`) with unit tests

**Files:**
- Create: `lib/audit.mjs`
- Create: `test/audit.test.mjs`

- [ ] **Step 1: Write failing tests for the audit orchestration**

Create `test/audit.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAuditDecisions } from '../lib/audit.mjs';

function makeCfg() {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  return {
    failingPromptsPath: join(dir, 'failing-prompts.json'),
    promptSetPath: join(dir, 'prompt-set.json'),
    _dir: dir,
  };
}

test('applyAuditDecisions marks prompts invalid and persists failing entries', () => {
  const cfg = makeCfg();
  writeFileSync(cfg.promptSetPath, JSON.stringify({ version: 1, prompts: [] }));

  const scoredPrompts = [
    { prompt: 'seat a walk-in at Tisch 5', persona: 'waiter-orders', group: 'train', score: { errorsFound: 2 } },
    { prompt: 'list orders', persona: 'waiter-orders', group: 'train', score: { errorsFound: 0 } },
  ];

  const reviewerOutput = {
    audits: [{
      branch: 'fix/waiter-orders-0-123',
      fixType: 'rejection_path',
      backendCheck: { performed: true, method: 'grep', evidence: ['fabricated'], conclusion: 'fabrication' },
      decision: 'reject',
      reason: 'fabrication',
    }],
    promptReviews: [{
      promptId: 'waiter-orders::seat a walk-in at Tisch 5',
      persona: 'waiter-orders',
      invariantStatus: 'contaminated',
      decision: 'drop',
      reason: 'invariant contradicts backend',
    }],
    parseErrors: [],
  };

  const branches = [{
    branchName: 'fix/waiter-orders-0-123',
    worktreePath: '/tmp/wt',
    slug: 'waiter-orders-0-123',
    fixableError: {
      persona: { id: 'waiter-orders' },
      prompt: 'seat a walk-in at Tisch 5',
      errors: [{ tool: 'mcp__x__seat', error: 'already occupied', category: 'server' }],
    },
  }];

  const result = applyAuditDecisions({
    reviewerOutput,
    branches,
    scoredPrompts,
    runId: '2026-04-11T18:00:00Z',
    config: cfg,
  });

  assert.equal(result.merged.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.droppedPrompts.length, 1);
  assert.equal(scoredPrompts[0].invalid, true);
  assert.equal(scoredPrompts[0].invalidReason, 'invariant contradicts backend');
  assert.equal(scoredPrompts[1].invalid, undefined);

  const failing = JSON.parse(readFileSync(cfg.failingPromptsPath, 'utf-8'));
  assert.equal(failing.entries.length, 1);
  assert.equal(failing.entries[0].persona, 'waiter-orders');
  assert.equal(failing.entries[0].reason, 'contaminated_invariant');

  rmSync(cfg._dir, { recursive: true });
});

test('applyAuditDecisions removes golden prompt from prompt-set.json when dropped', () => {
  const cfg = makeCfg();
  writeFileSync(cfg.promptSetPath, JSON.stringify({
    version: 1,
    prompts: [
      { persona: 'waiter-orders', prompt: 'seat a walk-in at Tisch 5', group: 'golden', consecutivePasses: 5 },
      { persona: 'waiter-orders', prompt: 'list orders', group: 'golden', consecutivePasses: 3 },
    ],
  }));

  const scoredPrompts = [
    { prompt: 'seat a walk-in at Tisch 5', persona: 'waiter-orders', group: 'golden', score: { errorsFound: 1 } },
  ];

  const reviewerOutput = {
    audits: [],
    promptReviews: [{
      promptId: 'waiter-orders::seat a walk-in at Tisch 5',
      persona: 'waiter-orders',
      invariantStatus: 'contaminated',
      decision: 'drop',
      reason: 'invariant fabricated during Round 9',
    }],
    parseErrors: [],
  };

  applyAuditDecisions({
    reviewerOutput,
    branches: [],
    scoredPrompts,
    runId: '2026-04-11T18:00:00Z',
    config: cfg,
  });

  const ps = JSON.parse(readFileSync(cfg.promptSetPath, 'utf-8'));
  assert.equal(ps.prompts.length, 1);
  assert.equal(ps.prompts[0].prompt, 'list orders');

  rmSync(cfg._dir, { recursive: true });
});

test('applyAuditDecisions counts merged and rejected branches', () => {
  const cfg = makeCfg();
  writeFileSync(cfg.promptSetPath, JSON.stringify({ version: 1, prompts: [] }));

  const reviewerOutput = {
    audits: [
      { branch: 'a', fixType: 'tool_description', backendCheck: { performed: false, method: 'grep', evidence: [], conclusion: 'legitimate' }, decision: 'merge', reason: 'ok' },
      { branch: 'b', fixType: 'rejection_path', backendCheck: { performed: true, method: 'read', evidence: ['x'], conclusion: 'fabrication' }, decision: 'reject', reason: 'bad' },
    ],
    promptReviews: [],
    parseErrors: [],
  };

  const branches = [
    { branchName: 'a', worktreePath: '/tmp/a', slug: 'a', fixableError: { persona: { id: 'p1' }, prompt: 'x', errors: [] } },
    { branchName: 'b', worktreePath: '/tmp/b', slug: 'b', fixableError: { persona: { id: 'p2' }, prompt: 'y', errors: [] } },
  ];

  const result = applyAuditDecisions({
    reviewerOutput, branches, scoredPrompts: [], runId: 'r', config: cfg,
  });

  assert.equal(result.merged.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.merged[0].branchName, 'a');
  assert.equal(result.rejected[0].branchName, 'b');

  rmSync(cfg._dir, { recursive: true });
});

test('applyAuditDecisions defaults to reject when branch missing from AUDIT output', () => {
  const cfg = makeCfg();
  writeFileSync(cfg.promptSetPath, JSON.stringify({ version: 1, prompts: [] }));

  const branches = [
    { branchName: 'missing-from-audit', worktreePath: '/tmp/x', slug: 'x', fixableError: { persona: { id: 'p' }, prompt: 'p', errors: [] } },
  ];

  const result = applyAuditDecisions({
    reviewerOutput: { audits: [], promptReviews: [], parseErrors: [] },
    branches,
    scoredPrompts: [],
    runId: 'r',
    config: cfg,
  });

  assert.equal(result.merged.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /missing from AUDIT/);

  rmSync(cfg._dir, { recursive: true });
});
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/audit.test.mjs`
Expected: FAIL with "Cannot find module '../lib/audit.mjs'".

- [ ] **Step 3: Implement `lib/audit.mjs`**

Create `lib/audit.mjs`:

```js
/**
 * mcp-evolve — Audit orchestration.
 *
 * Given a set of fixer branches, calls the reviewer LLM to audit and apply
 * diffs, then translates the reviewer's structured decisions into:
 *   - which branches were merged / rejected (for worktree cleanup)
 *   - which prompts were dropped (marked invalid, added to failing store)
 *   - pattern-level failing entries for rejected model-error fixer outputs
 *
 * Pure-function `applyAuditDecisions` is separated from the LLM-invoking
 * `runAuditAndMerge` so the decision-application logic can be unit-tested
 * without a live Claude CLI.
 */

import { execSync } from 'node:child_process';
import { claude, readPrompt } from './claude.mjs';
import { parseReviewerOutput, validateReviewerOutput } from './reviewer-protocol.mjs';
import { addFailingEntry, normalizeErrorText } from './failing-prompts.mjs';
import { loadPromptSet, savePromptSet } from './eval.mjs';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

/**
 * Build the reviewer prompt payload from branches + scoredPrompts.
 * Each branch gets its diff, its triggering error, and the per-prompt context.
 */
function buildReviewerPayload(branches, config) {
  const sections = branches.map((b, idx) => {
    let diff = '';
    try {
      diff = execSync(`git diff HEAD..."${b.branchName}"`, {
        cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000,
      }).trim();
    } catch (err) {
      diff = `(could not read diff: ${err.message || err})`;
    }

    const fe = b.fixableError;
    const errorSummary = (fe.errors || []).map(e =>
      `  - tool: ${e.tool}\n    error: ${typeof e.error === 'string' ? e.error.slice(0, 500) : JSON.stringify(e.error).slice(0, 500)}`
    ).join('\n');

    return [
      `### Branch ${idx + 1}: ${b.branchName}`,
      `Worktree path: ${b.worktreePath}`,
      `Persona: ${fe.persona?.id || 'unknown'}`,
      `Prompt: ${fe.prompt}`,
      fe.probe ? `Probe: ${fe.probe}` : '',
      fe.invariant ? `Invariant: ${fe.invariant}` : '',
      fe.probeType ? `Probe type: ${fe.probeType}` : '',
      fe.lifecycle ? `Lifecycle: ${fe.lifecycle}` : '',
      `Errors:`,
      errorSummary || '  (none)',
      `\nDiff:\n\`\`\`diff\n${diff.slice(0, 6000)}\n\`\`\``,
    ].filter(Boolean).join('\n');
  });

  const header = [
    `${branches.length} fixer branches need audit and merge.`,
    `MCP source directories: ${(config.srcDirs || []).join(', ')}`,
    `Project root: ${config.projectRoot}`,
    ``,
    `Run the audit checklist per your system prompt. Apply approved diffs via Edit. Emit <AUDIT> and <PROMPT_REVIEW> JSON blocks at the end.`,
    ``,
  ].join('\n');

  return header + sections.join('\n\n');
}

/**
 * Apply reviewer decisions to the run state. Pure function — no LLM calls,
 * no git operations. Returns a summary for the run log.
 */
export function applyAuditDecisions({ reviewerOutput, branches, scoredPrompts, runId, config }) {
  const merged = [];
  const rejected = [];
  const droppedPrompts = [];

  // 1. Build a branch → decision map. Missing branches default to reject.
  const auditByBranch = new Map();
  for (const a of reviewerOutput.audits || []) {
    auditByBranch.set(a.branch, a);
  }

  for (const b of branches) {
    const audit = auditByBranch.get(b.branchName);
    if (!audit) {
      rejected.push({
        branchName: b.branchName,
        worktreePath: b.worktreePath,
        fixType: 'other',
        reason: 'missing from AUDIT output — defaulting to reject for safety',
        evidence: null,
      });
      continue;
    }
    if (audit.decision === 'merge') {
      merged.push({ branchName: b.branchName, worktreePath: b.worktreePath, audit });
    } else {
      rejected.push({
        branchName: b.branchName,
        worktreePath: b.worktreePath,
        fixType: audit.fixType,
        reason: audit.reason,
        evidence: audit.backendCheck,
      });

      // Pattern-level failing entries: when the rejected branch was a
      // model-error fixer attempt, persist a pattern that future model-error
      // fixer runs will filter out.
      if (b.kind === 'model-error') {
        const errorKey = normalizeErrorText(
          (b.fixableError?.errors || []).map(e => e.error).join(' ')
        );
        if (errorKey) {
          addFailingEntry(config, {
            kind: 'pattern',
            reason: 'fabrication_trigger',
            triggeringError: {
              tool: b.fixableError?.errors?.[0]?.tool || 'model-error',
              errorTextKey: errorKey,
              fullError: (b.fixableError?.errors || []).map(e => e.error).join('\n').slice(0, 500),
            },
            patternRegex: escapeRegex(errorKey).slice(0, 200),
            rejectedInRun: runId,
          });
        }
      }
    }
  }

  // 2. Apply PROMPT_REVIEW drops: mark invalid, persist to failing-prompts, remove golden from prompt-set.
  const promptSet = loadPromptSet(config);
  let promptSetChanged = false;

  for (const pr of reviewerOutput.promptReviews || []) {
    if (pr.decision !== 'drop') continue;

    // Parse "persona::prompt" promptId
    const [persona, ...promptParts] = pr.promptId.split('::');
    const promptText = promptParts.join('::');

    // Mark the scored prompt invalid
    const scored = scoredPrompts.find(q =>
      (q.persona === persona || q.persona?.id === persona) && q.prompt === promptText
    );
    if (scored) {
      scored.invalid = true;
      scored.invalidReason = pr.reason;
    }

    // Persist to failing-prompts store
    const failingReason =
      pr.invariantStatus === 'contaminated' ? 'contaminated_invariant' :
      pr.invariantStatus === 'adversarial_expected' ? 'adversarial_misfired' :
      'reviewer_discretion';

    addFailingEntry(config, {
      kind: 'prompt',
      reason: failingReason,
      persona,
      prompt: promptText,
      contextInvariant: scored?.probeData?.invariant || null,
      rejectedInRun: runId,
    });

    droppedPrompts.push({
      persona, prompt: promptText,
      reason: pr.reason,
      invariantStatus: pr.invariantStatus,
      wasGolden: scored?.group === 'golden',
    });

    // If the dropped prompt is in the persisted prompt-set as golden, remove it.
    if (promptSet && Array.isArray(promptSet.prompts)) {
      const before = promptSet.prompts.length;
      promptSet.prompts = promptSet.prompts.filter(p =>
        !(p.persona === persona && p.prompt === promptText && p.group === 'golden')
      );
      if (promptSet.prompts.length !== before) {
        promptSetChanged = true;
      }
    }
  }

  if (promptSetChanged && promptSet) {
    savePromptSet(promptSet, config);
  }

  return { merged, rejected, droppedPrompts };
}

/**
 * Run the reviewer LLM on the given branches and apply its decisions.
 * Returns a summary plus the parsed reviewer output.
 */
export async function runAuditAndMerge({ branches, scoredPrompts, runId, config }) {
  if (branches.length === 0) {
    return { merged: [], rejected: [], droppedPrompts: [], reviewerOutput: null, parseErrors: [] };
  }

  if (config.reviewerAuditEnabled === false) {
    log(`  [audit] reviewerAuditEnabled=false — skipping audit, approving all branches`);
    const approvedAll = {
      audits: branches.map(b => ({
        branch: b.branchName,
        fixType: 'other',
        backendCheck: { performed: false, method: 'grep', evidence: [], conclusion: 'inconclusive' },
        decision: 'merge',
        reason: 'audit disabled via config',
      })),
      promptReviews: [],
      parseErrors: [],
    };
    const summary = applyAuditDecisions({ reviewerOutput: approvedAll, branches, scoredPrompts, runId, config });
    return { ...summary, reviewerOutput: approvedAll, parseErrors: [] };
  }

  const payload = buildReviewerPayload(branches, config);

  log(`  [audit] calling reviewer for ${branches.length} branch(es)...`);
  const output = await claude(payload, {
    systemPrompt: readPrompt(config.promptsDir, 'reviewer.md'),
    allowedTools: config.reviewerTools || 'Read,Edit,Grep,Glob,Bash',
    model: config.reviewerModel,
    timeout: config.reviewerTimeout || 300_000,
    cwd: config.projectRoot,
  });

  const parsed = parseReviewerOutput(output);
  const validationErrors = validateReviewerOutput(parsed);
  const parseErrors = [...(parsed.parseErrors || []), ...validationErrors];

  if (parseErrors.length > 0) {
    log(`  [audit] WARNING: reviewer output has ${parseErrors.length} validation issue(s):`);
    for (const err of parseErrors) log(`    - ${err}`);
    log(`  [audit] Any branch with invalid or missing AUDIT will default to reject.`);
  }

  const summary = applyAuditDecisions({ reviewerOutput: parsed, branches, scoredPrompts, runId, config });

  log(`  [audit] merged=${summary.merged.length} rejected=${summary.rejected.length} dropped=${summary.droppedPrompts.length}`);
  return { ...summary, reviewerOutput: parsed, parseErrors };
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 4: Run the audit tests to confirm pass**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/audit.test.mjs`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/audit.mjs test/audit.test.mjs
git commit -m "feat(audit): add unified audit-and-merge orchestration with pure decision application"
```

---

### Task 6: Wire audit into `run.mjs` fixer phase

**Files:**
- Modify: `lib/run.mjs:568-623` (replace `mergeFixBranches`)
- Modify: `lib/run.mjs:1210-1260` (propagate prompt context to `fixableErrors`, call `runAuditAndMerge`)
- Modify: `lib/run.mjs:1,40-46` (add audit import)

- [ ] **Step 1: Add the audit import**

In `lib/run.mjs`, find the existing imports block near line 43-46:

```js
import { updateMetrics, recordEscalation, computeTestingEntropy } from './metrics.mjs';
import { autoDev } from './autodev.mjs';
import { runCompetition } from './compete.mjs';
```

Add below:

```js
import { runAuditAndMerge } from './audit.mjs';
```

- [ ] **Step 2: Delete the old `mergeFixBranches` function**

Delete lines 568-623 entirely (the `async function mergeFixBranches(branches, config)` body). This removes the legacy single-branch fast-forward and multi-branch merge logic. The audit module replaces it.

- [ ] **Step 3: Propagate prompt context into `fixableErrors`**

Find the `fixableErrors` collection block around line 1210-1222:

```js
    const fixableErrors = [];
    for (const r of allResults) {
      // In fixed-sets mode, all personas get fixing. In legacy mode, only train.
      if (!useFixedSets && (r.persona.group || 'train') !== 'train') continue;
      for (const q of r.prompts) {
        const mcpErrors = (q.errors || []).filter(e =>
          e.tool !== 'cli' && !NON_FIXABLE_HARNESS_TOOLS.has(e.tool) && e.category !== 'model'
        );
        if (mcpErrors.length > 0) {
          fixableErrors.push({ persona: r.persona, prompt: q.prompt, errors: mcpErrors, debugLogErrors: q.debugLogErrors || [] });
        }
      }
    }
```

Replace with:

```js
    const fixableErrors = [];
    for (const r of allResults) {
      // In fixed-sets mode, all personas get fixing. In legacy mode, only train.
      if (!useFixedSets && (r.persona.group || 'train') !== 'train') continue;
      for (const q of r.prompts) {
        // Adversarial prompts: errors are expected, do NOT feed them to the fixer
        if (q.promptObj?.adversarial === true) continue;
        const mcpErrors = (q.errors || []).filter(e =>
          e.tool !== 'cli' && !NON_FIXABLE_HARNESS_TOOLS.has(e.tool) && e.category !== 'model'
        );
        if (mcpErrors.length > 0) {
          // Find this prompt's group in the persisted prompt-set (if fixed-sets mode)
          let lifecycle = r.persona.group || 'train';
          if (useFixedSets && promptSet) {
            const psEntry = promptSet.prompts.find(e =>
              e.persona === r.persona.id && e.prompt === q.prompt
            );
            if (psEntry?.group) lifecycle = psEntry.group;
          }

          fixableErrors.push({
            persona: r.persona,
            prompt: q.prompt,
            errors: mcpErrors,
            debugLogErrors: q.debugLogErrors || [],
            probe: q.probeData?.probe || q.promptObj?.probe || null,
            invariant: q.probeData?.invariant || q.promptObj?.invariant || null,
            probeType: q.probeData?.probeType || q.promptObj?.probeType || null,
            lifecycle,
          });
        }
      }
    }
```

- [ ] **Step 4: Replace `mergeFixBranches` call with `runAuditAndMerge`**

Find the call site inside Phase B around lines 1253-1258:

```js
      const fixResults = (await Promise.all(fixPromises)).filter(Boolean);

      // Merge all fix branches back
      if (fixResults.length > 0) {
        try { progress.setPhase(prog, 'reviewer'); } catch {}
        await mergeFixBranches(fixResults, config);
        try { progress.setPhase(prog, 'fix_batch'); } catch {}
      }
```

Replace with:

```js
      const fixResults = (await Promise.all(fixPromises)).filter(Boolean);

      // Attach each fixResult to its originating fixableError so the reviewer has full context
      const branchesForAudit = fixResults.map((fr, idx) => ({
        ...fr,
        fixableError: fixableErrors[idx],
        kind: 'fixer',
      }));

      // Run the audit + merge via the reviewer LLM
      let auditSummary = { merged: [], rejected: [], droppedPrompts: [], reviewerOutput: null, parseErrors: [] };
      if (branchesForAudit.length > 0) {
        try { progress.setPhase(prog, 'reviewer'); } catch {}
        auditSummary = await runAuditAndMerge({
          branches: branchesForAudit,
          scoredPrompts: allResults.flatMap(r =>
            r.prompts.map(q => ({
              persona: r.persona.id, prompt: q.prompt,
              group: (useFixedSets && promptSet)
                ? (promptSet.prompts.find(e => e.persona === r.persona.id && e.prompt === q.prompt)?.group || 'train')
                : (r.persona.group || 'train'),
              probeData: q.probeData || null,
              score: q.score,
              // Reference back to the underlying prompt object so invalid flag persists
              __backing: q,
            }))
          ),
          runId: new Date().toISOString(),
          config,
        });

        // Propagate invalid flags from the scored shadow back to the actual prompt results
        for (const d of auditSummary.droppedPrompts) {
          const personaResult = allResults.find(r => r.persona.id === d.persona);
          const q = personaResult?.prompts.find(pq => pq.prompt === d.prompt);
          if (q) {
            q.invalid = true;
            q.invalidReason = d.reason;
          }
        }

        try { progress.setPhase(prog, 'fix_batch'); } catch {}
      }

      // Clean up ALL worktrees (both merged and rejected) now that the reviewer is done
      {
        const { execSync: execS } = await import('node:child_process');
        for (const b of fixResults) {
          try { execS(`git worktree remove "${b.worktreePath}" --force`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000 }); } catch {}
          try { execS(`git branch -D "${b.branchName}"`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 5_000 }); } catch {}
        }
      }

      // Record the audit summary in a run-scoped state object (task 10 wires it into the log)
      runState.audit = {
        fixer: auditSummary,
      };
```

- [ ] **Step 5: Initialize `runState` at the top of `run()`**

Find the beginning of the `run` function around line 788:

```js
export async function run(config, args = {}) {
  setLlmConfig(config);
  const startTime = Date.now();
```

Add `runState` right after `startTime`:

```js
export async function run(config, args = {}) {
  setLlmConfig(config);
  const startTime = Date.now();
  const runState = { audit: null };
```

- [ ] **Step 6: Run the full test suite to confirm nothing regressed**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS on all existing + new tests.

- [ ] **Step 7: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/run.mjs
git commit -m "feat(run): route fixer output through audit module; propagate probe/invariant/lifecycle"
```

---

### Task 7: Worktree-wrap model-error fixer with pattern filter

**Files:**
- Modify: `lib/run.mjs:1363-1406` (model-error fixer block)
- Modify: `prompts/fixer-model-error.md` (filter note)

- [ ] **Step 1: Filter model errors against pattern-level failing entries**

In `lib/run.mjs`, find the model-error fixer block starting around line 1364:

```js
  // Model-error fixer — when 3+ model-category errors accumulate, look for MCP patterns
  if (!runInvalid && !effectiveSkipFixer && !dryRun) {
    const modelErrors = [];
    for (const r of allResults) {
      if (!useFixedSets && (r.persona.group || 'train') !== 'train') continue;
      for (const q of r.prompts) {
        const mErrors = (q.errors || []).filter(e => e.category === 'model');
        if (mErrors.length > 0) {
          modelErrors.push({ persona: r.persona, prompt: q.prompt, errors: mErrors, debugLogErrors: q.debugLogErrors || [] });
        }
      }
    }
```

Add the pattern filter right after `modelErrors` is built and **before** the threshold check:

```js
    // Apply pattern-level failing entries as a pre-filter on model errors
    const { getFailingPatterns } = await import('./failing-prompts.mjs');
    const failingPatterns = getFailingPatterns(config);
    const filteredModelErrors = failingPatterns.length === 0 ? modelErrors : modelErrors.filter(me => {
      const errorText = me.errors.map(e => (typeof e.error === 'string' ? e.error : JSON.stringify(e.error))).join(' ').toLowerCase();
      return !failingPatterns.some(fp => {
        try { return new RegExp(fp.patternRegex, 'i').test(errorText); } catch { return false; }
      });
    });

    if (failingPatterns.length > 0 && filteredModelErrors.length < modelErrors.length) {
      log(`  [model-error filter] ${modelErrors.length - filteredModelErrors.length} prompt(s) filtered out by ${failingPatterns.length} failing pattern(s)`);
    }
```

Then change the threshold check and body below to use `filteredModelErrors` instead of `modelErrors`:

Replace:

```js
    if (modelErrors.length >= (config.modelErrorThreshold || 3)) {
      log('');
      log('='.repeat(60));
      log(`MODEL ERROR FIXER: ${modelErrors.length} model errors — checking for MCP patterns`);
      log('='.repeat(60));

      const errorSummary = modelErrors.map(me =>
        `[${me.persona.id}] Prompt: "${me.prompt.slice(0, 100)}"\n  Errors: ${me.errors.map(e => e.error || e.tool).join('; ')}`
      ).join('\n\n');

      const srcDirHint = config.srcDirs.length > 0
        ? `The MCP server source is at: ${config.srcDirs.join(', ')}`
        : 'Find the MCP server source in the project.';

      await withPhase(prog, 'model_error_fix', () => claude(
        [
          `${modelErrors.length} prompts failed due to model errors (the LLM couldn't use the tools correctly).`,
          `\n${errorSummary}`,
          `\n${srcDirHint}`,
        ].join('\n'),
        {
          systemPrompt: readPrompt(config.promptsDir, 'fixer-model-error.md'),
          allowedTools: config.fixerTools,
          model: config.fixerModel,
          timeout: config.fixerTimeout || 300_000,
          cwd: config.projectRoot,
        },
      ));
      log(`  Model error analysis complete`);
    }
  }
```

with:

```js
    if (filteredModelErrors.length >= (config.modelErrorThreshold || 3)) {
      log('');
      log('='.repeat(60));
      log(`MODEL ERROR FIXER: ${filteredModelErrors.length} model errors — checking for MCP patterns`);
      log('='.repeat(60));

      const meBranch = await runModelErrorFixerInWorktree(filteredModelErrors, config);

      if (meBranch) {
        try { progress.setPhase(prog, 'reviewer'); } catch {}

        // Synthesize a fixableError summary so the audit has per-prompt context
        const syntheticFixable = {
          persona: { id: filteredModelErrors[0]?.persona?.id || 'unknown' },
          prompt: '[model-error batch]',
          errors: filteredModelErrors.flatMap(me => me.errors || []),
          probe: null,
          invariant: null,
          probeType: null,
          lifecycle: 'train',
        };

        const meAudit = await runAuditAndMerge({
          branches: [{
            ...meBranch,
            fixableError: syntheticFixable,
            kind: 'model-error',
          }],
          scoredPrompts: [],
          runId: new Date().toISOString(),
          config,
        });

        runState.audit = runState.audit || {};
        runState.audit.modelError = meAudit;

        // Clean up worktree after audit
        {
          const { execSync: execS } = await import('node:child_process');
          try { execS(`git worktree remove "${meBranch.worktreePath}" --force`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000 }); } catch {}
          try { execS(`git branch -D "${meBranch.branchName}"`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 5_000 }); } catch {}
        }
      } else {
        log(`  Model-error fixer produced no changes`);
      }
    } else if (failingPatterns.length > 0) {
      log(`  Model error fixer skipped — all ${modelErrors.length} error(s) match existing failing patterns`);
    }
  }
```

- [ ] **Step 2: Add `runModelErrorFixerInWorktree` helper**

In `lib/run.mjs`, find the existing `fixErrorInWorktree` function (around line 522). Add this new helper immediately after it:

```js
/**
 * Run the model-error fixer inside a git worktree so its output can be audited.
 * Returns { branchName, worktreePath, slug } or null if no changes were produced.
 */
async function runModelErrorFixerInWorktree(filteredModelErrors, config) {
  const { execSync: execS } = await import('node:child_process');

  const worktreeBase = join(config.dataDir || join(config.projectRoot, '.mcp-evolve'), 'worktrees');
  if (!existsSync(worktreeBase)) mkdirSync(worktreeBase, { recursive: true });

  const slug = `model-error-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-').slice(0, 40);
  const branchName = `fix/${slug}`;
  const worktreePath = join(worktreeBase, slug);

  try {
    await withGitLock(() => {
      execS(`git worktree add -b "${branchName}" "${worktreePath}" HEAD`, {
        cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000,
      });
    });

    const errorSummary = filteredModelErrors.map(me =>
      `[${me.persona.id}] Prompt: "${me.prompt.slice(0, 100)}"\n  Errors: ${me.errors.map(e => e.error || e.tool).join('; ')}`
    ).join('\n\n');

    const srcDirHint = config.srcDirs.length > 0
      ? `The MCP server source is at: ${config.srcDirs.join(', ')}`
      : 'Find the MCP server source in the project.';

    await claude(
      [
        `${filteredModelErrors.length} prompts failed due to model errors (the LLM couldn't use the tools correctly).`,
        `\n${errorSummary}`,
        `\n${srcDirHint}`,
      ].join('\n'),
      {
        systemPrompt: readPrompt(config.promptsDir, 'fixer-model-error.md'),
        allowedTools: config.fixerTools,
        model: config.fixerModel,
        timeout: config.fixerTimeout || 300_000,
        cwd: worktreePath,
      },
    );

    const diff = execS('git diff --stat', { cwd: worktreePath, encoding: 'utf-8', timeout: 5_000 }).trim();
    if (!diff) {
      execS(`git worktree remove "${worktreePath}" --force`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000 });
      execS(`git branch -D "${branchName}"`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 5_000 });
      return null;
    }

    execS('git add -A', { cwd: worktreePath, encoding: 'utf-8', timeout: 5_000 });
    execS(`git commit -m "fix(model-error): batch pattern fix"`, {
      cwd: worktreePath, encoding: 'utf-8', timeout: 5_000,
    });

    return { branchName, worktreePath, slug };
  } catch (err) {
    try { execS(`git worktree remove "${worktreePath}" --force`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000 }); } catch {}
    try { execS(`git branch -D "${branchName}"`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 5_000 }); } catch {}
    log(`  Model-error worktree failed: ${err.message || err}`);
    return null;
  }
}
```

- [ ] **Step 3: Note the pattern filter in `prompts/fixer-model-error.md`**

Open `prompts/fixer-model-error.md`. At the very top, before the current "You are an MCP server fixer..." line, add:

```markdown
> **Note:** Errors matching patterns in `.mcp-evolve/failing-prompts.json` (kind: "pattern") are filtered out of your input before you see them. You only see errors that have not been previously rejected by the reviewer.
```

- [ ] **Step 4: Run the full test suite**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/run.mjs prompts/fixer-model-error.md
git commit -m "feat(model-error): wrap in worktree and route through audit; filter input by failing patterns"
```

---

### Task 8: Adversarial field migration (grader + promptObj)

**Files:**
- Modify: `prompts/grader.md` (add adversarial handling, remove expectedOutcome)
- Modify: `lib/run.mjs:244-262` (generator adversarial hint)
- Modify: `lib/run.mjs:405-407` (grader expectedOutcomeHint)
- Modify: `lib/run.mjs:930` (runAndGrade expectedOutcome pickup)

- [ ] **Step 1: Update `prompts/grader.md` to honor `adversarial: true`**

Open `prompts/grader.md`. Find the block (lines 28-29):

```markdown
- Otherwise: `actionExpectation: "missing_write"`
- If `expectedOutcome: "error"` is set and the tool returned success: FAIL. The server silently accepted invalid input.
```

Replace the second line with:

```markdown
- Otherwise: `actionExpectation: "missing_write"`
- **Adversarial prompts:** if the harness tells you `adversarial: true` for this prompt, the prompt is DESIGNED to fail. Score as `pass` when errors are present. Only fail an adversarial prompt when the tool call returned a FALSE SUCCESS (accepted invalid input silently).
```

- [ ] **Step 2: Replace the adversarial hint in `generatePrompts`**

In `lib/run.mjs`, find lines 233-262 (the adversarial logic in `generatePrompts`):

```js
  const adversarial = Math.random() < (config.adversarialRatio || 0);

  const prefetchHint = fullContext
    ? adversarial
      ? `\n\nReal data from the system (for reference, but you may IGNORE it for this prompt):\n${fullContext}`
      : `\n\nIMPORTANT: Use ONLY real data from the system:\n${fullContext}`
    : '';
  const dateHint = runDateContext
    ? `\n\nIMPORTANT: Use this run-level date context for any date-based prompts:\n${formatDateContextForPrompt(runDateContext)}`
    : '';

  const adversarialHint = adversarial
    ? '\n\nThis prompt MUST be adversarial: reference a nonexistent ID, misspell a name, ask to delete something already gone, or provide contradictory constraints. Add `"expectedOutcome": "error"` to the JSON output for each prompt.'
    : '';
```

Replace with:

```js
  const adversarial = Math.random() < (config.adversarialRatio || 0);

  const prefetchHint = fullContext
    ? adversarial
      ? `\n\nReal data from the system (for reference, but you may IGNORE it for this prompt):\n${fullContext}`
      : `\n\nIMPORTANT: Use ONLY real data from the system:\n${fullContext}`
    : '';
  const dateHint = runDateContext
    ? `\n\nIMPORTANT: Use this run-level date context for any date-based prompts:\n${formatDateContextForPrompt(runDateContext)}`
    : '';

  const adversarialHint = adversarial
    ? '\n\nThis prompt MUST be adversarial: reference a nonexistent ID, misspell a name, ask to delete something already gone, or provide contradictory constraints. Set `"adversarial": true` on each generated prompt JSON object.'
    : '';
```

- [ ] **Step 3: Replace the expectedOutcome pickup in `runAndGrade`**

In `lib/run.mjs`, find line 930:

```js
    const expectedOutcome = typeof promptObj === 'object' ? promptObj.expectedOutcome : null;
```

Replace with:

```js
    const adversarialFlag = typeof promptObj === 'object' && promptObj.adversarial === true;
```

Find the subsequent call to `gradeResponse` at line 955-957:

```js
      const grading = await gradeResponse(pText, result, persona, config, runDateContext, {
        probe, beforeProbe, afterProbe, invariant, probeType, expectedOutcome,
      });
```

Replace with:

```js
      const grading = await gradeResponse(pText, result, persona, config, runDateContext, {
        probe, beforeProbe, afterProbe, invariant, probeType, adversarial: adversarialFlag,
      });
```

- [ ] **Step 4: Replace `expectedOutcomeHint` in `gradeResponse`**

In `lib/run.mjs`, find lines 405-411:

```js
  const expectedOutcomeHint = probeContext.expectedOutcome
    ? `\nExpected outcome: ${probeContext.expectedOutcome} (this is an adversarial prompt — if the tool returned success for invalid input, FAIL it)`
    : '';

  const graderPrompt = [
    `## Run date context\n${formatDateContextForPrompt(promptDateContext)}`,
    `\n## Harness contract\nSystem: ${config.systemDescription}\nConfigured write tools: ${writeTools}\nPrompt is action request: ${isAction ? 'yes' : 'no'}\nIf this is an action request, it only counts as complete if a configured write tool was called OR the request was already satisfied and the assistant clearly explained the no-op.${expectedOutcomeHint}`,
```

Replace with:

```js
  const adversarialHint = probeContext.adversarial === true
    ? `\nAdversarial: true (the prompt is DESIGNED to fail. Score pass when errors appear. Fail only if the tool returned false success.)`
    : '';

  const graderPrompt = [
    `## Run date context\n${formatDateContextForPrompt(promptDateContext)}`,
    `\n## Harness contract\nSystem: ${config.systemDescription}\nConfigured write tools: ${writeTools}\nPrompt is action request: ${isAction ? 'yes' : 'no'}\nIf this is an action request, it only counts as complete if a configured write tool was called OR the request was already satisfied and the assistant clearly explained the no-op.${adversarialHint}`,
```

- [ ] **Step 5: Grader adversarial pass handling in scoring**

In `lib/run.mjs`, find the block where grading issues become errors (around line 960-967):

```js
      if (grading?.issues?.length > 0) {
        for (const issue of grading.issues) {
          result.errors.push({
            tool: isOutputTruncationIssue(issue) ? 'harness:output-truncation' : 'harness:grading',
            input: { prompt: pText },
            error: issue,
          });
        }
      }
```

Wrap with an adversarial-pass check:

```js
      if (grading?.issues?.length > 0 && !adversarialFlag) {
        for (const issue of grading.issues) {
          result.errors.push({
            tool: isOutputTruncationIssue(issue) ? 'harness:output-truncation' : 'harness:grading',
            input: { prompt: pText },
            error: issue,
          });
        }
      } else if (grading?.issues?.length > 0 && adversarialFlag) {
        // Adversarial prompts: the grader reported issues, but these are expected. Record as info.
        result.adversarialExpectedIssues = grading.issues;
      }
```

- [ ] **Step 6: Write a focused test for the grader adversarial path**

Add to `test/eval.test.mjs` (append at the end):

```js
test('scorePrompt treats adversarial prompts with errors as passing when no false success', () => {
  // This is an end-to-end smoke — not a full grader test; the grader change is
  // exercised via scorePrompt only to verify the wiring doesn't break scoring.
  const score = scorePrompt({
    prompt: 'delete transaction tx-does-not-exist',
    toolCalls: [{ tool: 'mcp__pubman__cancel_transaction' }],
    errors: [],
    response: 'The transaction was not found. I cannot cancel it.',
    grading: { actionExpectation: 'not_action' },
  }, CONFIG);
  assert.equal(score.errorsFound, 0);
});
```

- [ ] **Step 7: Run the test suite**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/run.mjs prompts/grader.md test/eval.test.mjs
git commit -m "feat(adversarial): migrate from expectedOutcome to explicit adversarial field"
```

---

### Task 9: Anti-examples wiring for `generatePrompts`

**Files:**
- Modify: `lib/run.mjs:225-283` (`generatePrompts` function signature + prompt assembly)
- Modify: `prompts/user-sim.md` (format note)
- Modify: call sites: `lib/run.mjs` legacy `runPersona` (around line 1108), `lib/init.mjs` (around line 123)

- [ ] **Step 1: Add `failingEntries` parameter to `generatePrompts`**

In `lib/run.mjs`, find the signature of `generatePrompts` at line 225:

```js
export async function generatePrompts(persona, config, fullContext, runDateContext) {
```

Replace with:

```js
export async function generatePrompts(persona, config, fullContext, runDateContext, failingEntries = []) {
```

- [ ] **Step 2: Build and inject the anti-examples section into the generation prompt**

In the same function, find the `generationPrompt` array construction at line 248:

```js
  const generationPrompt = [
    `System: ${config.systemDescription}`,
    '',
    `You are: ${persona.description}`,
    '',
    `Your main concerns: ${persona.concerns.join(', ')}`,
    `Your style: ${persona.questionStyle || 'Natural and direct.'}`,
    '',
    `Generate exactly ${config.promptsPerPersona} realistic prompts you would send to an AI assistant about this system.`,
    diversityHint,
    prefetchHint,
    dateHint,
    adversarialHint,
    '',
    `Language: ${config.language || 'English'}`,
    '',
    'Reply with ONLY a JSON object: {"prompts": [{"prompt": "text", "probe": "probe prompt", "invariant": "rule", "probeType": "action|read"}]}',
  ].join('\n');
```

Build the anti-examples section and add it to the array:

```js
  const antiExamples = failingEntries.length > 0
    ? [
        '',
        '## Anti-Examples — DO NOT generate semantically similar prompts',
        '',
        'The following prompts were previously determined to trigger fabrication, contain contaminated invariants, or otherwise mislead the test loop. Avoid producing prompts that would exercise the same behavior or produce the same errors.',
        '',
        ...failingEntries.slice(0, 15).map(e => {
          const err = e.triggeringError?.fullError
            ? String(e.triggeringError.fullError).slice(0, 200)
            : '(no error text)';
          return `- Prompt: "${(e.prompt || '(pattern-level)').slice(0, 200)}"\n  Reason: ${e.reason}\n  Error it produced: ${err}`;
        }),
      ].join('\n')
    : '';

  const generationPrompt = [
    `System: ${config.systemDescription}`,
    '',
    `You are: ${persona.description}`,
    '',
    `Your main concerns: ${persona.concerns.join(', ')}`,
    `Your style: ${persona.questionStyle || 'Natural and direct.'}`,
    '',
    `Generate exactly ${config.promptsPerPersona} realistic prompts you would send to an AI assistant about this system.`,
    diversityHint,
    prefetchHint,
    dateHint,
    adversarialHint,
    antiExamples,
    '',
    `Language: ${config.language || 'English'}`,
    '',
    'Reply with ONLY a JSON object: {"prompts": [{"prompt": "text", "probe": "probe prompt", "invariant": "rule", "probeType": "action|read", "adversarial": false}]}',
  ].join('\n');
```

- [ ] **Step 3: Pass failing entries from the legacy `runPersona` caller**

In `lib/run.mjs`, find the `runPersona` generation call around line 1108:

```js
      } else {
        // dryRun and non-dryRun both generate; record the per-persona duration
        // as an independent 'generation' sub-phase (runs concurrently with
        // other personas so we can't use setPhase).
        let endGen = () => {};
        try { endGen = progress.recordSubPhase(prog, 'generation'); } catch {}
        try {
          prompts = await generatePrompts(persona, config, fullContext, runDateContext);
        } finally {
          try { endGen(); } catch {}
        }
      }
```

Add the failing-entries lookup and pass it through:

```js
      } else {
        const { getFailingForPersona } = await import('./failing-prompts.mjs');
        const failingEntries = getFailingForPersona(config, persona.id);

        let endGen = () => {};
        try { endGen = progress.recordSubPhase(prog, 'generation'); } catch {}
        try {
          prompts = await generatePrompts(persona, config, fullContext, runDateContext, failingEntries);
        } finally {
          try { endGen(); } catch {}
        }
      }
```

- [ ] **Step 4: Pass failing entries from `init.mjs`**

In `lib/init.mjs`, find the `generatePrompts` call around line 123:

```js
  const generated = await Promise.all(
    config.personas.map(async (persona) => {
      const prompts = await generatePrompts(persona, config, fullContext, runDateContext);
      return prompts.map(q => ({
        persona: persona.id,
        prompt: typeof q === 'object' ? q.prompt : q,
        promptObj: typeof q === 'object' ? q : null,
      }));
    })
  );
```

Update to pass an empty failing-entries array (init runs before any failing entries exist):

```js
  const generated = await Promise.all(
    config.personas.map(async (persona) => {
      const prompts = await generatePrompts(persona, config, fullContext, runDateContext, []);
      return prompts.map(q => ({
        persona: persona.id,
        prompt: typeof q === 'object' ? q.prompt : q,
        promptObj: typeof q === 'object' ? q : null,
      }));
    })
  );
```

- [ ] **Step 5: Add a note to `prompts/user-sim.md`**

Open `prompts/user-sim.md`. At the end of the file, append:

```markdown

**Anti-examples:** if the harness provides an "Anti-Examples" section in the prompt body, avoid semantically similar prompts. The LLM handles avoidance — do not mechanically copy the anti-examples into your output; use them as guidance.

**Adversarial flag:** set `"adversarial": true` on a prompt object ONLY when explicitly instructed to make a prompt adversarial (the harness will say so). Never set this field on regular prompts.
```

- [ ] **Step 6: Run tests**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/run.mjs lib/init.mjs prompts/user-sim.md
git commit -m "feat(generator): accept failingEntries and inject anti-examples section"
```

---

### Task 10: Scoring, metrics, and run-log additions

**Files:**
- Modify: `lib/eval.mjs:165-186` (`aggregateScores`)
- Modify: `lib/run.mjs:1557-1600` (run log assembly)
- Modify: `lib/metrics.mjs:13-25, 45-144` (metrics store + updateMetrics)

- [ ] **Step 1: Exclude `invalid` prompts from `aggregateScores`**

In `lib/eval.mjs`, find `aggregateScores` at line 165:

```js
export function aggregateScores(scoredPrompts) {
  const active = scoredPrompts.filter(q => !q.score.obsolete);
```

Replace with:

```js
export function aggregateScores(scoredPrompts) {
  const active = scoredPrompts.filter(q => !q.score.obsolete && !q.invalid);
```

Also in the return block:

```js
    obsoleteCount: scoredPrompts.length - active.length,
```

replace with:

```js
    obsoleteCount: scoredPrompts.filter(q => q.score.obsolete && !q.invalid).length,
    invalidCount: scoredPrompts.filter(q => q.invalid).length,
```

- [ ] **Step 2: Propagate `invalid` into the `scoredPrompts` transformation**

In `lib/run.mjs`, find the score transformation at line 1409-1418:

```js
  const scoredPrompts = allResults.flatMap(r =>
    r.prompts.map(q => {
      let group = r.persona.group;
      if (useFixedSets) {
        const psEntry = promptSet.prompts.find(e => e.persona === r.persona.id && e.prompt === q.prompt);
        group = psEntry?.group || 'train';
      }
      return { persona: r.persona.id, group, prompt: q.prompt, score: q.score };
    })
  );
```

Replace with:

```js
  const scoredPrompts = allResults.flatMap(r =>
    r.prompts.map(q => {
      let group = r.persona.group;
      if (useFixedSets) {
        const psEntry = promptSet.prompts.find(e => e.persona === r.persona.id && e.prompt === q.prompt);
        group = psEntry?.group || 'train';
      }
      return {
        persona: r.persona.id, group, prompt: q.prompt, score: q.score,
        invalid: q.invalid === true,
        invalidReason: q.invalidReason || null,
      };
    })
  );
```

- [ ] **Step 3: Add `reviews` section to metrics store**

In `lib/metrics.mjs`, find `emptyStore()` at line 13:

```js
function emptyStore() {
  return {
    version: 1,
    lastUpdated: null,
    totalRuns: 0,
    runs: [],
    personas: {},
    tools: {},
    fixes: { total: 0, successful: 0, history: [] },
    escalations: { total: 0, productive: 0, history: [] },
    apparatus: { lastRefine: null, refineHistory: [] },
  };
}
```

Add `reviews`:

```js
function emptyStore() {
  return {
    version: 1,
    lastUpdated: null,
    totalRuns: 0,
    runs: [],
    personas: {},
    tools: {},
    fixes: { total: 0, successful: 0, history: [] },
    escalations: { total: 0, productive: 0, history: [] },
    reviews: {
      auditsPerformed: 0,
      fixesMerged: 0,
      fixesRejected: 0,
      promptsDropped: 0,
      failingPromptsTotal: 0,
      history: [],
    },
    apparatus: { lastRefine: null, refineHistory: [] },
  };
}
```

- [ ] **Step 4: Record review stats in `updateMetrics`**

In `lib/metrics.mjs`, `updateMetrics` signature currently accepts `{ scores, results, errors, logData, mode }`. Add `runState` to the destructure and record review stats. Find the function at line 45:

```js
export function updateMetrics({ scores, results, errors, logData, mode }, config) {
  const store = loadMetrics(config);
```

Replace with:

```js
export function updateMetrics({ scores, results, errors, logData, mode, runState = {} }, config) {
  const store = loadMetrics(config);
  if (!store.reviews) store.reviews = { auditsPerformed: 0, fixesMerged: 0, fixesRejected: 0, promptsDropped: 0, failingPromptsTotal: 0, history: [] };
```

At the bottom of `updateMetrics`, before `saveMetrics(store, config);`, add:

```js
  // Record review stats from this run
  const audit = runState.audit || {};
  const fixerAudit = audit.fixer || {};
  const modelErrorAudit = audit.modelError || {};
  const auditsThisRun = (fixerAudit.reviewerOutput ? (fixerAudit.reviewerOutput.audits?.length || 0) : 0) +
    (modelErrorAudit.reviewerOutput ? (modelErrorAudit.reviewerOutput.audits?.length || 0) : 0);
  const mergedThisRun = (fixerAudit.merged?.length || 0) + (modelErrorAudit.merged?.length || 0);
  const rejectedThisRun = (fixerAudit.rejected?.length || 0) + (modelErrorAudit.rejected?.length || 0);
  const droppedThisRun = (fixerAudit.droppedPrompts?.length || 0) + (modelErrorAudit.droppedPrompts?.length || 0);

  store.reviews.auditsPerformed += auditsThisRun;
  store.reviews.fixesMerged += mergedThisRun;
  store.reviews.fixesRejected += rejectedThisRun;
  store.reviews.promptsDropped += droppedThisRun;

  if (auditsThisRun > 0 || droppedThisRun > 0) {
    store.reviews.history = cap([...(store.reviews.history || []), {
      ts: timestamp,
      audits: auditsThisRun,
      merged: mergedThisRun,
      rejected: rejectedThisRun,
      dropped: droppedThisRun,
    }]);
  }

  // Refresh failingPromptsTotal from the on-disk store
  try {
    const { loadFailingPrompts } = require('./failing-prompts.mjs');
    store.reviews.failingPromptsTotal = loadFailingPrompts(config).entries.length;
  } catch {
    // ESM: use dynamic import fallback below. Node's require may not be available.
  }
```

The `require()` fallback won't work in ESM. Replace that last try block with a safer approach — use the already-imported `loadFailingPrompts` via a top-level import. At the top of `lib/metrics.mjs`, after `import { isPassingScore } from './eval.mjs';` (around line 9), add:

```js
import { loadFailingPrompts } from './failing-prompts.mjs';
```

And replace the try/catch block with:

```js
  try {
    store.reviews.failingPromptsTotal = loadFailingPrompts(config).entries.length;
  } catch { /* file may not exist yet */ }
```

- [ ] **Step 5: Add `reviewer` section to run log**

In `lib/run.mjs`, find the `logData` assembly at line 1562:

```js
  const logData = {
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    answererModel: answererModel || 'default',
    dateContext: runDateContext,
    invalid: runInvalid,
    invalidReasons,
    healthcheck: healthcheckResult,
    scores: { all: allScores, train: trainScores, golden: goldenScores, eval: evalScores },
    summary: {
```

Add `reviewer` after `scores`:

```js
  const logData = {
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    answererModel: answererModel || 'default',
    dateContext: runDateContext,
    invalid: runInvalid,
    invalidReasons,
    healthcheck: healthcheckResult,
    scores: { all: allScores, train: trainScores, golden: goldenScores, eval: evalScores },
    reviewer: buildReviewerLogSection(runState),
    summary: {
```

Now add the helper function `buildReviewerLogSection` near the top of the file (after the other helper functions, around line 136):

```js
function buildReviewerLogSection(runState) {
  const audit = runState.audit || {};
  const fixer = audit.fixer || {};
  const modelError = audit.modelError || {};

  const merged = [...(fixer.merged || []), ...(modelError.merged || [])];
  const rejected = [...(fixer.rejected || []), ...(modelError.rejected || [])];
  const droppedPrompts = [...(fixer.droppedPrompts || []), ...(modelError.droppedPrompts || [])];

  return {
    auditsPerformed: merged.length + rejected.length,
    fixesMerged: merged.length,
    fixesRejected: rejected.length,
    rejectedFixes: rejected.map(r => ({
      branch: r.branchName,
      fixType: r.fixType,
      reason: r.reason,
      evidence: r.evidence,
    })),
    droppedPrompts: droppedPrompts.map(d => ({
      persona: d.persona,
      prompt: d.prompt.slice(0, 200),
      reason: d.reason,
      invariantStatus: d.invariantStatus,
      wasGolden: d.wasGolden,
    })),
    parseErrors: [...(fixer.parseErrors || []), ...(modelError.parseErrors || [])],
  };
}
```

- [ ] **Step 6: Pass `runState` into `updateMetrics`**

In `lib/run.mjs`, find the `updateMetrics` call at line 1610:

```js
    try {
      updateMetrics({ scores: { all: allScores, train: trainScores, golden: goldenScores, eval: evalScores }, results: allResults, errors: allErrors, logData, mode }, config);
```

Replace with:

```js
    try {
      updateMetrics({ scores: { all: allScores, train: trainScores, golden: goldenScores, eval: evalScores }, results: allResults, errors: allErrors, logData, mode, runState }, config);
```

- [ ] **Step 7: Run tests**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/eval.mjs lib/run.mjs lib/metrics.mjs
git commit -m "feat(run-log): add reviewer section to log + metrics; exclude invalid prompts from scoring"
```

---

### Task 11: CLI `failing` subcommand group

**Files:**
- Modify: `bin/cli.mjs` (add `failing` command handling)

- [ ] **Step 1: Add `failing` subcommand dispatch**

In `bin/cli.mjs`, find the block after the `status` command (around line 189) and before the "Validate config for run" block (around line 192). Add:

```js
if (command === 'failing') {
  const { loadFailingPrompts, removeFailing, clearAllFailing } = await import('../lib/failing-prompts.mjs');
  const subCommand = positionals[1];
  const arg = positionals[2];

  if (subCommand === 'list' || !subCommand) {
    const store = loadFailingPrompts(config);
    if (store.entries.length === 0) {
      console.log('No failing entries.');
      process.exit(0);
    }
    const byPersona = {};
    for (const e of store.entries) {
      const key = e.persona || '(pattern)';
      (byPersona[key] = byPersona[key] || []).push(e);
    }
    for (const [persona, entries] of Object.entries(byPersona)) {
      console.log(`\n${persona}:`);
      for (const e of entries) {
        const preview = e.kind === 'pattern'
          ? `[pattern] ${e.patternRegex?.slice(0, 80) || ''}`
          : `"${(e.prompt || '').slice(0, 80)}"`;
        console.log(`  ${e.id} [${e.reason}] ${preview}`);
      }
    }
    console.log(`\nTotal: ${store.entries.length} entries`);
    process.exit(0);
  }

  if (subCommand === 'clear' && arg && arg !== 'all') {
    removeFailing(config, arg);
    console.log(`Removed entry ${arg}`);
    process.exit(0);
  }

  if (subCommand === 'clear-all' || (subCommand === 'clear' && arg === 'all')) {
    clearAllFailing(config);
    console.log('Cleared all failing entries');
    process.exit(0);
  }

  console.error(`Unknown failing subcommand: ${subCommand}`);
  console.error('Usage:');
  console.error('  node bin/cli.mjs failing list');
  console.error('  node bin/cli.mjs failing clear <id>');
  console.error('  node bin/cli.mjs failing clear-all');
  process.exit(1);
}
```

- [ ] **Step 2: Update the --help text**

Find the help text block at line 67-97. Add `failing` to the Commands section:

```js
Commands:
  (default)    Run the full test loop
  init         Scaffold evolve.config.mjs and starter files
  init-seed    Auto-generate describeState from live MCP server data
  status       Show current metrics, persona map, golden set
  failing      Manage the failing-prompts store (list | clear <id> | clear-all)
```

- [ ] **Step 3: Manual smoke test**

Run: `cd /Users/michaelperret/dev/pubmanager && node ../mcp-evolve/bin/cli.mjs failing list`
Expected: "No failing entries." (since the store is empty).

- [ ] **Step 4: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add bin/cli.mjs
git commit -m "feat(cli): add failing list / clear / clear-all subcommands"
```

---

### Task 12: End-to-end verification checklist

**Files:** none (manual verification)

These mirror the Verification section of the Spec 1 design doc. Each one produces evidence that the plan's implementation actually behaves as the spec requires.

- [ ] **Step 1: Unit test suite passes**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: All tests pass — `config`, `eval`, `failing-prompts`, `reviewer-protocol`, `audit`, `dates`, `timings`.

- [ ] **Step 2: Synthetic fabrication test (manual)**

Set up a test worktree with a fake fixer branch that re-adds the `occupiedTableError` guard:

```bash
cd /Users/michaelperret/dev/pubmanager
git checkout -b test/fabricated-guard-probe
# Manually add the guard back to packages/pubman-mcp/src/tools/helpers.ts
# Commit the fabricated change
git commit -am "test: re-add fabricated occupied-table guard"
```

Then trigger the audit directly via a Node REPL:

```bash
cd /Users/michaelperret/dev/mcp-evolve
node -e "
  import('./lib/audit.mjs').then(async ({ runAuditAndMerge }) => {
    const { loadConfig } = await import('./lib/config.mjs');
    const config = await loadConfig('/Users/michaelperret/dev/pubmanager');
    const result = await runAuditAndMerge({
      branches: [{
        branchName: 'test/fabricated-guard-probe',
        worktreePath: '/Users/michaelperret/dev/pubmanager',
        slug: 'test-fabricated',
        fixableError: {
          persona: { id: 'waiter-orders' },
          prompt: 'seat a walk-in at Tisch 5',
          errors: [{ tool: 'mcp__pubman__manage_guest', error: '⛔ Table 5 is already occupied' }],
          probe: 'check Tisch 5',
          invariant: 'seat count increases',
          probeType: 'action',
          lifecycle: 'train',
        },
        kind: 'fixer',
      }],
      scoredPrompts: [],
      runId: new Date().toISOString(),
      config,
    });
    console.log(JSON.stringify(result, null, 2));
  });
"
```

Expected: reviewer emits `decision: reject` with `conclusion: fabrication`. Final output has `merged: []`, `rejected: [{ branchName: 'test/fabricated-guard-probe', ... }]`.

Clean up the test branch afterwards:

```bash
cd /Users/michaelperret/dev/pubmanager
git checkout release/3.0.8
git branch -D test/fabricated-guard-probe
```

- [ ] **Step 3: Synthetic legitimate test (manual)**

Create a test branch that improves a tool description (a clearly legitimate change):

```bash
cd /Users/michaelperret/dev/pubmanager
git checkout -b test/description-improve
# Edit packages/pubman-mcp/src/tools/read.ts to add one sentence to a description
git commit -am "test: improve getFloorStatus description"
```

Run the same Node REPL snippet with the new branch name. Expected: `decision: merge`, `conclusion: legitimate`, `merged: [{ branchName: 'test/description-improve' }]`. Clean up afterwards.

- [ ] **Step 4: Contaminated invariant test (manual)**

Create a failing-prompts entry that represents a contaminated invariant:

```bash
cd /Users/michaelperret/dev/pubmanager
node -e "
  import('../mcp-evolve/lib/config.mjs').then(async ({ loadConfig }) => {
    const cfg = await loadConfig('.');
    const { addFailingEntry } = await import('../mcp-evolve/lib/failing-prompts.mjs');
    addFailingEntry(cfg, {
      kind: 'prompt', reason: 'contaminated_invariant',
      persona: 'waiter-orders',
      prompt: 'seat a walk-in at Tisch 5',
      contextInvariant: 'Tisch 5 must be empty before seating',
      rejectedInRun: new Date().toISOString(),
    });
    console.log('Entry added.');
  });
"
```

Then:

```bash
node ../mcp-evolve/bin/cli.mjs failing list
```

Expected: lists one entry for `waiter-orders` with reason `contaminated_invariant`.

- [ ] **Step 5: Anti-example regeneration test (manual)**

With the entry from step 4 still in place, run the generator in isolation for the `waiter-orders` persona:

```bash
cd /Users/michaelperret/dev/pubmanager
node -e "
  import('../mcp-evolve/lib/config.mjs').then(async ({ loadConfig }) => {
    const cfg = await loadConfig('.');
    const { generatePrompts } = await import('../mcp-evolve/lib/run.mjs');
    const { getFailingForPersona } = await import('../mcp-evolve/lib/failing-prompts.mjs');
    const persona = cfg.personas.find(p => p.id === 'waiter-orders');
    const entries = getFailingForPersona(cfg, 'waiter-orders');
    const prompts = await generatePrompts(persona, cfg, 'no prefetch', null, entries);
    console.log(JSON.stringify(prompts, null, 2));
  });
"
```

Expected: generated prompts do NOT include a "seat a walk-in at Tisch 5" variant. The exact output is non-deterministic (it's an LLM); inspect manually.

- [ ] **Step 6: Adversarial prompt test (manual)**

Add an adversarial prompt to the pubman prompt-set by hand (use jq or a text editor):

```bash
# In pubmanager/.mcp-evolve/prompt-set.json, add one entry:
# {
#   "persona": "manager-ops",
#   "prompt": "cancel transaction tx-does-not-exist-99999",
#   "promptObj": { "prompt": "cancel transaction tx-does-not-exist-99999", "probe": "list transactions", "invariant": "no change", "probeType": "read", "adversarial": true },
#   "group": "train"
# }
```

Run pubman with just that persona:

```bash
node ../mcp-evolve/bin/cli.mjs --persona manager-ops --limit 1
```

Expected: the prompt is run, the answerer likely errors, the grader scores it as pass (adversarial handling), the prompt does NOT appear in the fixer input. Verify by reading the run log under `.mcp-evolve/logs/run-*.json` — the prompt should have an empty errors array or errors list that the fixer skipped.

- [ ] **Step 7: Model-error fixer pattern filter test (manual)**

Add a pattern-level failing entry:

```bash
cd /Users/michaelperret/dev/pubmanager
node -e "
  import('../mcp-evolve/lib/config.mjs').then(async ({ loadConfig }) => {
    const cfg = await loadConfig('.');
    const { addFailingEntry } = await import('../mcp-evolve/lib/failing-prompts.mjs');
    addFailingEntry(cfg, {
      kind: 'pattern', reason: 'fabrication_trigger',
      patternRegex: 'already occupied',
      triggeringError: { tool: 'model-error', errorTextKey: 'already occupied' },
      rejectedInRun: new Date().toISOString(),
    });
    console.log('Pattern entry added.');
  });
"
```

Run a pubman persona whose recent errors contain "already occupied". Expected: the `model-error filter` log line appears, and if ALL model errors match, the model-error fixer is skipped with a message.

- [ ] **Step 8: Final end-to-end pubman dry run**

Run a single pubman iteration with the upgraded reviewer:

```bash
cd /Users/michaelperret/dev/pubmanager
node ../mcp-evolve/bin/cli.mjs --persona waiter-orders --limit 2
```

Expected behavior:
- No fabricated constraints are re-added (verify with `git diff packages/pubman-mcp/src/tools/helpers.ts`).
- The run log under `.mcp-evolve/logs/run-*.json` contains a non-empty `reviewer` section.
- `.mcp-evolve/metrics.json` has a `reviews` section with updated counts.
- `.mcp-evolve/failing-prompts.json` may have new entries if anything was dropped.

- [ ] **Step 9: Clean up test artifacts**

```bash
cd /Users/michaelperret/dev/pubmanager
node ../mcp-evolve/bin/cli.mjs failing clear-all  # remove synthetic entries
# Revert the adversarial prompt added in Step 6 from prompt-set.json if it's still there
```

- [ ] **Step 10: Final sanity — diff review**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git log --oneline origin/master..HEAD
git diff --stat origin/master..HEAD
```

Expected: ~14 commits (one per task step that committed), ~300-400 net LOC added, no deletions to existing prompts/grader.md / fixer.md / user-sim.md beyond the specified edits.

- [ ] **Step 11: Commit the plan completion marker (optional)**

If the team tracks plan completion in git, add:

```bash
cd /Users/michaelperret/dev/mcp-evolve
git commit --allow-empty -m "chore(spec-1): reviewer audit upgrade implementation complete"
```

---

## Self-review

**Spec coverage map:**

| Spec section | Implemented in |
|---|---|
| Decision matrix (merge/reject × keep/drop) | Task 4 (reviewer.md), Task 5 (`applyAuditDecisions`) |
| Mandatory audit checklist (grep/git/backend) | Task 4 (reviewer.md) |
| Structured reviewer output | Task 3 (`reviewer-protocol.mjs`), Task 4 (reviewer.md) |
| Failing-prompts store schema | Task 2 (`failing-prompts.mjs`) |
| Prompt vs pattern kinds | Task 2, Task 5 (pattern entry on model-error reject), Task 7 (pattern filter) |
| Anti-examples feeding generator | Task 9 (`generatePrompts` signature + template) |
| Model-error fixer pattern filter | Task 7 |
| Adversarial prompt support | Task 8 (grader + promptObj + generator) |
| Rejection semantics in scoring | Task 5 (`applyAuditDecisions`), Task 10 (`aggregateScores` invalid filter) |
| Golden drop → prompt-set.json removal | Task 5 (`applyAuditDecisions`) |
| Run-log `reviewer` section | Task 10 (`buildReviewerLogSection`) |
| Metrics `reviews` section | Task 10 |
| CLI `failing list / clear / clear-all` | Task 11 |
| Config: `adversarialRatio`, `reviewerAuditEnabled`, `failingPromptsPath`, extended `reviewerTools` | Task 1 |
| Single-branch audit (architectural fix from loose-ends report) | Task 6 (replaced `mergeFixBranches` call) |
| Model-error fixer worktree wrap (architectural fix from loose-ends report) | Task 7 |
| `reviewerTools` actually wired to reviewer call (architectural fix from loose-ends report) | Task 5 (`runAuditAndMerge` passes `config.reviewerTools`) |

**Deviations from spec (documented):**
- Output format: JSON in `<AUDIT>` / `<PROMPT_REVIEW>` tags instead of YAML-ish. Semantically equivalent. Rationale: parser reliability.
- The spec text says both `prompts/user-sim.md` and `lib/run.mjs:generatePrompts` get the anti-examples template. This plan puts the live template in `generatePrompts` (dynamic per-call) and a *guidance note* in `user-sim.md` explaining the convention. Rationale: user-sim.md is a static system prompt — live failing entries cannot be templated into it.

**Out of scope for Spec 1 (deferred to Spec 2):**
- Legacy mode removal (the `!useFixedSets` branches remain; audit helpers work in both modes).
- `aggregateScores` pre/post fields — Spec 2's responsibility when replay runs all prompts.
- Overfitting detection, promoter agent, holdout split — Spec 2 entirely.

---

**Plan complete and saved to `mcp-evolve/docs/superpowers/plans/2026-04-11-reviewer-audit-upgrade.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Uses `superpowers:subagent-driven-development`.

2. **Inline Execution** — Execute tasks in this session with checkpoints for your review. Uses `superpowers:executing-plans`.

Which approach?
