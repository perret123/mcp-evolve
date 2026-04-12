# Train / Eval / Golden Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the silent per-persona `group` field with two orthogonal per-prompt fields (`lifecycle: train|golden`, `evaluation: fixer|holdout`); generate fresh train+holdout per run with deterministic in-batch split; score pre-fix and post-fix on every tier; detect overfitting when train improves while holdout regresses; add a Promoter-Agent that nominates passing train prompts for graduation to golden. Delete the entire legacy mode (`!useFixedSets` branches, streak-based graduation, goldenBlockThreshold, createPromptSet, updatePromptSetAfterRun, updateGoldenHealth, promoteToGoldenSet, addTrainPrompts, getPromptsByGroup, loadGoldenSet, getGoldenPrompts, `--train`/`--eval` CLI flags, `persona.group`). Wipe `prompt-set.json` via a fresh `init` (no backup logic in code — git history / existing archive is the backup).

**Architecture:** Additive scaffolding (config, helpers, promoter module) lands first in isolation-safe tasks. A single destructive-cut task (Task 6) removes all legacy code and prepares a clean substrate. The new generation + scoring + promoter flow then lands in-order in Tasks 7–10. Metrics/log plumbing and E2E verification finish the plan. The promoter follows the Spec 1 pattern: `applyPromoterDecisions` (pure, unit-testable) + `runPromoter` (async LLM wrapper). `runState.promoter` and `runState.overfitting` are added as peers of the existing `runState.audit`. Reviewer output parsing gets factored into `lib/tagged-json.mjs` so the promoter protocol can reuse `extractTagged`.

**Tech Stack:** Node.js ESM, `node:test`, Claude CLI (sonnet reviewer + sonnet promoter, configurable), `node:crypto` (hashing + RNG seeding), existing mcp-evolve pipeline built in Spec 1 (`lib/audit.mjs`, `lib/failing-prompts.mjs`, `lib/reviewer-protocol.mjs`).

**Scope boundaries:**
- This plan implements Spec 2 in full. After it lands, Round 10 can start.
- The plan preserves every Spec 1 safety invariant: `failing-prompts.json` is never wiped; `reviewerAuditEnabled` stays on; the `adversarial: true` signal still flows from generator → grader → fixer-input filter → promoter-filter; `runState.audit` structure is unchanged.
- Task 6 is the destructive cut. Tests may temporarily fail mid-task; they're restored by the end of Task 6 (test files referencing deleted functions are updated in the same task).
- The `examples/task-manager/` example's `.mcp-evolve/prompt-set.json` is deleted in Task 12; a README note tells users to run `node bin/cli.mjs init` to re-scaffold after Spec 2 lands.

**Baseline before starting:** 45 tests passing across 6 files (`audit.test.mjs` 5, `config.test.mjs` 1, `eval.test.mjs` 6, `failing-prompts.test.mjs` 9, `reviewer-protocol.test.mjs` 11, `timings.test.mjs` 13). HEAD at `7d8971d docs(learnings): add Spec 1 implementation notes and Spec 2 kickoff prompt`. `git status` clean.

---

## File Structure

**New modules:**
- `lib/tagged-json.mjs` — shared `extractTagged(text, tag)` helper factored from `reviewer-protocol.mjs`. Used by both the reviewer-protocol parser and the new promoter-protocol parser.
- `lib/promoter-protocol.mjs` — parses `<NOMINATIONS>` + `<SKIPPED>` tagged-JSON blocks, validates enum values and structural shape. Mirrors `reviewer-protocol.mjs`.
- `lib/promoter.mjs` — `applyPromoterDecisions` (pure, sync, deterministic) + `runPromoter` (async wrapper around the Claude CLI call). Mirrors the `lib/audit.mjs` pattern from Spec 1.
- `prompts/promoter.md` — system prompt for the Promoter-Agent LLM. Describes the nomination criteria, the failing-prompts filter, the contamination sanity check, and the `<NOMINATIONS>` + `<SKIPPED>` output format.

**New test files:**
- `test/tagged-json.test.mjs` — unit tests for `extractTagged`.
- `test/promoter-protocol.test.mjs` — unit tests for `parsePromoterOutput` + `validatePromoterOutput`.
- `test/promoter.test.mjs` — unit tests for `applyPromoterDecisions` (pure path, no live Claude CLI).
- `test/split-for-holdout.test.mjs` — unit tests for the deterministic in-batch split helper.

**Modified files:**
- `lib/config.mjs` — add `holdoutPerPersona`, `overfittingThreshold`, `maxPromotionsPerRun`, `promoterModel`, `promoterPromptFile`, `promoterTimeout`. Delete `graduationStreak`, `goldenBlockThreshold`, `maxTrainPerRun`, `maxGoldenPerRun`. Add sanity check for `holdoutPerPersona < promptsPerPersona`. Emit a warning at load time if any persona still has a `group` field.
- `lib/eval.mjs` — add `aggregateScores(scoredPrompts, scoreField = 'score')` optional parameter; add `splitForHoldout(prompts, K, seed)` helper with seeded PRNG (`mulberry32` + `hashString`); add `overfittingDetection` pure function; add `addGoldenFromPromotion` helper. Update `saveBaseline` + `loadBaseline` to v2 schema (`scorePre` + `scorePost` + `version: 2` + per-prompt `lifecycle` + `evaluation`, with v1-compat normalization). Update `checkStreak` to only count golden-lifecycle prompts. Update `loadPromptSet` to reject v1 files (any prompt lacking `lifecycle`). **Delete:** `createPromptSet`, `updatePromptSetAfterRun`, `updateGoldenHealth`, `addTrainPrompts`, `getPromptsByGroup`, `loadGoldenSet`, `promoteToGoldenSet`, `getGoldenPrompts`. Remove `persona.group` reference from `saveBaseline`.
- `lib/reviewer-protocol.mjs` — remove the local `extractTagged` helper, import from `lib/tagged-json.mjs` instead.
- `lib/audit.mjs` — update `wasGolden` + golden-removal checks to use `lifecycle === 'golden'` instead of `group === 'golden'`.
- `lib/metrics.mjs` — add `promotions` and `overfittingEvents` sections to `emptyStore()`. Record promoter + overfitting stats in `updateMetrics` from `runState.promoter` and `runState.overfitting`.
- `lib/personas.mjs` — delete `getPersonasByGroup` function.
- `lib/run.mjs` — the main surgery:
  - Delete the legacy mode block (the entire `else` branch starting at line 1139).
  - Delete the legacy `globalGoldenHealthy` + `goldenSet` loading block.
  - Delete the legacy golden-set update + autodev block (lines 1625–1662).
  - Delete legacy obsolete-prompt removal, legacy graduation, legacy escalation add-train-prompts.
  - Delete `--train`/`--eval` gating via `getPersonasByGroup`.
  - Delete imports of removed functions.
  - Remove the `useFixedSets` variable — prompt-set mode is the only mode.
  - Replace `persona.group` derivations with `promptObj.lifecycle` + `promptObj.evaluation`.
  - Add new generation phase (loads golden, generates train, splits holdout).
  - Add pre-fix scoring (populate `scorePre` on every scored prompt).
  - Expand replay phase to re-run ALL prompts including holdout.
  - Add post-fix scoring (`scorePost`) + new aggregation buckets (`trainPre`, `trainPost`, `holdoutPre`, `holdoutPost`, `goldenPre`, `goldenPost`).
  - Add overfitting detection block.
  - Add Promoter-Agent invocation block.
  - Thread `runState.promoter` + `runState.overfitting` through the log + metrics.
- `lib/init.mjs` — remove prompt generation at init time. `fullInit` now just scaffolds config + writes `{version: 2, prompts: []}` to `prompt-set.json`. Delete the `createPromptSet` call at line 139.
- `lib/autodev.mjs` — replace `bq.group || 'train'` with just `bq.persona` (and rename `role` field to `'user'` literal). Auto-dev still exists; it's only invoked from the promoter path now (not legacy golden-set).
- `bin/cli.mjs` — delete `--train` and `--eval` flags + their help text. Update `status` command: remove legacy golden-set fallback (`loadGoldenSet`), remove `graduationStreak` reference, update per-prompt display to show `lifecycle` + `evaluation` instead of `group`.
- `prompts/user-sim.md` — add a short note about the `lifecycle`/`evaluation` fields being set by the harness (not the generator).
- `test/config.test.mjs` — add assertions for the new fields.
- `test/eval.test.mjs` — add coverage for `aggregateScores(scored, scoreField)`, `splitForHoldout`, `overfittingDetection`, baseline v1-compat. Update existing tests to use the new scored-prompt shape where they reference `group`.
- `test/audit.test.mjs` — update fixtures that use `group: 'golden'` to use `lifecycle: 'golden'` + write `prompt-set.json` fixtures in the new schema.

**Deleted content (by code-path, not file):**
- Legacy golden set code (`loadGoldenSet`, `promoteToGoldenSet`, `getGoldenPrompts`, `updateGoldenHealth`, `goldenSet` local in `run.mjs`, `.mcp-evolve/golden-set.json` producer).
- Streak-based graduation (`createPromptSet`, `updatePromptSetAfterRun`, `graduationStreak`, `consecutivePasses` bump on pass in the legacy path).
- `addTrainPrompts` persistence path — escalation output now injects into the current run's `promptsToRun` instead.
- `getPersonasByGroup`, `--train`, `--eval`.
- `persona.group` field reads (9 locations in `lib/` + test fixtures).

**Files touched but not listed above — verify during self-review:** `lib/compete.mjs` (no direct persona.group reads — uses its own `groupName`); `lib/knowledge.mjs` (no persona.group — `groupName` is competition-specific); `lib/claude.mjs`, `lib/llm.mjs`, `lib/progress.mjs`, `lib/personas.mjs` (only `getPersonasByGroup` removed from personas.mjs).

---

### Task 1: Config scaffolding

**Files:**
- Modify: `lib/config.mjs:24-28` (reviewerTools already has Bash from Spec 1 — confirm)
- Modify: `lib/config.mjs:184` (delete `graduationStreak`)
- Modify: `lib/config.mjs:190` (delete `goldenBlockThreshold`)
- Modify: `lib/config.mjs:193,196` (delete `maxTrainPerRun`, `maxGoldenPerRun`)
- Modify: `lib/config.mjs:33-34` (context — `promptsPerPersona: 3` already exists)
- Modify: `lib/config.mjs:288-319` (add sanity check + warning in `loadConfig` + `validateConfig`)
- Modify: `test/config.test.mjs` (add assertions)

- [ ] **Step 1: Add the six new config fields to `DEFAULTS`**

In `lib/config.mjs`, find the block around lines 175–197 (Init & prompt set configuration + Escalation). Delete:

```js
  /** Consecutive passes before a train prompt graduates to golden */
  graduationStreak: 10,

  /** Minimum model errors in a run before model-error fixer fires */
  modelErrorThreshold: 3,

  /** Consecutive failures before a golden prompt is blocked for /dev */
  goldenBlockThreshold: 3,

  /** Max train questions to sample per run (null = run all) */
  maxTrainPerRun: null,

  /** Max golden questions to sample per run (null = run all) */
  maxGoldenPerRun: null,
```

Replace with (keep `modelErrorThreshold`, it's still used by Spec 1's model-error path):

```js
  /** Minimum model errors in a run before model-error fixer fires */
  modelErrorThreshold: 3,

  /** Holdout prompts per persona (K). Must be strictly less than promptsPerPersona. */
  holdoutPerPersona: 1,

  /** Overfitting threshold — `train_post - train_pre > X` AND `holdout_post - holdout_pre < -X` → overfittingDetected. */
  overfittingThreshold: 0.1,

  /** Max promoter nominations per run. */
  maxPromotionsPerRun: 3,

  /** Model for the Promoter-Agent */
  promoterModel: 'sonnet',

  /** File name in `prompts/` that holds the promoter system prompt */
  promoterPromptFile: 'promoter.md',

  /** Timeout (ms) for the promoter LLM call */
  promoterTimeout: 180_000,
```

- [ ] **Step 2: Add sanity check in `loadConfig`**

Find `loadConfig` at line 255. After the path resolution block (after line 285 — `merged.promptsDir = new URL(...)...`), add:

```js
  // Sanity check — holdoutPerPersona must be strictly less than promptsPerPersona
  if (merged.holdoutPerPersona >= merged.promptsPerPersona) {
    throw new Error(
      `Invalid config: holdoutPerPersona (${merged.holdoutPerPersona}) must be strictly less than promptsPerPersona (${merged.promptsPerPersona}).`
    );
  }

  // Warn if any persona still declares a `group` field (removed in Spec 2).
  for (const p of merged.personas || []) {
    if (p && typeof p === 'object' && 'group' in p) {
      console.warn(`[config] Persona "${p.id}" has a "group" field — this field is ignored in Spec 2. Remove it from evolve.config.mjs.`);
    }
  }

  return merged;
```

(The existing `return merged;` line is replaced by the block above.)

- [ ] **Step 3: Update `test/config.test.mjs` to cover the new fields**

Open `test/config.test.mjs`. The current file has one test. Add two more tests after it:

```js
test('loadConfig sets Spec 2 defaults (holdoutPerPersona, overfittingThreshold, maxPromotionsPerRun, promoterModel)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'evolve-config-'));
  try {
    writeFileSync(join(tmp, 'evolve.config.mjs'),
      'export default { personas: [], writeTools: ["x"], srcDirs: ["./x"] };');
    const cfg = await loadConfig(tmp, join(tmp, 'evolve.config.mjs'));
    assert.equal(cfg.holdoutPerPersona, 1);
    assert.equal(cfg.overfittingThreshold, 0.1);
    assert.equal(cfg.maxPromotionsPerRun, 3);
    assert.equal(cfg.promoterModel, 'sonnet');
    assert.equal(cfg.promoterPromptFile, 'promoter.md');
    assert.equal(typeof cfg.promoterTimeout, 'number');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig throws when holdoutPerPersona >= promptsPerPersona', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'evolve-config-'));
  try {
    writeFileSync(join(tmp, 'evolve.config.mjs'),
      'export default { personas: [], writeTools: ["x"], srcDirs: ["./x"], promptsPerPersona: 3, holdoutPerPersona: 3 };');
    await assert.rejects(
      () => loadConfig(tmp, join(tmp, 'evolve.config.mjs')),
      /holdoutPerPersona.*must be strictly less than promptsPerPersona/
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

Also update the existing test to also assert the older fields are GONE — add these lines at the end of the existing `'loadConfig sets reviewerAuditEnabled default true'` test, before the `rmSync`:

```js
    // Spec 2: obsolete fields must be absent from defaults
    assert.equal(cfg.graduationStreak, undefined);
    assert.equal(cfg.goldenBlockThreshold, undefined);
    assert.equal(cfg.maxTrainPerRun, undefined);
    assert.equal(cfg.maxGoldenPerRun, undefined);
```

- [ ] **Step 4: Run the config tests**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/config.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS. Test count now 47 (was 45; +2 new config tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/config.mjs test/config.test.mjs
git commit -m "feat(config): Spec 2 fields (holdoutPerPersona, overfittingThreshold, maxPromotionsPerRun, promoter*); remove graduationStreak, goldenBlockThreshold, maxTrain/GoldenPerRun"
```

---

### Task 2: Shared tagged-JSON helper

**Files:**
- Create: `lib/tagged-json.mjs`
- Create: `test/tagged-json.test.mjs`
- Modify: `lib/reviewer-protocol.mjs:28-32` (delete local `extractTagged`, import from new module)

- [ ] **Step 1: Write the failing test for `extractTagged`**

Create `test/tagged-json.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTagged } from '../lib/tagged-json.mjs';

test('extractTagged pulls content between matching tags', () => {
  const text = 'preamble\n<FOO>\n{"a": 1}\n</FOO>\npostamble';
  assert.equal(extractTagged(text, 'FOO'), '{"a": 1}');
});

test('extractTagged returns null when tag is missing', () => {
  assert.equal(extractTagged('no tags here', 'FOO'), null);
});

test('extractTagged is case-insensitive on the tag name', () => {
  assert.equal(extractTagged('<foo>bar</foo>', 'FOO'), 'bar');
  assert.equal(extractTagged('<FOO>bar</FOO>', 'foo'), 'bar');
});

test('extractTagged handles multiline content with newlines and embedded JSON', () => {
  const text = '<BAR>\n[\n  { "k": "v" },\n  { "k": "w" }\n]\n</BAR>';
  const inner = extractTagged(text, 'BAR');
  assert.ok(inner);
  const parsed = JSON.parse(inner);
  assert.equal(parsed.length, 2);
});

test('extractTagged returns null when input is not a string', () => {
  assert.equal(extractTagged(null, 'FOO'), null);
  assert.equal(extractTagged(undefined, 'FOO'), null);
  assert.equal(extractTagged(123, 'FOO'), null);
});

test('extractTagged trims whitespace inside the tag', () => {
  assert.equal(extractTagged('<X>   hello world   </X>', 'X'), 'hello world');
});
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/tagged-json.test.mjs`
Expected: FAIL with `Cannot find module '.../lib/tagged-json.mjs'`.

- [ ] **Step 3: Implement `lib/tagged-json.mjs`**

Create `lib/tagged-json.mjs`:

```js
/**
 * mcp-evolve — Shared tagged-JSON extraction helper.
 *
 * Used by both `reviewer-protocol.mjs` (Spec 1) and `promoter-protocol.mjs`
 * (Spec 2) to pull JSON blocks out of LLM responses wrapped in arbitrary
 * tags like `<AUDIT>`, `<PROMPT_REVIEW>`, `<NOMINATIONS>`, `<SKIPPED>`.
 *
 * Case-insensitive on the tag name. Content is trimmed. Never throws.
 */

/**
 * Extract the content between `<tag>` and `</tag>` (case-insensitive).
 * Returns the trimmed inner string, or null if the tag is not found
 * or the input is not a string.
 *
 * @param {string} text
 * @param {string} tag
 * @returns {string | null}
 */
export function extractTagged(text, tag) {
  if (typeof text !== 'string') return null;
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const match = text.match(re);
  return match ? match[1].trim() : null;
}
```

- [ ] **Step 4: Run the tagged-json tests to confirm pass**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/tagged-json.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Update `lib/reviewer-protocol.mjs` to import from the new module**

In `lib/reviewer-protocol.mjs`, delete lines 28–32 (the local `extractTagged` function):

```js
function extractTagged(text, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const match = text.match(re);
  return match ? match[1].trim() : null;
}
```

Add an import at the top of the file (after line 17, the enum set declarations can stay where they are — the import goes right below the top-level block comment):

Find:
```js
 *   <PROMPT_REVIEW>
 *   [ { promptId, persona, invariantStatus, decision, reason }, ... ]
 *   </PROMPT_REVIEW>
 */

const VALID_FIX_TYPES = new Set([
```

Replace with:
```js
 *   <PROMPT_REVIEW>
 *   [ { promptId, persona, invariantStatus, decision, reason }, ... ]
 *   </PROMPT_REVIEW>
 */

import { extractTagged } from './tagged-json.mjs';

const VALID_FIX_TYPES = new Set([
```

- [ ] **Step 6: Run the reviewer-protocol tests to confirm no regression**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/reviewer-protocol.test.mjs test/tagged-json.test.mjs`
Expected: PASS (11 reviewer-protocol tests + 6 tagged-json tests = 17 tests).

- [ ] **Step 7: Run full suite**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS. Test count 53 (47 + 6).

- [ ] **Step 8: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/tagged-json.mjs lib/reviewer-protocol.mjs test/tagged-json.test.mjs
git commit -m "refactor(tagged-json): factor extractTagged into shared module for promoter reuse"
```

---

### Task 3: Eval helpers — splitForHoldout, aggregateScores scoreField, overfittingDetection

**Files:**
- Modify: `lib/eval.mjs:165-187` (`aggregateScores` — add scoreField parameter)
- Modify: `lib/eval.mjs` (add `splitForHoldout`, `overfittingDetection`, `mulberry32`, `hashString` near the top of the file, under the existing `DEFAULT_GOLDEN_MAX` constant)
- Create: `test/split-for-holdout.test.mjs`
- Modify: `test/eval.test.mjs` (add scoreField + overfittingDetection coverage)

- [ ] **Step 1: Write the failing tests for `splitForHoldout` and the seeded PRNG**

Create `test/split-for-holdout.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitForHoldout, hashString, mulberry32 } from '../lib/eval.mjs';

test('hashString is deterministic for the same input', () => {
  assert.equal(hashString('foo'), hashString('foo'));
  assert.notEqual(hashString('foo'), hashString('bar'));
});

test('mulberry32 is deterministic and produces values in [0, 1)', () => {
  const rng1 = mulberry32(42);
  const rng2 = mulberry32(42);
  for (let i = 0; i < 10; i++) {
    const v = rng1();
    assert.equal(v, rng2());
    assert.ok(v >= 0 && v < 1, `value ${v} out of [0,1)`);
  }
});

test('splitForHoldout marks K prompts as holdout and the rest as fixer', () => {
  const prompts = [
    { prompt: 'a', promptObj: {} },
    { prompt: 'b', promptObj: {} },
    { prompt: 'c', promptObj: {} },
  ];
  const split = splitForHoldout(prompts, 1, 'seed-1');
  const holdout = split.filter(p => p.promptObj.evaluation === 'holdout');
  const fixer = split.filter(p => p.promptObj.evaluation === 'fixer');
  assert.equal(holdout.length, 1);
  assert.equal(fixer.length, 2);
  for (const p of split) {
    assert.equal(p.promptObj.lifecycle, 'train');
  }
});

test('splitForHoldout is deterministic for the same seed', () => {
  const make = () => [
    { prompt: 'a', promptObj: {} },
    { prompt: 'b', promptObj: {} },
    { prompt: 'c', promptObj: {} },
    { prompt: 'd', promptObj: {} },
  ];
  const split1 = splitForHoldout(make(), 2, 'same-seed');
  const split2 = splitForHoldout(make(), 2, 'same-seed');
  const key = arr => arr.map(p => `${p.prompt}:${p.promptObj.evaluation}`).join(',');
  assert.equal(key(split1), key(split2));
});

test('splitForHoldout with different seeds yields different splits (usually)', () => {
  const make = () => Array.from({ length: 10 }, (_, i) => ({
    prompt: `p${i}`, promptObj: {},
  }));
  const keyOf = arr => arr.filter(p => p.promptObj.evaluation === 'holdout').map(p => p.prompt).sort().join(',');
  const a = keyOf(splitForHoldout(make(), 3, 'seed-alpha'));
  const b = keyOf(splitForHoldout(make(), 3, 'seed-beta'));
  assert.notEqual(a, b, 'different seeds should produce different holdout selections');
});

test('splitForHoldout with K=0 keeps all prompts as fixer', () => {
  const prompts = [{ prompt: 'a', promptObj: {} }, { prompt: 'b', promptObj: {} }];
  const split = splitForHoldout(prompts, 0, 'seed');
  assert.equal(split.filter(p => p.promptObj.evaluation === 'holdout').length, 0);
  assert.equal(split.filter(p => p.promptObj.evaluation === 'fixer').length, 2);
});

test('splitForHoldout preserves promptObj shape and mutates evaluation/lifecycle in-place', () => {
  const prompts = [
    { prompt: 'a', promptObj: { probe: 'p1', invariant: 'i1', adversarial: false } },
    { prompt: 'b', promptObj: { probe: 'p2', invariant: 'i2', adversarial: true } },
  ];
  const split = splitForHoldout(prompts, 1, 'seed');
  for (const p of split) {
    assert.ok('probe' in p.promptObj);
    assert.ok('invariant' in p.promptObj);
    assert.ok('adversarial' in p.promptObj);
    assert.equal(p.promptObj.lifecycle, 'train');
    assert.ok(['fixer', 'holdout'].includes(p.promptObj.evaluation));
  }
});
```

- [ ] **Step 2: Run the tests to confirm failure**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/split-for-holdout.test.mjs`
Expected: FAIL — `splitForHoldout`, `hashString`, `mulberry32` not exported.

- [ ] **Step 3: Add the helpers to `lib/eval.mjs`**

Open `lib/eval.mjs`. Right after the `DEFAULT_GOLDEN_MAX` constant at line 11, add a new section:

```js
const DEFAULT_GOLDEN_MAX = 50;

// --- Deterministic split helpers (Spec 2) ---

/**
 * Deterministic 32-bit string hash (djb2 variant).
 * Returns an unsigned 32-bit integer. Stable across Node versions.
 */
export function hashString(str) {
  let h = 5381;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

/**
 * Seeded PRNG — mulberry32. Deterministic; identical seeds yield identical
 * sequences across Node versions and platforms.
 * @param {number} seed
 * @returns {() => number} a function returning values in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically mark K of N generated prompts as `evaluation: 'holdout'`,
 * the rest as `evaluation: 'fixer'`. All marked `lifecycle: 'train'`.
 *
 * Mutates each prompt's `promptObj` in place (adds `lifecycle` + `evaluation`
 * while preserving probe/invariant/adversarial/etc). Returns the same array.
 *
 * The seed is hashed with `hashString` and fed to `mulberry32` to select a
 * stable index ordering, then the first K indices become holdout.
 *
 * @param {Array<{prompt: string, promptObj: object}>} prompts
 * @param {number} K — holdout count per call
 * @param {string} seed — seed string (e.g. `${runStartTime}-${personaId}`)
 */
export function splitForHoldout(prompts, K, seed) {
  const rng = mulberry32(hashString(seed));
  const indices = prompts.map((_, i) => i);
  // Fisher-Yates shuffle (seeded)
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const holdoutIndices = new Set(indices.slice(0, Math.max(0, Math.min(K, prompts.length))));
  prompts.forEach((p, i) => {
    if (!p.promptObj || typeof p.promptObj !== 'object') p.promptObj = {};
    p.promptObj.lifecycle = 'train';
    p.promptObj.evaluation = holdoutIndices.has(i) ? 'holdout' : 'fixer';
  });
  return prompts;
}
```

- [ ] **Step 4: Run split-for-holdout tests to confirm pass**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/split-for-holdout.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Extend `aggregateScores` with the optional `scoreField` parameter**

In `lib/eval.mjs`, find the current `aggregateScores` at line 165:

```js
export function aggregateScores(scoredPrompts) {
  const active = scoredPrompts.filter(q => !q.score.obsolete && !q.invalid);
  const total = active.length;
  if (total === 0) return { total: 0, successRate: 0, actionCompletionRate: 0, errorRate: 0, avgTools: 0, obsoleteCount: scoredPrompts.length - active.length };

  const successes = active.filter(q => isPassingScore(q.score));
  const actionRequests = active.filter(q => q.score.isActionRequest);
  const actionsCompleted = actionRequests.filter(q => q.score.actionRequirementMet);
  const totalErrors = active.reduce((s, q) => s + q.score.errorsFound, 0);
  const totalTools = active.reduce((s, q) => s + q.score.toolsUsed, 0);

  return {
    total,
    successRate: (successes.length / total * 100).toFixed(1),
    actionCompletionRate: actionRequests.length > 0
      ? (actionsCompleted.length / actionRequests.length * 100).toFixed(1)
      : 'N/A',
    errorRate: (totalErrors / total).toFixed(2),
    avgTools: (totalTools / total).toFixed(1),
    obsoleteCount: scoredPrompts.filter(q => q.score.obsolete && !q.invalid).length,
    invalidCount: scoredPrompts.filter(q => q.invalid).length,
  };
}
```

Replace with:

```js
export function aggregateScores(scoredPrompts, scoreField = 'score') {
  const readScore = q => q[scoreField] || q.score;
  const active = scoredPrompts.filter(q => {
    const s = readScore(q);
    return s && !s.obsolete && !q.invalid;
  });
  const total = active.length;
  if (total === 0) {
    return {
      total: 0, successRate: 0, actionCompletionRate: 0,
      errorRate: 0, avgTools: 0,
      obsoleteCount: scoredPrompts.filter(q => readScore(q)?.obsolete && !q.invalid).length,
      invalidCount: scoredPrompts.filter(q => q.invalid).length,
    };
  }

  const successes = active.filter(q => isPassingScore(readScore(q)));
  const actionRequests = active.filter(q => readScore(q).isActionRequest);
  const actionsCompleted = actionRequests.filter(q => readScore(q).actionRequirementMet);
  const totalErrors = active.reduce((s, q) => s + readScore(q).errorsFound, 0);
  const totalTools = active.reduce((s, q) => s + readScore(q).toolsUsed, 0);

  return {
    total,
    successRate: (successes.length / total * 100).toFixed(1),
    actionCompletionRate: actionRequests.length > 0
      ? (actionsCompleted.length / actionRequests.length * 100).toFixed(1)
      : 'N/A',
    errorRate: (totalErrors / total).toFixed(2),
    avgTools: (totalTools / total).toFixed(1),
    obsoleteCount: scoredPrompts.filter(q => readScore(q)?.obsolete && !q.invalid).length,
    invalidCount: scoredPrompts.filter(q => q.invalid).length,
  };
}
```

The fallback `q[scoreField] || q.score` means existing callers that pass `scoreField = 'score'` (or omit the argument) work unchanged. New callers can pass `'scorePre'` or `'scorePost'` and, if that field is missing on a given prompt, the function falls back to `q.score`.

- [ ] **Step 6: Add `overfittingDetection` pure function to `lib/eval.mjs`**

After the `aggregateScores` function, add:

```js
/**
 * Pure overfitting detection. Compares pre-fix and post-fix success rates for
 * train and holdout tiers and flags a run as overfit when train improves
 * while holdout decays by more than `threshold` (default 0.1 = 10%).
 *
 * Additionally flags per-persona divergences: any holdout prompt that went
 * pass → fail while any train prompt by the same persona went fail → pass.
 *
 * @param {object} args
 * @param {object} args.trainPre  aggregated pre-fix scores for train+fixer
 * @param {object} args.trainPost aggregated post-fix scores for train+fixer
 * @param {object} args.holdoutPre  aggregated pre-fix scores for train+holdout
 * @param {object} args.holdoutPost aggregated post-fix scores for train+holdout
 * @param {Array<object>} [args.perPromptPairs] optional per-prompt {persona, prompt, evaluation, scorePre, scorePost} entries for divergence detection
 * @param {number} [args.threshold=0.1]
 * @returns {{detected: boolean, trainDelta: number, holdoutDelta: number, threshold: number, divergences: object[]}}
 */
export function overfittingDetection({ trainPre, trainPost, holdoutPre, holdoutPost, perPromptPairs = [], threshold = 0.1 }) {
  const asRate = x => typeof x === 'string' ? parseFloat(x) / 100 : Number(x) / 100;
  const trainDelta = asRate(trainPost.successRate) - asRate(trainPre.successRate);
  const holdoutDelta = asRate(holdoutPost.successRate) - asRate(holdoutPre.successRate);

  const trainImproved = trainDelta > threshold;
  const holdoutDecayed = holdoutDelta < -threshold;
  const detected = trainImproved && holdoutDecayed;

  // Per-prompt divergences: group by persona, find pass→fail holdout paired
  // with fail→pass train.
  const byPersona = new Map();
  for (const p of perPromptPairs) {
    if (!byPersona.has(p.persona)) byPersona.set(p.persona, { holdoutRegressed: [], trainImproved: [] });
    const bucket = byPersona.get(p.persona);
    const prePass = p.scorePre && isPassingScore(p.scorePre);
    const postPass = p.scorePost && isPassingScore(p.scorePost);
    if (p.evaluation === 'holdout' && prePass && !postPass) {
      bucket.holdoutRegressed.push({ prompt: p.prompt, pre: 'pass', post: 'fail' });
    }
    if (p.evaluation === 'fixer' && !prePass && postPass) {
      bucket.trainImproved.push({ prompt: p.prompt, pre: 'fail', post: 'pass' });
    }
  }

  const divergences = [];
  for (const [persona, bucket] of byPersona.entries()) {
    if (bucket.holdoutRegressed.length > 0 && bucket.trainImproved.length > 0) {
      divergences.push({ persona, ...bucket });
    }
  }

  return {
    detected,
    trainDelta: Number(trainDelta.toFixed(4)),
    holdoutDelta: Number(holdoutDelta.toFixed(4)),
    threshold,
    divergences,
  };
}
```

- [ ] **Step 7: Add tests for `aggregateScores` scoreField and `overfittingDetection` in `test/eval.test.mjs`**

Append the following tests to `test/eval.test.mjs`. First, update the imports at the top:

Find:
```js
import {
  scorePrompt,
  aggregateScores,
  isPassingScore,
  classifyErrorCategory,
} from '../lib/eval.mjs';
```

Replace with:
```js
import {
  scorePrompt,
  aggregateScores,
  isPassingScore,
  classifyErrorCategory,
  overfittingDetection,
} from '../lib/eval.mjs';
```

Then append these tests at the end of the file:

```js
test('aggregateScores reads scorePre when scoreField = "scorePre"', () => {
  const scored = [
    {
      scorePre:  { completed: true,  errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 2, isActionRequest: false, obsolete: false },
      scorePost: { completed: true,  errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 3, isActionRequest: false, obsolete: false },
      score:     { completed: true,  errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 3, isActionRequest: false, obsolete: false },
    },
    {
      scorePre:  { completed: false, errorsFound: 2, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false },
      scorePost: { completed: true,  errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 4, isActionRequest: false, obsolete: false },
      score:     { completed: true,  errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 4, isActionRequest: false, obsolete: false },
    },
  ];
  const pre = aggregateScores(scored, 'scorePre');
  const post = aggregateScores(scored, 'scorePost');
  assert.equal(pre.successRate, '50.0');
  assert.equal(post.successRate, '100.0');
});

test('aggregateScores falls back to q.score when the chosen field is missing', () => {
  const scored = [
    {
      score: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 2, isActionRequest: false, obsolete: false },
      // no scorePost
    },
  ];
  const agg = aggregateScores(scored, 'scorePost');
  assert.equal(agg.total, 1);
  assert.equal(agg.successRate, '100.0');
});

test('overfittingDetection flags when train improves and holdout decays by more than threshold', () => {
  const result = overfittingDetection({
    trainPre:  { total: 6, successRate: '50.0' },
    trainPost: { total: 6, successRate: '80.0' },
    holdoutPre:  { total: 3, successRate: '66.6' },
    holdoutPost: { total: 3, successRate: '33.3' },
    threshold: 0.1,
  });
  assert.equal(result.detected, true);
  assert.ok(result.trainDelta > 0.1);
  assert.ok(result.holdoutDelta < -0.1);
});

test('overfittingDetection does NOT flag when both train and holdout improve', () => {
  const result = overfittingDetection({
    trainPre:  { total: 6, successRate: '50.0' },
    trainPost: { total: 6, successRate: '80.0' },
    holdoutPre:  { total: 3, successRate: '66.6' },
    holdoutPost: { total: 3, successRate: '100.0' },
    threshold: 0.1,
  });
  assert.equal(result.detected, false);
});

test('overfittingDetection surfaces per-persona divergences when holdout regresses and train improves', () => {
  const goodPre = { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false };
  const badPre = { completed: true, errorsFound: 2, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false };
  const perPromptPairs = [
    { persona: 'waiter', prompt: 'seat at Tisch 5', evaluation: 'holdout', scorePre: goodPre, scorePost: badPre },
    { persona: 'waiter', prompt: 'seat at Tisch 3', evaluation: 'fixer',   scorePre: badPre,  scorePost: goodPre },
  ];
  const result = overfittingDetection({
    trainPre:  { total: 3, successRate: '33.3' },
    trainPost: { total: 3, successRate: '66.6' },
    holdoutPre:  { total: 1, successRate: '100.0' },
    holdoutPost: { total: 1, successRate: '0.0' },
    perPromptPairs,
    threshold: 0.1,
  });
  assert.equal(result.detected, true);
  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].persona, 'waiter');
  assert.equal(result.divergences[0].holdoutRegressed.length, 1);
  assert.equal(result.divergences[0].trainImproved.length, 1);
});
```

- [ ] **Step 8: Run eval tests to confirm pass**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/eval.test.mjs test/split-for-holdout.test.mjs`
Expected: PASS (6 original + 5 new = 11 eval tests, 7 split tests).

- [ ] **Step 9: Run full suite**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS. Test count 65 (53 + 5 eval + 7 split).

- [ ] **Step 10: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/eval.mjs test/eval.test.mjs test/split-for-holdout.test.mjs
git commit -m "feat(eval): add splitForHoldout + seeded RNG, aggregateScores scoreField, overfittingDetection pure fn"
```

---

### Task 4: Baseline schema v2 (scorePre + scorePost + v1-compat)

**Files:**
- Modify: `lib/eval.mjs:191-218` (`saveBaseline` + `loadBaseline`)
- Modify: `lib/eval.mjs:399-443` (`checkStreak` — golden-only)
- Modify: `test/eval.test.mjs` (add coverage)

- [ ] **Step 1: Write the failing tests for the baseline v2 schema**

Append to `test/eval.test.mjs`:

```js
test('saveBaseline writes version: 2 with scorePre/scorePost per prompt', () => {
  const { saveBaseline, loadBaseline } = require('../lib/eval.mjs');  // fallback — imports below
});
```

That test above is a sketch; the real test imports go at the top. Update the top import to include `saveBaseline`, `loadBaseline`:

Find:
```js
import {
  scorePrompt,
  aggregateScores,
  isPassingScore,
  classifyErrorCategory,
  overfittingDetection,
} from '../lib/eval.mjs';
```

Replace with:
```js
import {
  scorePrompt,
  aggregateScores,
  isPassingScore,
  classifyErrorCategory,
  overfittingDetection,
  saveBaseline,
  loadBaseline,
} from '../lib/eval.mjs';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

Now replace the stub test above with real tests. Delete the sketch `test('saveBaseline writes version: 2 ...', () => {})` stub and append these tests:

```js
test('saveBaseline writes version: 2 with scorePre and scorePost per prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-'));
  try {
    const config = { baselinesDir: dir };
    const pre = { completed: false, errorsFound: 2, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false };
    const post = { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 2, isActionRequest: false, obsolete: false };
    const results = [{
      persona: { id: 'p1' },
      prompts: [{
        prompt: 'seat at Tisch 5',
        promptObj: { lifecycle: 'train', evaluation: 'fixer', probe: 'x', invariant: 'y' },
        scorePre: pre,
        scorePost: post,
        score: post,
      }],
    }];
    const path = saveBaseline(results, 'sonnet', config);
    const loaded = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(loaded.version, 2);
    assert.equal(loaded.prompts.length, 1);
    assert.equal(loaded.prompts[0].lifecycle, 'train');
    assert.equal(loaded.prompts[0].evaluation, 'fixer');
    assert.deepEqual(loaded.prompts[0].scorePre, pre);
    assert.deepEqual(loaded.prompts[0].scorePost, post);
    // `score` alias stays for legacy consumers
    assert.deepEqual(loaded.prompts[0].score, post);
    // `group` field must be gone
    assert.equal('group' in loaded.prompts[0], false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadBaseline normalizes v1 baselines (score only) into scorePost form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-v1-'));
  try {
    const v1 = {
      timestamp: '2026-04-01T00:00:00Z',
      answererModel: 'sonnet',
      prompts: [{
        persona: 'p1',
        group: 'train',
        prompt: 'old prompt',
        score: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false },
      }],
    };
    const file = join(dir, 'baseline-2026-04-01-00-00-00.json');
    const { writeFileSync } = require('node:fs');
    writeFileSync(file, JSON.stringify(v1));
    const cfg = { baselinesDir: dir };
    const loaded = loadBaseline(file, cfg);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.prompts[0].scorePost.completed, true);
    assert.equal(loaded.prompts[0].scorePre, null);
    // lifecycle is synthesized from the legacy `group` field during normalization
    assert.equal(loaded.prompts[0].lifecycle, 'train');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Note: the second test uses `require('node:fs')` mid-test because it needs `writeFileSync` and the top-of-file `import` already covered `readFileSync, mkdtempSync, rmSync`. That pattern works in node:test ESM mode via CommonJS interop. Alternatively, add `writeFileSync` to the top-level import:

Find:
```js
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
```

Replace with:
```js
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
```

And remove the inline `const { writeFileSync } = require('node:fs');` line from the second test.

- [ ] **Step 2: Run the test to confirm failure**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/eval.test.mjs`
Expected: FAIL — the saved baseline has `group`, lacks `scorePre`/`scorePost`/`version: 2`.

- [ ] **Step 3: Update `saveBaseline` in `lib/eval.mjs`**

Find lines 191–218:

```js
export function saveBaseline(results, answererModel, config) {
  const dir = config.baselinesDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const savedPrompts = [];
  for (const r of results) {
    for (const q of r.prompts) {
      savedPrompts.push({
        persona: r.persona.id,
        group: r.persona.group,
        prompt: q.prompt,
        promptObj: q.promptObj || null,
        score: q.score,
      });
    }
  }

  const baseline = {
    timestamp: new Date().toISOString(),
    answererModel: answererModel || 'default',
    prompts: savedPrompts,
  };

  const ts = baseline.timestamp.replace(/[:.]/g, '-').slice(0, 19);
  const path = join(dir, `baseline-${ts}.json`);
  writeFileSync(path, JSON.stringify(baseline, null, 2));
  return path;
}
```

Replace with:

```js
export function saveBaseline(results, answererModel, config) {
  const dir = config.baselinesDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const savedPrompts = [];
  for (const r of results) {
    for (const q of r.prompts) {
      const lifecycle = q.promptObj?.lifecycle || null;
      const evaluation = q.promptObj?.evaluation || null;
      savedPrompts.push({
        persona: r.persona.id,
        lifecycle,
        evaluation,
        prompt: q.prompt,
        promptObj: q.promptObj || null,
        scorePre: q.scorePre || null,
        scorePost: q.scorePost || q.score || null,
        // `score` kept as alias for legacy consumers (isPassingScore, regression replay)
        score: q.scorePost || q.score || null,
      });
    }
  }

  const baseline = {
    version: 2,
    timestamp: new Date().toISOString(),
    answererModel: answererModel || 'default',
    prompts: savedPrompts,
  };

  const ts = baseline.timestamp.replace(/[:.]/g, '-').slice(0, 19);
  const path = join(dir, `baseline-${ts}.json`);
  writeFileSync(path, JSON.stringify(baseline, null, 2));
  return path;
}
```

- [ ] **Step 4: Update `loadBaseline` in `lib/eval.mjs` to normalize v1 on read**

Find lines 220–235:

```js
export function loadBaseline(pathOrNull, config) {
  if (pathOrNull) {
    return JSON.parse(readFileSync(pathOrNull, 'utf-8'));
  }

  const dir = config.baselinesDir;
  if (!existsSync(dir)) return null;

  const files = readdirSync(dir)
    .filter(f => f.startsWith('baseline-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'));
}
```

Replace with:

```js
export function loadBaseline(pathOrNull, config) {
  const raw = (() => {
    if (pathOrNull) {
      return JSON.parse(readFileSync(pathOrNull, 'utf-8'));
    }
    const dir = config.baselinesDir;
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter(f => f.startsWith('baseline-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    return JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'));
  })();

  if (!raw) return null;
  return normalizeBaseline(raw);
}

/**
 * Normalize a baseline into v2 shape. v1 baselines (no `version`, prompts
 * have `score` + `group`) become v2: `score` → `scorePost`, `scorePre` = null,
 * `group` → `lifecycle`.
 */
function normalizeBaseline(raw) {
  if (raw.version === 2 && Array.isArray(raw.prompts)) return raw;

  const prompts = (raw.prompts || raw.questions || []).map(q => ({
    persona: q.persona,
    lifecycle: q.lifecycle || q.group || null,
    evaluation: q.evaluation || 'fixer',
    prompt: q.prompt || q.question,
    promptObj: q.promptObj || null,
    scorePre: q.scorePre || null,
    scorePost: q.scorePost || q.score || null,
    score: q.scorePost || q.score || null,
  }));

  return {
    version: 2,
    timestamp: raw.timestamp || null,
    answererModel: raw.answererModel || 'default',
    prompts,
  };
}
```

- [ ] **Step 5: Update `checkStreak` to only count golden-lifecycle prompts**

Find `checkStreak` at line 399. Replace the body:

```js
export function checkStreak(minStreak = 3, config) {
  const dir = config.baselinesDir;
  if (!existsSync(dir)) return { streak: 0, baselines: [] };

  const files = readdirSync(dir)
    .filter(f => f.startsWith('baseline-') && f.endsWith('.json'))
    .sort()
    .reverse();

  let streak = 0;
  const streakBaselines = [];

  for (const file of files) {
    try {
      const baseline = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      const prompts = baseline.prompts || baseline.questions || [];
      if (prompts.length === 0) continue;

      const allPassed = prompts.every(q => isPassingScore(q.score));

      if (allPassed) {
        streak++;
        streakBaselines.push({ file, timestamp: baseline.timestamp, promptCount: prompts.length });
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return {
    streak,
    triggered: streak >= minStreak,
    baselines: streakBaselines,
    allPassingPrompts: streakBaselines.length > 0
      ? files.slice(0, streak).flatMap(file => {
          try {
            const b = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
            return (b.prompts || []).map(q => ({ persona: q.persona, prompt: q.prompt }));
          } catch { return []; }
        })
      : [],
  };
}
```

Replace with:

```js
export function checkStreak(minStreak = 3, config) {
  const dir = config.baselinesDir;
  if (!existsSync(dir)) return { streak: 0, triggered: false, baselines: [], allPassingPrompts: [] };

  const files = readdirSync(dir)
    .filter(f => f.startsWith('baseline-') && f.endsWith('.json'))
    .sort()
    .reverse();

  let streak = 0;
  const streakBaselines = [];

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      const baseline = normalizeBaseline(raw);
      const prompts = baseline.prompts || [];

      // Spec 2: only golden-lifecycle prompts count toward the streak.
      const goldens = prompts.filter(q => (q.lifecycle || q.group) === 'golden');

      // Empty golden → streak is 0. Do not count a run with no golden tier
      // toward the streak; otherwise the first few post-migration runs would
      // trivially "streak" on an empty set.
      if (goldens.length === 0) {
        break;
      }

      const allPassed = goldens.every(q => isPassingScore(q.scorePost || q.score));

      if (allPassed) {
        streak++;
        streakBaselines.push({ file, timestamp: baseline.timestamp, promptCount: goldens.length });
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return {
    streak,
    triggered: streak >= minStreak,
    baselines: streakBaselines,
    allPassingPrompts: streakBaselines.length > 0
      ? files.slice(0, streak).flatMap(file => {
          try {
            const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
            const b = normalizeBaseline(raw);
            return (b.prompts || [])
              .filter(q => (q.lifecycle || q.group) === 'golden')
              .map(q => ({ persona: q.persona, prompt: q.prompt }));
          } catch { return []; }
        })
      : [],
  };
}
```

- [ ] **Step 6: Run eval tests to confirm pass**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/eval.test.mjs`
Expected: PASS (13 tests: 6 original + 5 from Task 3 + 2 new).

- [ ] **Step 7: Run full suite**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS. Test count 67 (65 + 2).

- [ ] **Step 8: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/eval.mjs test/eval.test.mjs
git commit -m "feat(eval): baseline v2 schema (scorePre + scorePost + lifecycle + evaluation) with v1-compat normalizer; checkStreak counts golden only"
```

---

### Task 5: Promoter module — protocol + pure + async + prompt file

**Files:**
- Create: `lib/promoter-protocol.mjs`
- Create: `lib/promoter.mjs`
- Create: `prompts/promoter.md`
- Create: `test/promoter-protocol.test.mjs`
- Create: `test/promoter.test.mjs`

- [ ] **Step 1: Write the failing tests for `promoter-protocol.mjs`**

Create `test/promoter-protocol.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePromoterOutput, validatePromoterOutput } from '../lib/promoter-protocol.mjs';

test('parsePromoterOutput extracts NOMINATIONS and SKIPPED tagged blocks', () => {
  const text = [
    'Some reasoning text from the LLM',
    '',
    '<NOMINATIONS>',
    '[',
    '  {',
    '    "promptId": "waiter::seat walk-in at Tisch 3",',
    '    "capabilityTag": "walk-in-seating",',
    '    "confidence": "high",',
    '    "reason": "unique, passes cleanly, exercises multi-occupancy"',
    '  }',
    ']',
    '</NOMINATIONS>',
    '',
    '<SKIPPED>',
    '[',
    '  { "promptId": "waiter::list tables", "reason": "duplicate of existing golden" }',
    ']',
    '</SKIPPED>',
  ].join('\n');
  const parsed = parsePromoterOutput(text);
  assert.equal(parsed.nominations.length, 1);
  assert.equal(parsed.nominations[0].promptId, 'waiter::seat walk-in at Tisch 3');
  assert.equal(parsed.skipped.length, 1);
  assert.equal(parsed.parseErrors.length, 0);
});

test('parsePromoterOutput reports parse errors for invalid JSON but does not throw', () => {
  const text = '<NOMINATIONS>\n[ this is not valid JSON ]\n</NOMINATIONS>';
  const parsed = parsePromoterOutput(text);
  assert.equal(parsed.nominations.length, 0);
  assert.ok(parsed.parseErrors.length >= 1);
  assert.match(parsed.parseErrors[0], /NOMINATIONS parse failed/);
});

test('parsePromoterOutput returns empty arrays when tags are missing', () => {
  const parsed = parsePromoterOutput('no tags at all');
  assert.deepEqual(parsed.nominations, []);
  assert.deepEqual(parsed.skipped, []);
  assert.deepEqual(parsed.parseErrors, []);
});

test('parsePromoterOutput handles non-string input safely', () => {
  const parsed = parsePromoterOutput(null);
  assert.deepEqual(parsed.nominations, []);
  assert.deepEqual(parsed.skipped, []);
});

test('validatePromoterOutput accepts a well-formed nomination', () => {
  const errors = validatePromoterOutput({
    nominations: [{
      promptId: 'p::q', capabilityTag: 'tag', confidence: 'high', reason: 'r',
    }],
    skipped: [],
  });
  assert.deepEqual(errors, []);
});

test('validatePromoterOutput rejects unknown confidence values', () => {
  const errors = validatePromoterOutput({
    nominations: [{ promptId: 'p::q', capabilityTag: 'tag', confidence: 'certain', reason: 'r' }],
    skipped: [],
  });
  assert.ok(errors.some(e => /confidence/.test(e)));
});

test('validatePromoterOutput rejects missing promptId in nomination', () => {
  const errors = validatePromoterOutput({
    nominations: [{ capabilityTag: 'tag', confidence: 'high', reason: 'r' }],
    skipped: [],
  });
  assert.ok(errors.some(e => /promptId/.test(e)));
});

test('validatePromoterOutput rejects missing reason in skipped entry', () => {
  const errors = validatePromoterOutput({
    nominations: [],
    skipped: [{ promptId: 'p::q' }],
  });
  assert.ok(errors.some(e => /reason/.test(e)));
});

test('validatePromoterOutput handles null and non-object inputs', () => {
  assert.deepEqual(validatePromoterOutput(null), ['validatePromoterOutput: parsed input is not an object']);
  assert.deepEqual(validatePromoterOutput(undefined), ['validatePromoterOutput: parsed input is not an object']);
});

test('validatePromoterOutput skips null nomination entries with a clear error', () => {
  const errors = validatePromoterOutput({ nominations: [null], skipped: [] });
  assert.ok(errors.some(e => /nomination entry is not an object/.test(e)));
});
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/promoter-protocol.test.mjs`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `lib/promoter-protocol.mjs`**

Create `lib/promoter-protocol.mjs`:

```js
/**
 * mcp-evolve — Promoter output protocol.
 *
 * The Promoter-Agent emits two tagged-JSON blocks at the end of its response:
 *
 *   <NOMINATIONS>
 *   [ { promptId, capabilityTag, confidence, reason }, ... ]
 *   </NOMINATIONS>
 *
 *   <SKIPPED>
 *   [ { promptId, reason }, ... ]
 *   </SKIPPED>
 *
 * This module parses + validates those blocks. Mirrors the structure of
 * `reviewer-protocol.mjs`.
 */

import { extractTagged } from './tagged-json.mjs';

const VALID_CONFIDENCE = new Set(['high', 'medium']);

/**
 * Parse raw promoter stdout. Extracts `<NOMINATIONS>` and `<SKIPPED>` JSON
 * blocks. Never throws; parse errors are reported structurally.
 *
 * @param {string} text
 * @returns {{nominations: object[], skipped: object[], parseErrors: string[]}}
 */
export function parsePromoterOutput(text) {
  const result = { nominations: [], skipped: [], parseErrors: [] };
  if (typeof text !== 'string') return result;

  const nomRaw = extractTagged(text, 'NOMINATIONS');
  if (nomRaw) {
    try {
      const parsed = JSON.parse(nomRaw);
      if (Array.isArray(parsed)) result.nominations = parsed;
      else result.parseErrors.push('NOMINATIONS block is not a JSON array');
    } catch (err) {
      result.parseErrors.push(`NOMINATIONS parse failed: ${err.message}`);
    }
  }

  const skipRaw = extractTagged(text, 'SKIPPED');
  if (skipRaw) {
    try {
      const parsed = JSON.parse(skipRaw);
      if (Array.isArray(parsed)) result.skipped = parsed;
      else result.parseErrors.push('SKIPPED block is not a JSON array');
    } catch (err) {
      result.parseErrors.push(`SKIPPED parse failed: ${err.message}`);
    }
  }

  return result;
}

/**
 * Validate a parsed promoter output for structural and semantic correctness.
 * Returns an array of human-readable error strings; empty means valid.
 */
export function validatePromoterOutput(parsed) {
  const errors = [];

  if (!parsed || typeof parsed !== 'object') {
    return ['validatePromoterOutput: parsed input is not an object'];
  }

  for (const n of parsed.nominations || []) {
    if (!n || typeof n !== 'object') {
      errors.push(`nomination entry is not an object: ${JSON.stringify(n)}`);
      continue;
    }
    if (!n.promptId || typeof n.promptId !== 'string') {
      errors.push(`nomination missing promptId: ${JSON.stringify(n)}`);
    }
    if (!n.capabilityTag || typeof n.capabilityTag !== 'string') {
      errors.push(`nomination missing capabilityTag for ${n.promptId || '(unknown)'}`);
    }
    if (!VALID_CONFIDENCE.has(n.confidence)) {
      errors.push(`nomination confidence invalid for ${n.promptId || '(unknown)'}: ${n.confidence}`);
    }
    if (!n.reason || typeof n.reason !== 'string') {
      errors.push(`nomination reason missing for ${n.promptId || '(unknown)'}`);
    }
  }

  for (const s of parsed.skipped || []) {
    if (!s || typeof s !== 'object') {
      errors.push(`skipped entry is not an object: ${JSON.stringify(s)}`);
      continue;
    }
    if (!s.promptId || typeof s.promptId !== 'string') {
      errors.push(`skipped missing promptId: ${JSON.stringify(s)}`);
    }
    if (!s.reason || typeof s.reason !== 'string') {
      errors.push(`skipped reason missing for ${s.promptId || '(unknown)'}`);
    }
  }

  return errors;
}
```

- [ ] **Step 4: Run promoter-protocol tests to confirm pass**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/promoter-protocol.test.mjs`
Expected: PASS (10 tests).

- [ ] **Step 5: Write the failing tests for `promoter.mjs` (pure path)**

Create `test/promoter.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPromoterDecisions } from '../lib/promoter.mjs';

function makeCfg() {
  const dir = mkdtempSync(join(tmpdir(), 'promoter-'));
  return {
    promptSetPath: join(dir, 'prompt-set.json'),
    failingPromptsPath: join(dir, 'failing-prompts.json'),
    maxPromotionsPerRun: 3,
    _dir: dir,
  };
}

test('applyPromoterDecisions appends nominated candidates to prompt-set as golden', () => {
  const cfg = makeCfg();
  try {
    writeFileSync(cfg.promptSetPath, JSON.stringify({ version: 2, prompts: [] }));

    const candidates = [
      {
        persona: 'waiter',
        prompt: 'seat a walk-in at Tisch 3',
        promptObj: {
          prompt: 'seat a walk-in at Tisch 3',
          probe: 'list guests at table 3',
          invariant: 'multi-occupancy supported',
          probeType: 'action',
          adversarial: false,
          lifecycle: 'train',
          evaluation: 'fixer',
        },
        scorePost: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 2, isActionRequest: true, obsolete: false },
      },
    ];

    const reviewerOutput = {
      nominations: [{
        promptId: 'waiter::seat a walk-in at Tisch 3',
        capabilityTag: 'walk-in-seating',
        confidence: 'high',
        reason: 'Tests multi-occupancy walk-in path; no existing golden covers this',
      }],
      skipped: [],
      parseErrors: [],
    };

    const result = applyPromoterDecisions({
      reviewerOutput, candidates, config: cfg, runId: '2026-04-11T20:00:00Z',
    });

    assert.equal(result.nominated.length, 1);
    assert.equal(result.skipped.length, 0);

    const ps = JSON.parse(readFileSync(cfg.promptSetPath, 'utf-8'));
    assert.equal(ps.prompts.length, 1);
    const g = ps.prompts[0];
    assert.equal(g.lifecycle, 'golden');
    assert.equal(g.evaluation, 'fixer');
    assert.equal(g.consecutivePasses, 1);
    assert.ok(g.promotedAt);
    assert.equal(g.promoterEvidence.capabilityTag, 'walk-in-seating');
    assert.equal(g.promoterEvidence.confidence, 'high');
    assert.equal(g.promoterEvidence.nominatedInRun, '2026-04-11T20:00:00Z');
    // probe/invariant/adversarial copied from the candidate's promptObj
    assert.equal(g.promptObj.probe, 'list guests at table 3');
    assert.equal(g.promptObj.invariant, 'multi-occupancy supported');
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('applyPromoterDecisions caps nominations at maxPromotionsPerRun', () => {
  const cfg = makeCfg();
  cfg.maxPromotionsPerRun = 2;
  try {
    writeFileSync(cfg.promptSetPath, JSON.stringify({ version: 2, prompts: [] }));
    const mk = (i) => ({
      persona: 'p',
      prompt: `candidate-${i}`,
      promptObj: { prompt: `candidate-${i}`, probe: 'p', invariant: 'i', probeType: 'read', adversarial: false, lifecycle: 'train', evaluation: 'fixer' },
      scorePost: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false },
    });
    const candidates = [mk(1), mk(2), mk(3), mk(4)];
    const reviewerOutput = {
      nominations: candidates.map((c, i) => ({
        promptId: `p::candidate-${i + 1}`,
        capabilityTag: `tag-${i}`,
        confidence: 'high',
        reason: 'test',
      })),
      skipped: [],
      parseErrors: [],
    };
    const result = applyPromoterDecisions({ reviewerOutput, candidates, config: cfg, runId: 'r' });
    assert.equal(result.nominated.length, 2);
    const ps = JSON.parse(readFileSync(cfg.promptSetPath, 'utf-8'));
    assert.equal(ps.prompts.length, 2);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('applyPromoterDecisions skips candidates not present in the input list', () => {
  const cfg = makeCfg();
  try {
    writeFileSync(cfg.promptSetPath, JSON.stringify({ version: 2, prompts: [] }));
    const reviewerOutput = {
      nominations: [{
        promptId: 'ghost::nonexistent prompt',
        capabilityTag: 'tag', confidence: 'high', reason: 'r',
      }],
      skipped: [],
      parseErrors: [],
    };
    const result = applyPromoterDecisions({
      reviewerOutput, candidates: [], config: cfg, runId: 'r',
    });
    assert.equal(result.nominated.length, 0);
    assert.equal(result.unmatched.length, 1);
    const ps = JSON.parse(readFileSync(cfg.promptSetPath, 'utf-8'));
    assert.equal(ps.prompts.length, 0);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('applyPromoterDecisions does not duplicate an already-golden prompt', () => {
  const cfg = makeCfg();
  try {
    writeFileSync(cfg.promptSetPath, JSON.stringify({
      version: 2,
      prompts: [{
        persona: 'p',
        prompt: 'existing prompt',
        lifecycle: 'golden', evaluation: 'fixer',
        consecutivePasses: 3,
        promptObj: { prompt: 'existing prompt', probe: 'x', invariant: 'y', adversarial: false, lifecycle: 'golden', evaluation: 'fixer' },
      }],
    }));
    const candidates = [{
      persona: 'p', prompt: 'existing prompt',
      promptObj: { prompt: 'existing prompt', probe: 'x', invariant: 'y', adversarial: false, lifecycle: 'train', evaluation: 'fixer' },
      scorePost: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false },
    }];
    const reviewerOutput = {
      nominations: [{ promptId: 'p::existing prompt', capabilityTag: 't', confidence: 'high', reason: 'r' }],
      skipped: [], parseErrors: [],
    };
    const result = applyPromoterDecisions({ reviewerOutput, candidates, config: cfg, runId: 'r' });
    assert.equal(result.nominated.length, 0);
    assert.equal(result.duplicates.length, 1);
    const ps = JSON.parse(readFileSync(cfg.promptSetPath, 'utf-8'));
    // Still exactly 1 golden — no duplication.
    assert.equal(ps.prompts.length, 1);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('applyPromoterDecisions creates prompt-set file when missing', () => {
  const cfg = makeCfg();
  try {
    // Do NOT write prompt-set.json — simulates first run after init
    assert.equal(existsSync(cfg.promptSetPath), false);
    const candidates = [{
      persona: 'p', prompt: 'new golden',
      promptObj: { prompt: 'new golden', probe: 'p', invariant: 'i', probeType: 'read', adversarial: false, lifecycle: 'train', evaluation: 'fixer' },
      scorePost: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false },
    }];
    const reviewerOutput = {
      nominations: [{ promptId: 'p::new golden', capabilityTag: 't', confidence: 'high', reason: 'r' }],
      skipped: [], parseErrors: [],
    };
    applyPromoterDecisions({ reviewerOutput, candidates, config: cfg, runId: 'r' });
    const ps = JSON.parse(readFileSync(cfg.promptSetPath, 'utf-8'));
    assert.equal(ps.version, 2);
    assert.equal(ps.prompts.length, 1);
    assert.equal(ps.prompts[0].lifecycle, 'golden');
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: Run promoter tests to confirm failure**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/promoter.test.mjs`
Expected: FAIL — `lib/promoter.mjs` does not exist.

- [ ] **Step 7: Implement `lib/promoter.mjs`**

Create `lib/promoter.mjs`:

```js
/**
 * mcp-evolve — Promoter-Agent orchestration.
 *
 * After every run, the Promoter-Agent inspects passing train prompts and
 * nominates 0–3 for graduation to the persistent golden tier. Mirrors the
 * Spec 1 audit pattern: `applyPromoterDecisions` is a pure, synchronous,
 * unit-testable function; `runPromoter` is the async LLM wrapper.
 *
 * Nominated prompts are appended to `prompt-set.json` with:
 *   lifecycle: 'golden'
 *   evaluation: 'fixer'
 *   promoterEvidence: { nominatedInRun, capabilityTag, confidence, reason }
 *   promotedAt: ISO timestamp
 *   consecutivePasses: 1
 *   probe, invariant, probeType, adversarial — copied from the candidate
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { claude, readPrompt } from './claude.mjs';
import { parsePromoterOutput, validatePromoterOutput } from './promoter-protocol.mjs';
import { normalizeErrorText } from './failing-prompts.mjs';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

/**
 * Apply promoter decisions to the persisted prompt-set. Pure sync function
 * with three side effects: reads and writes `prompt-set.json`. No LLM or
 * git calls.
 *
 * @param {object} args
 * @param {{nominations: object[], skipped: object[], parseErrors: string[]}} args.reviewerOutput
 * @param {Array<object>} args.candidates — scored prompts eligible for promotion
 * @param {object} args.config
 * @param {string} args.runId — ISO timestamp of the current run, stored in promoterEvidence
 * @returns {{nominated: object[], skipped: object[], unmatched: object[], duplicates: object[]}}
 */
export function applyPromoterDecisions({ reviewerOutput, candidates, config, runId }) {
  const nominated = [];
  const skipped = [...(reviewerOutput.skipped || [])];
  const unmatched = [];
  const duplicates = [];

  // Load existing prompt-set (create empty v2 shell if missing)
  let ps;
  if (existsSync(config.promptSetPath)) {
    try { ps = JSON.parse(readFileSync(config.promptSetPath, 'utf-8')); }
    catch { ps = { version: 2, prompts: [] }; }
  } else {
    ps = { version: 2, prompts: [] };
  }
  if (!ps.prompts || !Array.isArray(ps.prompts)) ps.prompts = [];

  const existingGoldenKeys = new Set(
    ps.prompts
      .filter(p => p.lifecycle === 'golden')
      .map(p => `${p.persona}::${p.prompt}`)
  );

  const candidateByKey = new Map();
  for (const c of candidates) {
    const key = `${c.persona}::${c.prompt}`;
    candidateByKey.set(key, c);
  }

  const cap = Math.max(0, Number(config.maxPromotionsPerRun) || 3);

  for (const n of reviewerOutput.nominations || []) {
    if (nominated.length >= cap) {
      skipped.push({ promptId: n.promptId, reason: `cap reached (maxPromotionsPerRun=${cap})` });
      continue;
    }
    const key = n.promptId;
    const candidate = candidateByKey.get(key);
    if (!candidate) {
      unmatched.push({ promptId: key, reason: 'no matching candidate in this run' });
      continue;
    }
    if (existingGoldenKeys.has(key)) {
      duplicates.push({ promptId: key, reason: 'already present as golden' });
      continue;
    }

    const promptObj = candidate.promptObj || { prompt: candidate.prompt };
    const entry = {
      persona: candidate.persona,
      prompt: candidate.prompt,
      lifecycle: 'golden',
      evaluation: 'fixer',
      consecutivePasses: 1,
      promotedAt: new Date().toISOString(),
      promoterEvidence: {
        nominatedInRun: runId,
        capabilityTag: n.capabilityTag,
        confidence: n.confidence,
        reason: n.reason,
      },
      promptObj: {
        prompt: candidate.prompt,
        probe: promptObj.probe || null,
        invariant: promptObj.invariant || null,
        probeType: promptObj.probeType || null,
        adversarial: promptObj.adversarial === true,
        lifecycle: 'golden',
        evaluation: 'fixer',
      },
    };
    ps.prompts.push(entry);
    existingGoldenKeys.add(key);
    nominated.push(entry);
  }

  // Write back (ensure directory exists)
  const dir = dirname(config.promptSetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(config.promptSetPath, JSON.stringify(ps, null, 2) + '\n');

  return { nominated, skipped, unmatched, duplicates };
}

/**
 * Build the promoter LLM payload: list existing golden capabilities + the
 * candidate prompts from this run + an anti-examples section from the
 * failing-prompts store (so the promoter doesn't nominate prompts that
 * were already rejected in a previous run).
 */
function buildPromoterPayload({ candidates, currentGolden, failingEntries, config }) {
  const goldenList = currentGolden.length === 0
    ? '(none — first run after migration)'
    : currentGolden.map(g => {
        const tag = g.promoterEvidence?.capabilityTag || '(untagged)';
        return `- [${g.persona}] capability: ${tag}\n    Prompt: "${(g.prompt || '').slice(0, 160)}"`;
      }).join('\n');

  const candidateList = candidates.map(c => {
    const toolsUsed = (c.toolCalls || c.scorePost?.toolsUsedList || []).slice(0, 10);
    const invariant = c.promptObj?.invariant || '(none)';
    return [
      `- promptId: ${c.persona}::${c.prompt}`,
      `  Persona: ${c.persona}`,
      `  Prompt: "${c.prompt}"`,
      `  Probe invariant: ${invariant}`,
      `  Tools used (${toolsUsed.length}): ${toolsUsed.join(', ') || '(n/a)'}`,
    ].join('\n');
  }).join('\n\n');

  const antiExamples = (failingEntries || [])
    .filter(e => e.kind === 'prompt')
    .slice(0, 20)
    .map(e => `- [${e.persona || '(any)'}] "${(e.prompt || '').slice(0, 160)}" — ${e.reason}`)
    .join('\n');

  const header = [
    `# Promoter-Agent input`,
    `Max nominations this run: ${config.maxPromotionsPerRun ?? 3}`,
    '',
    `## Existing golden capabilities`,
    goldenList,
    '',
    `## Passing train candidates this run`,
    candidateList || '(none)',
    '',
    antiExamples ? `## Anti-examples — DO NOT nominate these or near-duplicates\n${antiExamples}\n` : '',
    `Emit <NOMINATIONS> and <SKIPPED> JSON blocks per your system prompt.`,
  ].filter(Boolean).join('\n');

  return header;
}

/**
 * Invoke the Promoter-Agent LLM and apply its decisions.
 *
 * @param {object} args
 * @param {Array<object>} args.candidates
 * @param {Array<object>} args.currentGolden
 * @param {Array<object>} args.failingEntries
 * @param {object} args.config
 * @param {string} args.runId
 * @returns {Promise<{nominated: object[], skipped: object[], unmatched: object[], duplicates: object[], parseErrors: string[], reviewerOutput: object|null}>}
 */
export async function runPromoter({ candidates, currentGolden, failingEntries, config, runId }) {
  if (!candidates || candidates.length === 0) {
    log('  [promoter] no passing train candidates — skipping');
    return { nominated: [], skipped: [], unmatched: [], duplicates: [], parseErrors: [], reviewerOutput: null };
  }

  const payload = buildPromoterPayload({ candidates, currentGolden, failingEntries, config });
  log(`  [promoter] evaluating ${candidates.length} candidate(s)...`);

  let output = '';
  try {
    output = await claude(payload, {
      systemPrompt: readPrompt(config.promptsDir, config.promoterPromptFile || 'promoter.md'),
      model: config.promoterModel || 'sonnet',
      timeout: config.promoterTimeout || 180_000,
      cwd: config.projectRoot,
    });
  } catch (err) {
    log(`  [promoter] LLM call failed: ${err.message || err}`);
    return { nominated: [], skipped: [], unmatched: [], duplicates: [], parseErrors: [`LLM call failed: ${err.message || err}`], reviewerOutput: null };
  }

  const parsed = parsePromoterOutput(output);
  const validationErrors = validatePromoterOutput(parsed);
  const parseErrors = [...(parsed.parseErrors || []), ...validationErrors];

  if (parseErrors.length > 0) {
    log(`  [promoter] WARNING: ${parseErrors.length} validation issue(s):`);
    for (const e of parseErrors) log(`    - ${e}`);
  }

  const summary = applyPromoterDecisions({ reviewerOutput: parsed, candidates, config, runId });
  log(`  [promoter] nominated=${summary.nominated.length} skipped=${summary.skipped.length} unmatched=${summary.unmatched.length} duplicates=${summary.duplicates.length}`);
  return { ...summary, parseErrors, reviewerOutput: parsed };
}
```

Note on the unused `normalizeErrorText` import — the promoter doesn't actually need it for this pass. **Delete the import line** `import { normalizeErrorText } from './failing-prompts.mjs';` before committing. (Leaving it in causes an unused-import warning that will be flagged by the code review.)

- [ ] **Step 8: Run promoter tests to confirm pass**

Run: `cd /Users/michaelperret/dev/mcp-evolve && node --test test/promoter.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 9: Create `prompts/promoter.md` — the promoter system prompt**

Create `prompts/promoter.md`:

```
You are the mcp-evolve Promoter-Agent. You evaluate candidate prompts from the current run for graduation to the persistent **golden** tier — the prompts that will run on every future iteration as a stable regression suite. Your job is NOT to nominate prompts that passed — your job is to nominate prompts that *should anchor future coverage*.

You will be given:

1. The current list of golden prompts and their capability tags (what they already cover)
2. A list of passing train candidates from this run, each with: persona, prompt text, probe invariant, tools used
3. An anti-examples section: prompts that a previous run's reviewer rejected. You MUST NOT nominate these or their near-duplicates.

## Nomination criteria

Nominate a candidate ONLY if ALL of the following hold:

1. **Semantic distinctness.** The candidate exercises a capability NOT already covered by an existing golden prompt. "Different phrasing of the same intent" is a duplicate, not a distinct capability. Same persona + same tool + same underlying operation = duplicate.

2. **Clean pass.** The candidate passed without retries, without probe invariant violations, and without harness warnings. If you see any friction signal, skip it.

3. **Idempotent or deterministic state change.** Golden prompts replay every run. If the candidate calls write tools, ask: would running this same prompt twice produce garbage? (E.g., "create a new guest called Anna" — no; "update guest 5's priority to high" — yes, idempotent.) Adversarial or destructive-create prompts are NOT candidates.

4. **Anchor value.** Would losing this capability be a noticeable regression? A prompt that tests a core user story is an anchor. A prompt that tests an edge case of an edge case is not.

5. **Contamination sanity check.** Read the candidate's probe invariant. Does it contradict anything you can see in the tool calls or response? For example, if the invariant says "Tisch 5 must be empty before seating" but the prompt successfully seated a guest at a table that already had another guest, the invariant is wrong. Do NOT nominate candidates with contaminated invariants — Spec 1's reviewer catches contamination during fixer phases, but a candidate that passed WITHOUT triggering the fixer bypasses that check. This criterion closes the gap.

6. **Not on the anti-examples list.** If the anti-examples section contains a semantically similar prompt (same persona, same intent), do NOT nominate — it was rejected for a reason.

## Cap

Nominate AT MOST `maxNominations` candidates per run (given at the top of the payload; typical value 3). It's OK to nominate fewer — quality over quantity. If nothing meets all six criteria, nominate zero.

## Output format

Emit exactly two tagged JSON blocks at the end of your response:

```
<NOMINATIONS>
[
  {
    "promptId": "<exact promptId from input: '{persona}::{prompt}'>",
    "capabilityTag": "<short kebab-case tag, e.g. 'walk-in-seating' or 'payment-split'>",
    "confidence": "high" | "medium",
    "reason": "<one-sentence rationale tied to the criteria above>"
  }
]
</NOMINATIONS>

<SKIPPED>
[
  {
    "promptId": "<exact promptId>",
    "reason": "<why not nominated — cite which criterion failed>"
  }
]
</SKIPPED>
```

**Constraints:**
- Both blocks are JSON arrays. Never emit YAML, Markdown tables, or prose in the tagged blocks.
- Every candidate in the input appears exactly ONCE across `NOMINATIONS` and `SKIPPED` combined.
- `confidence: "high"` means "I am confident this is a distinct, anchor-worthy capability." `medium` means "probably worth it, but I'd accept a later rejection."
- `capabilityTag` must be unique among your nominations this run — if two candidates would produce the same tag, they're near-duplicates, pick one and skip the other.
- Do not emit any commentary after `</SKIPPED>`.
```

- [ ] **Step 10: Run the full suite**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS. Test count 82 (67 + 10 promoter-protocol + 5 promoter).

- [ ] **Step 11: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/promoter.mjs lib/promoter-protocol.mjs prompts/promoter.md test/promoter.test.mjs test/promoter-protocol.test.mjs
git commit -m "feat(promoter): add Promoter-Agent module (pure + async wrapper), protocol parser, and LLM system prompt"
```

---

### Task 6: Destructive cut — delete legacy mode, persona.group, dead functions, init v2, loadPromptSet v1 rejection

This is the biggest task by LOC (~450 deletions, ~80 additions). It removes every non-Spec-2 code path in one coherent cut so the remaining tasks can add new behavior on a clean substrate. It touches `lib/run.mjs`, `lib/eval.mjs`, `lib/personas.mjs`, `lib/init.mjs`, `lib/audit.mjs`, `lib/autodev.mjs`, `bin/cli.mjs`, plus existing test fixtures in `test/audit.test.mjs` that reference `group: 'golden'` hardcoded.

**Files:**
- Modify: `lib/eval.mjs` (delete dead functions)
- Modify: `lib/personas.mjs:108-114` (delete `getPersonasByGroup`)
- Modify: `lib/init.mjs:74-154` (replace `fullInit` body)
- Modify: `lib/audit.mjs:192,199` (`wasGolden` + golden filter use lifecycle)
- Modify: `lib/autodev.mjs:70,199` (drop persona.group references)
- Modify: `lib/run.mjs` (the main surgery — see steps below)
- Modify: `bin/cli.mjs:14-15,35-36,82-83,252-253` (delete --train/--eval)
- Modify: `bin/cli.mjs:142-188` (status command cleanup)
- Modify: `test/audit.test.mjs` (update fixtures: `group` → `lifecycle`)

- [ ] **Step 1: Delete dead functions from `lib/eval.mjs`**

In `lib/eval.mjs`, delete the following blocks (by line range as of HEAD):

Delete lines 445–540 (the entire `// --- Golden Set ---` section through end of `updateGoldenHealth`):

```js
// --- Golden Set ---

export function loadGoldenSet(config) {
  // ... entire function ...
}

export function promoteToGoldenSet(persona, promptText, fixCycle, config, promptObj = null) {
  // ... entire function ...
}

export function getGoldenPrompts(personaId, config) {
  // ... entire function ...
}

/**
 * Record golden set prompt results after a run.
 * ...
 */
export function updateGoldenHealth(results, config) {
  // ... entire function ...
}
```

Also delete lines 556–649 (`createPromptSet`, `updatePromptSetAfterRun`, `addTrainPrompts`, `getPromptsByGroup`). Keep `loadPromptSet` and `savePromptSet` — they stay.

The remaining prompt-set block should look like:

```js
// --- Prompt Set (v2: golden only, ephemeral train per run) ---

export function loadPromptSet(config) {
  try {
    const raw = JSON.parse(readFileSync(config.promptSetPath, 'utf-8'));
    // Spec 2: reject any prompt-set whose entries lack `lifecycle`. V1 files
    // have `group: 'train'|'golden'` on each prompt and contaminated invariants;
    // they must not be silently interpreted as v2.
    if (raw && Array.isArray(raw.prompts) && raw.prompts.some(p => p && typeof p === 'object' && !p.lifecycle)) {
      throw new Error(
        `v1 prompt-set detected at ${config.promptSetPath}. Delete or archive it and run \`node bin/cli.mjs init -c <your-config>\`.`
      );
    }
    return raw;
  } catch (err) {
    // If the file doesn't exist, return null (legacy behavior).
    if (err && err.code === 'ENOENT') return null;
    // If the file is unparseable OR v1 rejection fired, re-throw so the
    // caller sees a clear error.
    if (err && err.message && /v1 prompt-set/.test(err.message)) throw err;
    return null;
  }
}

export function savePromptSet(ps, config) {
  writeFileSync(config.promptSetPath, JSON.stringify(ps, null, 2) + '\n');
}
```

Also remove the `DEFAULT_GOLDEN_MAX` constant at line 11 (it was only used by `loadGoldenSet`).

- [ ] **Step 2: Delete `getPersonasByGroup` from `lib/personas.mjs`**

Find lines 108–114 of `lib/personas.mjs`:

```js
/**
 * Get personas filtered by group.
 */
export function getPersonasByGroup(personas, group) {
  return personas.filter(p => (p.group || 'train') === group);
}
```

Delete them. Also delete any reference to `persona.group` in the persona-map display helper around line 95 — find:

```js
      const grp = p.group || 'train';
```

Replace the whole line + whatever it's used for with a fallback to just the persona id. (The grep on this file earlier showed only two references: the deletion at line 112–113, and one in `printPersonaMap` at line 95. Read the function to see the exact change — if `grp` is only used in a label, replace with a static string or drop it from the label entirely.)

- [ ] **Step 3: Update `lib/audit.mjs` to use `lifecycle` instead of `group`**

In `lib/audit.mjs`, find line 192:

```js
    droppedPrompts.push({
      persona, prompt: promptText,
      reason: pr.reason,
      invariantStatus: pr.invariantStatus,
      wasGolden: scored?.group === 'golden',
    });
```

Replace with:

```js
    droppedPrompts.push({
      persona, prompt: promptText,
      reason: pr.reason,
      invariantStatus: pr.invariantStatus,
      wasGolden: scored?.lifecycle === 'golden',
    });
```

Find lines 196–204 (golden filter):

```js
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
```

Replace `p.group === 'golden'` with `p.lifecycle === 'golden'`:

```js
    // If the dropped prompt is in the persisted prompt-set as golden, remove it.
    if (promptSet && Array.isArray(promptSet.prompts)) {
      const before = promptSet.prompts.length;
      promptSet.prompts = promptSet.prompts.filter(p =>
        !(p.persona === persona && p.prompt === promptText && p.lifecycle === 'golden')
      );
      if (promptSet.prompts.length !== before) {
        promptSetChanged = true;
      }
    }
```

- [ ] **Step 4: Update `test/audit.test.mjs` fixtures to use `lifecycle` instead of `group`**

In `test/audit.test.mjs`, find every instance of `group: 'golden'`, `group: 'train'`, `q.group`, and `scoredPrompts` fixtures. Replace `group` with `lifecycle` in the scored-prompt shapes and in the prompt-set fixture shapes.

Specifically:
- Test at line 17 (`'applyAuditDecisions marks prompts invalid...'`): `scoredPrompts` entries use `group: 'train'` → change to `lifecycle: 'train', evaluation: 'fixer'`. The prompt-set fixture at line 20 (`{ version: 1, prompts: [] }`) → change to `{ version: 2, prompts: [] }`.
- Test at line 80 (`'applyAuditDecisions removes golden prompt from prompt-set.json...'`): the prompt-set fixture has prompts with `group: 'golden'` — change to `lifecycle: 'golden', evaluation: 'fixer'`. The `scoredPrompts` entry uses `group: 'golden'` — change to `lifecycle: 'golden', evaluation: 'fixer'`. The `wasGolden` assertion implicit.
- Tests at lines 123, 155, 180 — prompt-set fixtures become `{ version: 2, prompts: [] }`.

After this step, `test/audit.test.mjs` fixtures should reference lifecycle/evaluation exclusively.

- [ ] **Step 5: Rewrite `lib/init.mjs` — `fullInit` creates an empty v2 prompt-set**

In `lib/init.mjs`, replace the entire `fullInit` function (lines 74–154) with:

```js
export async function fullInit(config) {
  log('mcp-evolve init (Spec 2: empty v2 prompt-set)');
  log(`System: ${config.systemDescription}`);

  // Ensure data directory exists
  const dataDir = config.dataDir;
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Spec 2: init no longer generates prompts at scaffold time. Prompts are
  // generated fresh every run. We write an empty v2 prompt-set so the
  // subsequent run loop has a file to read (and so loadPromptSet's v1
  // rejection check does not false-positive on a missing file).
  const empty = {
    version: 2,
    generatedAt: new Date().toISOString(),
    prompts: [],
  };

  const { savePromptSet } = await import('./eval.mjs');
  savePromptSet(empty, config);
  log(`Wrote empty v2 prompt-set to ${config.promptSetPath}`);
  log(`Personas: ${(config.personas || []).length} configured. Prompts will be generated fresh on first run.`);

  return empty;
}
```

Also remove the now-unused imports at the top of `lib/init.mjs`:
- `import { llm } from './llm.mjs';` — delete (no longer used)
- `import { createPromptSet, savePromptSet } from './eval.mjs';` — delete (createPromptSet is gone; savePromptSet is dynamically imported inside the function to avoid a circular-import concern, though in practice there is none — you may keep the static import if you prefer; either works)
- `import { generatePrompts, runSeed, runReset, getStateDescription, runPrefetch } from './run.mjs';` — delete (no longer used at init time)
- `import { buildRunDateContext } from './dates.mjs';` — delete

Also delete the `generatePersonas` function (lines 27–70) — it was only called from `fullInit` and is no longer needed. (If you want to preserve the capability for a future manual step, move it to a separate file; for Spec 2, delete.)

- [ ] **Step 6: Update `lib/autodev.mjs` to drop persona.group references**

In `lib/autodev.mjs`, find line 70:

```js
        `**Persona:** ${bq.persona} (${bq.group || 'train'})`,
```

Replace with:

```js
        `**Persona:** ${bq.persona}`,
```

Find line 199:

```js
          const persona = { id: bq.persona, name: bq.persona, role: bq.group || 'train' };
```

Replace with:

```js
          const persona = { id: bq.persona, name: bq.persona, role: 'user' };
```

Note: auto-dev in Spec 2 is called from the promoter-adjacent code path (future enhancement — not strictly required in this plan). For now, keep the function importable but unreferenced in the main `run()` body after Task 6. If `lib/run.mjs` still imports `autoDev` after the surgery, leave the import; if not, remove it. Step 10 of this task handles the run.mjs import cleanup.

- [ ] **Step 7: Update `bin/cli.mjs` — delete `--train`/`--eval` flags, update help text, rewrite `status` command**

Find the CLI help text around lines 13–16:

```js
 *   mcp-evolve --skip-fixer          # Skip fixer step
 *   mcp-evolve --train               # Train personas only
 *   mcp-evolve --eval                # Eval personas only (hold-out)
 *   mcp-evolve --escalate            # Force escalation
```

Delete the `--train` and `--eval` lines, keep the surrounding lines:

```js
 *   mcp-evolve --skip-fixer          # Skip fixer step
 *   mcp-evolve --escalate            # Force escalation
```

Find the `parseArgs` options at lines 29–57. Remove `train` and `eval`:

```js
    'skip-fixer': { type: 'boolean' },
    train: { type: 'boolean' },
    eval: { type: 'boolean' },
    'answerer-model': { type: 'string' },
```

Becomes:

```js
    'skip-fixer': { type: 'boolean' },
    'answerer-model': { type: 'string' },
```

Find the `--help` text block at line 67. Delete the two lines:

```
  --train                Train personas only
  --eval                 Eval personas only (hold-out, no fixer)
```

Find the `run(config, { ... })` call at lines 248–271. Remove `trainOnly` and `evalOnly` from the args object:

```js
    trainOnly: args.train,
    evalOnly: args.eval,
```

Simply delete those two lines.

Now update the `status` command block (lines 142–188). Replace lines 155–170 (the `loadPromptSet` / `loadGoldenSet` fallback block):

```js
    const ps = loadPromptSet(config);
    if (ps) {
      const train = getPromptsByGroup(ps, 'train');
      const golden = getPromptsByGroup(ps, 'golden');
      console.log(`\nPrompt set: ${ps.prompts.length} total (${train.length} train, ${golden.length} golden)`);
      for (const q of ps.prompts) {
        const badge = q.group === 'golden' ? '[golden]' : `[train ${q.consecutivePasses || 0}/${config.graduationStreak || 10}]`;
        console.log(`  ${badge} [${q.persona}] ${q.prompt.slice(0, 70)}`);
      }
    } else {
      const gs = loadGoldenSet(config);
      console.log(`\nGolden set (legacy): ${gs.prompts.length} prompts`);
      for (const q of gs.prompts) {
        console.log(`  [${q.persona}] ${q.prompt.slice(0, 80)}`);
      }
    }
```

Replace with:

```js
    const ps = loadPromptSet(config);
    if (ps) {
      const golden = ps.prompts.filter(q => q.lifecycle === 'golden');
      console.log(`\nPrompt set: ${ps.prompts.length} persisted (${golden.length} golden, train+holdout generated fresh per run)`);
      for (const q of golden) {
        const tag = q.promoterEvidence?.capabilityTag || '(untagged)';
        const passes = q.consecutivePasses || 0;
        console.log(`  [golden x${passes}] [${q.persona}] ${tag}: ${q.prompt.slice(0, 60)}`);
      }
    } else {
      console.log('\nNo prompt-set.json found. Run `node bin/cli.mjs init -c <config>` to scaffold.');
    }
```

Also update the import at line 27:

```js
import { loadGoldenSet, loadPromptSet, getPromptsByGroup, checkStreak } from '../lib/eval.mjs';
```

Becomes:

```js
import { loadPromptSet, checkStreak } from '../lib/eval.mjs';
```

- [ ] **Step 8: Delete legacy mode from `lib/run.mjs` — imports, globals, personaSelect, loading blocks**

This is the biggest sub-step. Work through `lib/run.mjs` top-to-bottom.

**8a. Update imports at line 32–42**. Replace:

```js
import { getPersona, getPersonasByGroup } from './personas.mjs';
import {
  scorePrompt, aggregateScores, saveBaseline, loadBaseline,
  compareToBaseline, printRegressionReport, checkDiversity, computeDistributionDrift, getPreviousPrompts,
  loadGoldenSet, promoteToGoldenSet, getGoldenPrompts, checkStreak, updateGoldenHealth,
  loadPromptSet, savePromptSet, updatePromptSetAfterRun, addTrainPrompts, getPromptsByGroup,
  isActionRequest as isActionRequestFn,
  buildActionPattern,
  isPassingScore,
  classifyErrorCategory,
} from './eval.mjs';
```

With:

```js
import { getPersona } from './personas.mjs';
import {
  scorePrompt, aggregateScores, saveBaseline, loadBaseline,
  compareToBaseline, printRegressionReport, checkDiversity, computeDistributionDrift, getPreviousPrompts,
  checkStreak,
  loadPromptSet, savePromptSet,
  splitForHoldout, overfittingDetection,
  isActionRequest as isActionRequestFn,
  buildActionPattern,
  isPassingScore,
  classifyErrorCategory,
} from './eval.mjs';
import { runPromoter } from './promoter.mjs';
import { loadFailingPrompts, getFailingForPersona } from './failing-prompts.mjs';
```

(The `getFailingPatterns` import from `'./failing-prompts.mjs'` at line 47 stays — don't touch that line.)

**8b. Delete persona selection for `--train`/`--eval`**. Find lines 887–896:

```js
  } else if (trainOnly) {
    selectedPersonas = getPersonasByGroup(config.personas, 'train');
  } else if (evalOnly) {
    selectedPersonas = getPersonasByGroup(config.personas, 'eval');
  } else {
    selectedPersonas = config.personas;
  }
```

Replace with:

```js
  } else {
    selectedPersonas = config.personas;
  }
```

Also delete the destructured args at lines 851–852 (remove `trainOnly` + `evalOnly`):

```js
    trainOnly = false,
    evalOnly = false,
```

Just delete them.

And line 903:

```js
  const effectiveSkipFixer = skipFixer || evalOnly;
```

Becomes:

```js
  const effectiveSkipFixer = skipFixer;
```

**8c. Remove `persona.group` from the startup log**. Find line 907:

```js
  log(`Personas: ${selectedPersonas.map(p => `${p.id}[${p.group || 'train'}]`).join(', ')}`);
```

Replace with:

```js
  log(`Personas: ${selectedPersonas.map(p => p.id).join(', ')}`);
```

**8d. Delete the legacy golden-set loading + globalGoldenHealthy block**. Find lines 941–973:

```js
  // Load prompt set (fixed sets mode) or fall back to legacy golden set
  const promptSet = loadPromptSet(config);
  const useFixedSets = !!promptSet;

  // Legacy golden set — only used if no prompt-set.json exists
  const goldenSet = useFixedSets ? { prompts: [] } : (skipGolden ? { prompts: [] } : loadGoldenSet(config));
  if (goldenMax && !useFixedSets) goldenSet.maxSize = goldenMax;

  if (useFixedSets) {
    const trainCount = getPromptsByGroup(promptSet, 'train').length;
    const goldenCount = getPromptsByGroup(promptSet, 'golden').length;
    log(`Prompt set: ${promptSet.prompts.length} prompts (${trainCount} train, ${goldenCount} golden)`);
  } else if (goldenSet.prompts.length > 0) {
    log(`Golden set: ${goldenSet.prompts.length} permanent regression prompts`);
  }

  let globalGoldenHealthy = true;
  if (!useFixedSets && goldenSet.prompts.length > 0 && !isRegression) {
    const lastBaseline = loadBaseline(null, config);
    if (lastBaseline) {
      const baselinePrompts = lastBaseline.prompts || lastBaseline.questions || [];
      const activeGolden = goldenSet.prompts.filter(q => !q.blocked && !q.obsolete);
      const activeGoldenKeys = new Set(activeGolden.map(q => `${q.persona}::${q.prompt}`));
      const lastGoldenResults = baselinePrompts.filter(q =>
        activeGoldenKeys.has(`${q.persona}::${q.prompt}`)
      );
      const goldenFailing = lastGoldenResults.some(q => !isPassingScore(q.score));
      if (goldenFailing) {
        globalGoldenHealthy = false;
        log('Golden set still failing — running in global golden-only mode');
      }
    }
  }
```

Replace with:

```js
  // Spec 2: prompt-set is the only mode. Golden prompts persist; train + holdout
  // are generated fresh per run (see Task 7's generation phase).
  const promptSet = loadPromptSet(config);
  if (!promptSet) {
    log(`No prompt-set.json found at ${config.promptSetPath}. Run \`node bin/cli.mjs init -c <config>\` first.`);
    if (prog) progress.completeRun(prog);
    return { scores: null, logData: null, allResults: [], allErrors: [] };
  }
  const goldenInSet = promptSet.prompts.filter(q => q.lifecycle === 'golden');
  log(`Prompt set: ${goldenInSet.length} golden prompt(s) persisted`);
```

**8e. Delete the entire legacy-mode else branch**. Find line 1139 (`// === LEGACY MODE (no prompt-set.json) ===`) through line 1252 (the closing `});` of the legacy mode block). This is ~113 lines of code to delete.

The block looks like:

```js
  // === LEGACY MODE (no prompt-set.json) ===
  } else {
    // --- Per-persona runner (legacy) ---
    async function runPersona(persona) {
      // ... ~100 lines ...
    }

    // Legacy mode runs generation + prompts interleaved per-persona in parallel.
    // ...
    await withPhase(prog, 'prompts_run', async () => {
      // ...
    });
  }
```

Delete the entire `else { ... }` block. The `if (useFixedSets && !isRegression && !dryRun) { ... }` at line 1064 becomes the only path — but since `useFixedSets` is gone in Step 8d, this conditional needs updating too.

Find line 1064:

```js
  // === FIXED SETS MODE ===
  if (useFixedSets && !isRegression && !dryRun) {
```

Replace with:

```js
  // === MAIN TEST LOOP ===
  if (!isRegression && !dryRun) {
```

And delete the closing `} else { ... }` block down through line 1252.

Inside the main test loop (former fixed-sets block), also delete the `maxTrainPerRun` / `maxGoldenPerRun` sampling at lines 1069–1076:

```js
    // Sample if maxTrainPerRun / maxGoldenPerRun is set
    function sampleUpTo(arr, max) {
      if (!max || arr.length <= max) return arr;
      const shuffled = [...arr].sort(() => Math.random() - 0.5);
      return shuffled.slice(0, max);
    }
    const trainQs = sampleUpTo(eligible.filter(q => q.group === 'train'), config.maxTrainPerRun);
    const goldenQs = sampleUpTo(eligible.filter(q => q.group === 'golden'), config.maxGoldenPerRun);
    const promptsToRun = [...trainQs, ...goldenQs];
```

Replace with a TEMPORARY placeholder that Task 7 will replace:

```js
    // [TASK 7] Task 7 will replace this with the generation phase (golden + fresh train + holdout).
    // For now, just use all non-obsolete persisted prompts so the main loop compiles.
    const promptsToRun = eligible;
```

**8f. Simplify the fixableErrors collection**. Find lines 1267–1298:

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

Replace with:

```js
    const fixableErrors = [];
    for (const r of allResults) {
      for (const q of r.prompts) {
        // Adversarial prompts: errors are expected, do NOT feed them to the fixer
        if (q.promptObj?.adversarial === true) continue;
        // Holdout prompts: their errors are for scoring, not for fixing.
        if (q.promptObj?.evaluation === 'holdout') continue;
        const mcpErrors = (q.errors || []).filter(e =>
          e.tool !== 'cli' && !NON_FIXABLE_HARNESS_TOOLS.has(e.tool) && e.category !== 'model'
        );
        if (mcpErrors.length > 0) {
          fixableErrors.push({
            persona: r.persona,
            prompt: q.prompt,
            errors: mcpErrors,
            debugLogErrors: q.debugLogErrors || [],
            probe: q.probeData?.probe || q.promptObj?.probe || null,
            invariant: q.probeData?.invariant || q.promptObj?.invariant || null,
            probeType: q.probeData?.probeType || q.promptObj?.probeType || null,
            lifecycle: q.promptObj?.lifecycle || 'train',
          });
        }
      }
    }
```

**8g. Simplify the audit scoredPrompts shadow**. Find lines 1346–1356:

```js
          scoredPrompts: allResults.flatMap(r =>
            r.prompts.map(q => ({
              persona: r.persona.id, prompt: q.prompt,
              group: (useFixedSets && promptSet)
                ? (promptSet.prompts.find(e => e.persona === r.persona.id && e.prompt === q.prompt)?.group || 'train')
                : (r.persona.group || 'train'),
              probeData: q.probeData || null,
              score: q.score,
            }))
          ),
```

Replace with:

```js
          scoredPrompts: allResults.flatMap(r =>
            r.prompts.map(q => ({
              persona: r.persona.id, prompt: q.prompt,
              lifecycle: q.promptObj?.lifecycle || 'train',
              evaluation: q.promptObj?.evaluation || 'fixer',
              probeData: q.probeData || null,
              score: q.score,
            }))
          ),
```

**8h. Delete legacy promoteToGoldenSet calls**. Find lines 1417–1423:

```js
        if (verdict === 'FIXED' && !useFixedSets) {
          if (promoteToGoldenSet(fe.persona, fe.prompt, {
            timestamp: new Date().toISOString(),
            originalErrors: origScore?.errorsFound || 0,
            originalStuck: origScore?.stuck || false,
          }, config)) log(`  PROMOTED to golden set`);
        }
```

Delete the entire block.

Find lines 1472–1479:

```js
          if (verdict2 === 'FIXED BY DEV' && !useFixedSets) {
            promoteToGoldenSet(sf.persona, sf.prompt, {
              timestamp: new Date().toISOString(),
              source: 'deep-fix',
              originalStuck: sf.replayScore.stuck,
            }, config);
            log(`  PROMOTED to golden set (deep fix)`);
          }
```

Delete the entire block.

**8i. Simplify model-error fixer filter**. Find line 1495:

```js
      if (!useFixedSets && (r.persona.group || 'train') !== 'train') continue;
```

Delete the line entirely (was a legacy-only filter).

**8j. Replace scoredPrompts transform**. Find lines 1567–1581:

```js
  // Score — in fixed-sets mode, group comes from prompt set; in legacy, from persona
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

Replace with (Task 9 extends this further — for now match the data shape the new aggregation needs):

```js
  // Score — lifecycle/evaluation come from the prompt's promptObj (set by the
  // generation phase in Task 7 or by promoter persistence).
  const scoredPrompts = allResults.flatMap(r =>
    r.prompts.map(q => ({
      persona: r.persona.id,
      prompt: q.prompt,
      lifecycle: q.promptObj?.lifecycle || 'train',
      evaluation: q.promptObj?.evaluation || 'fixer',
      promptObj: q.promptObj || null,
      score: q.score,
      scorePre: q.scorePre || null,
      scorePost: q.scorePost || null,
      adversarial: q.promptObj?.adversarial === true,
      invalid: q.invalid === true,
      invalidReason: q.invalidReason || null,
    }))
  );
```

**8k. Delete legacy obsolete-prompt removal + legacy graduation + legacy golden health update + legacy escalation `addTrainPrompts`**. Find lines 1583–1622:

```js
  // Remove obsolete prompts from prompt set — escalation will fill the gaps
  if (useFixedSets && !runInvalid && !dryRun) {
    const obsoletePrompts = allResults.flatMap(r =>
      r.prompts.filter(q => q.obsolete).map(q => ({ persona: r.persona.id, prompt: q.prompt }))
    );
    if (obsoletePrompts.length > 0) {
      const before = promptSet.prompts.length;
      promptSet.prompts = promptSet.prompts.filter(p =>
        !obsoletePrompts.some(o => o.persona === p.persona && o.prompt === p.prompt)
      );
      savePromptSet(promptSet, config);
      log(`\nREMOVED ${before - promptSet.prompts.length} obsolete prompt(s) — escalation will generate replacements`);
    }
  }

  // Save baseline
  if (!runInvalid && !dryRun) saveBaseline(allResults, answererModel, config);

  // Graduation — update prompt set pass tracking, graduate train -> golden
  if (useFixedSets && !runInvalid && !dryRun) {
    const graduated = updatePromptSetAfterRun(promptSet, allResults, config);
    if (graduated.length > 0) {
      log(`\nGRADUATED ${graduated.length} prompt(s) to golden:`);
      for (const g of graduated) {
        log(`  [${g.persona}] ${g.prompt.slice(0, 70)}...`);
      }

      // Graduation triggers escalation — replace graduated prompts with harder ones
      if (!noEscalate) {
        const allPs = promptSet.prompts.map(q => ({ persona: q.persona, prompt: q.prompt }));
        log(`\nGenerating ${graduated.length} replacement train prompts via escalation...`);
        const escalationResults = await withPhase(prog, 'escalate',
          () => escalate(allPs, fullContext, config, runDateContext));
        if (escalationResults.length > 0) {
          addTrainPrompts(promptSet, escalationResults, config);
          log(`  Added ${escalationResults.length} new train prompts`);
        }
      }
    }
  }
```

Replace with just the baseline save + obsolete-golden cleanup:

```js
  // Save baseline (Task 9 wires scorePre/scorePost into allResults before this)
  if (!runInvalid && !dryRun) saveBaseline(allResults, answererModel, config);

  // Obsolete-golden cleanup: if the grader flagged any golden prompt obsolete,
  // drop it from prompt-set.json. Train/holdout obsoletes are moot — they
  // never persist.
  if (!runInvalid && !dryRun) {
    const obsoleteGolden = allResults.flatMap(r =>
      r.prompts
        .filter(q => q.obsolete && q.promptObj?.lifecycle === 'golden')
        .map(q => ({ persona: r.persona.id, prompt: q.prompt }))
    );
    if (obsoleteGolden.length > 0) {
      const before = promptSet.prompts.length;
      promptSet.prompts = promptSet.prompts.filter(p =>
        !obsoleteGolden.some(o => o.persona === p.persona && o.prompt === p.prompt)
      );
      savePromptSet(promptSet, config);
      log(`\nREMOVED ${before - promptSet.prompts.length} obsolete golden prompt(s)`);
    }
  }
```

**8l. Delete the legacy golden-health + autodev block at lines 1624–1662**:

```js
  // Update golden set health — track consecutive fails, auto-dev blocked prompts (legacy mode)
  if (!useFixedSets && !runInvalid && !dryRun) {
    const { blocked: newlyBlocked } = updateGoldenHealth(allResults, config);
    // ... entire block ...
  }
```

Delete the entire block.

**8m. Simplify escalation path — remove `addTrainPrompts` persistence**. Find lines 1669–1707:

```js
  // Escalation — ONLY when everything passes
  if (!runInvalid && !dryRun && !noEscalate) {
    const currentAllPassed = scoredPrompts.length > 0 &&
      scoredPrompts.every(q => isPassingScore(q.score));

    // Legacy mode: also check for blocked golden prompts
    if (!useFixedSets) {
      const escGs = loadGoldenSet(config);
      const hasBlocked = (escGs.prompts || []).some(q => q.blocked);
      if (hasBlocked && !forceEscalate) {
        log(`\nEscalation skipped — ${(escGs.prompts || []).filter(q => q.blocked).length} blocked prompt(s). Fix those first.`);
      }
    }

    if (forceEscalate || currentAllPassed) {
      const streak = checkStreak(streakThreshold, config);
      if (forceEscalate || streak.triggered) {
        log(`\n100% STREAK: ${streak.streak} runs`);
        const escalationResults = await withPhase(prog, 'escalate',
          () => escalate(streak.allPassingPrompts, fullContext, config, runDateContext));

        // Fixed-sets mode: add escalation prompts as train to prompt set
        if (useFixedSets && escalationResults.length > 0) {
          addTrainPrompts(promptSet, escalationResults, config);
          log(`  Added ${escalationResults.length} escalation prompts to prompt set (as train)`);
        }
      }

      // Feature competition (streak-triggered)
      const competitionThreshold = streakThreshold * (config.competitionStreakMultiplier || 2);
      if (!args.noCompete && streak.streak >= competitionThreshold) {
        const passingLog = streak.allPassingPrompts
          .map(q => `[${q.persona}] ${q.prompt}`)
          .join('\n');
        await withPhase(prog, 'compete',
          () => runCompetition({ passingPrompts: passingLog, fullContext }, config));
      }
    }
  }
```

Replace with:

```js
  // Escalation — only when every golden prompt passes post-fix.
  if (!runInvalid && !dryRun && !noEscalate) {
    const goldenScored = scoredPrompts.filter(q => q.lifecycle === 'golden');
    const goldenAllPassed = goldenScored.length > 0 &&
      goldenScored.every(q => isPassingScore(q.scorePost || q.score));

    if (forceEscalate || goldenAllPassed) {
      const streak = checkStreak(streakThreshold, config);
      if (forceEscalate || streak.triggered) {
        log(`\n100% STREAK: ${streak.streak} run(s) with all golden passing`);
        // Escalation output is no longer persisted — it could be injected into
        // the next run's generation phase, but V1 Spec 2 does not wire that path.
        // Left as a log signal for now.
        await withPhase(prog, 'escalate',
          () => escalate(streak.allPassingPrompts, fullContext, config, runDateContext));
      }

      // Feature competition (streak-triggered)
      const competitionThreshold = streakThreshold * (config.competitionStreakMultiplier || 2);
      if (!args.noCompete && streak.streak >= competitionThreshold) {
        const passingLog = streak.allPassingPrompts
          .map(q => `[${q.persona}] ${q.prompt}`)
          .join('\n');
        await withPhase(prog, 'compete',
          () => runCompetition({ passingPrompts: passingLog, fullContext }, config));
      }
    }
  }
```

Also update the `escalate` function itself at line 820–834 — the legacy golden-set promotion block inside it:

```js
  // In legacy mode (no prompt-set.json), promote directly to golden set
  const promptSet = loadPromptSet(config);
  if (!promptSet) {
    let promoted = 0;
    for (const eq of escalatedPrompts) {
      const persona = getPersona(config.personas, eq.persona);
      if (!persona) continue;
      if (promoteToGoldenSet(persona, eq.prompt, {
        timestamp: new Date().toISOString(),
        source: 'escalation',
        reason: eq.why || 'auto-escalation',
      }, config, eq)) promoted++;
    }
    log(`  Promoted ${promoted} to golden set`);
  }
  // In fixed-sets mode, the caller adds to prompt-set.json
```

Delete. Replace with nothing — `escalate` just returns the generated prompts; the caller can use them.

Also in `escalate`, lines 795–800 reference `loadGoldenSet`:

```js
  // Drift guard: check if escalated prompts diverge from baseline distribution
  const baseline = loadBaseline(null, config);
  const goldenSet = loadGoldenSet(config);
  const referenceQs = [
    ...(baseline?.prompts || []).map(q => q.prompt),
    ...(goldenSet?.prompts || []).map(q => q.prompt),
  ];
```

Replace with (use the persisted prompt-set's golden tier as the reference instead):

```js
  // Drift guard: check if escalated prompts diverge from baseline distribution
  const baseline = loadBaseline(null, config);
  const currentPs = loadPromptSet(config);
  const referenceQs = [
    ...(baseline?.prompts || []).map(q => q.prompt),
    ...((currentPs?.prompts || []).filter(p => p.lifecycle === 'golden').map(q => q.prompt)),
  ];
```

**8n. Update log-scoring buckets**. Find lines 1720–1733:

```js
  // Write log
  const allScores = aggregateScores(scoredPrompts);
  const trainScores = aggregateScores(scoredPrompts.filter(q => q.group === 'train'));
  const goldenScores = aggregateScores(scoredPrompts.filter(q => q.group === 'golden'));
  const evalScores = aggregateScores(scoredPrompts.filter(q => q.group === 'eval'));

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
```

Replace with (Task 9 wires pre/post properly; this step just lays the scaffolding):

```js
  // Write log — scoring buckets use lifecycle/evaluation now. Pre/post fields
  // are wired in Task 9; this initial cut aliases them to the final `score`
  // so the log stays populated mid-migration.
  const validScored = scoredPrompts.filter(q => !q.invalid && !q.adversarial);
  const goldenQs = validScored.filter(q => q.lifecycle === 'golden');
  const trainFixerQs = validScored.filter(q => q.lifecycle === 'train' && q.evaluation === 'fixer');
  const holdoutQs = validScored.filter(q => q.lifecycle === 'train' && q.evaluation === 'holdout');

  const allScores = aggregateScores(validScored);
  const goldenPost = aggregateScores(goldenQs, 'scorePost');
  const goldenPre = aggregateScores(goldenQs, 'scorePre');
  const trainPost = aggregateScores(trainFixerQs, 'scorePost');
  const trainPre = aggregateScores(trainFixerQs, 'scorePre');
  const holdoutPost = aggregateScores(holdoutQs, 'scorePost');
  const holdoutPre = aggregateScores(holdoutQs, 'scorePre');

  const logData = {
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    answererModel: answererModel || 'default',
    dateContext: runDateContext,
    invalid: runInvalid,
    invalidReasons,
    healthcheck: healthcheckResult,
    scores: {
      all: allScores,
      train: { pre: trainPre, post: trainPost },
      holdout: { pre: holdoutPre, post: holdoutPost },
      golden: { pre: goldenPre, post: goldenPost },
    },
    reviewer: buildReviewerLogSection(runState),
```

**8o. Remove `group: r.persona.group` from log results**. Find line 1748:

```js
    results: allResults.map(r => ({
      persona: r.persona.id,
      group: r.persona.group,
      prompts: r.prompts.map(q => ({
```

Replace with:

```js
    results: allResults.map(r => ({
      persona: r.persona.id,
      prompts: r.prompts.map(q => ({
```

**8p. Update `updateMetrics` call + summary print + return**. Find lines 1770–1777:

```js
  // Update metrics
  if (!runInvalid && !dryRun) {
    const mode = trainOnly ? 'train' : evalOnly ? 'eval' : isRegression ? 'regression' : 'full';
    try { progress.setPhase(prog, 'metrics_update'); } catch {}
    try {
      updateMetrics({ scores: { all: allScores, train: trainScores, golden: goldenScores, eval: evalScores }, results: allResults, errors: allErrors, logData, mode, runState }, config);
    } finally {
      try { progress.setPhase(prog, 'idle'); } catch {}
    }
  }
```

Replace with:

```js
  // Update metrics
  if (!runInvalid && !dryRun) {
    const mode = isRegression ? 'regression' : 'full';
    try { progress.setPhase(prog, 'metrics_update'); } catch {}
    try {
      updateMetrics({
        scores: {
          all: allScores,
          train: { pre: trainPre, post: trainPost },
          holdout: { pre: holdoutPre, post: holdoutPost },
          golden: { pre: goldenPre, post: goldenPost },
        },
        results: allResults, errors: allErrors, logData, mode, runState,
      }, config);
    } finally {
      try { progress.setPhase(prog, 'idle'); } catch {}
    }
  }
```

Find lines 1801–1804:

```js
  for (const [label, scores] of [['All', allScores], ['Train', trainScores], ['Golden', goldenScores], ['Eval', evalScores]]) {
    if (scores.total === 0) continue;
    log(`  ${label} (${scores.total}p): success=${scores.successRate}% | action=${scores.actionCompletionRate}% | errors/p=${scores.errorRate} | tools=${scores.avgTools}`);
  }
```

Replace with:

```js
  const summaryRows = [
    ['All',        allScores],
    ['Train pre',  trainPre],
    ['Train post', trainPost],
    ['Holdout pre',  holdoutPre],
    ['Holdout post', holdoutPost],
    ['Golden pre',  goldenPre],
    ['Golden post', goldenPost],
  ];
  for (const [label, scores] of summaryRows) {
    if (!scores || scores.total === 0) continue;
    log(`  ${label} (${scores.total}p): success=${scores.successRate}% | action=${scores.actionCompletionRate}% | errors/p=${scores.errorRate} | tools=${scores.avgTools}`);
  }
```

Find line 1827:

```js
  return { scores: { all: allScores, train: trainScores, golden: goldenScores, eval: evalScores }, logData, allResults, allErrors };
```

Replace with:

```js
  return {
    scores: {
      all: allScores,
      train: { pre: trainPre, post: trainPost },
      holdout: { pre: holdoutPre, post: holdoutPost },
      golden: { pre: goldenPre, post: goldenPost },
    },
    logData, allResults, allErrors,
  };
```

- [ ] **Step 9: Run the full test suite**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS. Test count 82 (same as after Task 5 — this task is mostly destructive so no new tests; the fixture updates in step 4 keep `test/audit.test.mjs` passing).

If any test fails, the most likely causes are:
- A leftover import of a deleted function somewhere. Grep for the function name across `lib/` and `test/`.
- A leftover reference to `persona.group` or `q.group` or `useFixedSets`. Grep:

  ```bash
  cd /Users/michaelperret/dev/mcp-evolve && git grep -n "persona.group\|useFixedSets\|updatePromptSetAfterRun\|updateGoldenHealth\|loadGoldenSet\|promoteToGoldenSet\|getGoldenPrompts\|createPromptSet\|addTrainPrompts\|getPromptsByGroup\|getPersonasByGroup\|graduationStreak\|goldenBlockThreshold\|maxTrainPerRun\|maxGoldenPerRun" lib/ bin/ test/
  ```

  The grep should return zero results. Any match is a missed reference — fix it.

- [ ] **Step 10: Final imports cleanup pass on `lib/run.mjs`**

Re-read the top of `lib/run.mjs`. Ensure these imports are gone or updated:
- `getPersonasByGroup` — removed
- `loadGoldenSet`, `promoteToGoldenSet`, `getGoldenPrompts`, `updateGoldenHealth` — removed
- `updatePromptSetAfterRun`, `addTrainPrompts`, `getPromptsByGroup` — removed
- `splitForHoldout`, `overfittingDetection` — ADDED
- `runPromoter` — ADDED (from `./promoter.mjs`)
- `loadFailingPrompts`, `getFailingForPersona` — ADDED (from `./failing-prompts.mjs`)

- [ ] **Step 11: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/run.mjs lib/eval.mjs lib/personas.mjs lib/init.mjs lib/audit.mjs lib/autodev.mjs bin/cli.mjs test/audit.test.mjs
git commit -m "refactor(spec-2): destructive cut — delete legacy mode, persona.group, dead eval functions, --train/--eval flags; init writes empty v2 prompt-set"
```

---

### Task 7: Fresh train+holdout generation phase

**Files:**
- Modify: `lib/run.mjs` — the placeholder at `eligible`/`promptsToRun` inside the main test loop (inserted by Task 6 Step 8e) is replaced with the real generation phase.

- [ ] **Step 1: Locate the placeholder inserted in Task 6**

In `lib/run.mjs`, find the block inserted in Step 8e:

```js
    // [TASK 7] Task 7 will replace this with the generation phase (golden + fresh train + holdout).
    // For now, just use all non-obsolete persisted prompts so the main loop compiles.
    const promptsToRun = eligible;
```

Also find the preceding lines that compute `eligible`:

```js
    // Filter prompts to selected personas
    const selectedIds = new Set(selectedPersonas.map(p => p.id));
    const eligible = promptSet.prompts.filter(q => selectedIds.has(q.persona) && !q.obsolete);
```

- [ ] **Step 2: Replace with the generation phase**

Replace both blocks (the `eligible` filter and the `promptsToRun = eligible` placeholder) with:

```js
    // --- Spec 2: Generation phase — fresh train+holdout every run ---

    // 1. Load golden from the persisted prompt-set (only persistent tier).
    const selectedIds = new Set(selectedPersonas.map(p => p.id));
    const goldenLoaded = promptSet.prompts
      .filter(q => q.lifecycle === 'golden' && selectedIds.has(q.persona) && !q.obsolete)
      .map(q => ({
        persona: q.persona,
        prompt: q.prompt,
        promptObj: {
          ...(q.promptObj || {}),
          prompt: q.prompt,
          lifecycle: 'golden',
          evaluation: q.evaluation || 'fixer',
          probe: q.promptObj?.probe ?? null,
          invariant: q.promptObj?.invariant ?? null,
          probeType: q.promptObj?.probeType ?? null,
          adversarial: q.promptObj?.adversarial === true,
        },
      }));

    // 2. For each selected persona, generate N fresh prompts and split K as holdout.
    const runStartIso = new Date().toISOString();
    const failingStore = loadFailingPrompts(config);
    const generatedPerPersona = await Promise.all(selectedPersonas.map(async (persona) => {
      const failingEntries = getFailingForPersona(config, persona.id);
      let rawPrompts = [];
      try {
        let endGen = () => {};
        try { endGen = progress.recordSubPhase(prog, 'generation'); } catch {}
        try {
          rawPrompts = await generatePrompts(persona, config, fullContext, runDateContext, failingEntries);
        } finally {
          try { endGen(); } catch {}
        }
      } catch (err) {
        log(`  [gen] ${persona.id} generation failed: ${err.message || err}`);
        rawPrompts = [];
      }

      // Normalize to the {persona, prompt, promptObj} shape used by the run loop.
      const normalized = rawPrompts.map(q => {
        const text = typeof q === 'object' ? (q.prompt || q.question || '') : String(q);
        const obj = typeof q === 'object'
          ? { ...q, prompt: text }
          : { prompt: text };
        return { persona: persona.id, prompt: text, promptObj: obj };
      }).filter(p => p.prompt);

      // Deterministic K-of-N in-batch split; mutates promptObj.lifecycle + .evaluation.
      return splitForHoldout(normalized, config.holdoutPerPersona || 1, `${runStartIso}-${persona.id}`);
    }));

    const freshTrain = generatedPerPersona.flat();

    // 3. Build promptsToRun = golden + fresh train (including the holdout split).
    // The downstream "runAndGrade per prompt" loop iterates this list; golden
    // comes first so the progress UI shows persistent prompts first.
    const promptsToRun = [...goldenLoaded, ...freshTrain];

    const goldenCount = goldenLoaded.length;
    const trainCount = freshTrain.filter(p => p.promptObj?.evaluation === 'fixer').length;
    const holdoutCount = freshTrain.filter(p => p.promptObj?.evaluation === 'holdout').length;
    log(`Generation: ${goldenCount} golden + ${trainCount} train + ${holdoutCount} holdout = ${promptsToRun.length} prompts`);
```

- [ ] **Step 3: Run the full test suite**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS. Test count 82 (same as Task 6).

This task doesn't add new tests — the `splitForHoldout` helper already has coverage from Task 3, and the generation wiring is integration-level (exercised end-to-end by Task 12).

- [ ] **Step 4: Manual smoke check — dry run on task-manager**

Run:

```bash
cd /Users/michaelperret/dev/mcp-evolve && node bin/cli.mjs init -c examples/task-manager/evolve.config.mjs
```

This should write `examples/task-manager/.mcp-evolve/prompt-set.json` as `{version: 2, prompts: [], generatedAt: ...}`. Verify:

```bash
cat examples/task-manager/.mcp-evolve/prompt-set.json
```

Expected: `{ "version": 2, "generatedAt": "...", "prompts": [] }`.

Then (optional — don't do this if you don't have the MCP server built):

```bash
cd /Users/michaelperret/dev/mcp-evolve && node bin/cli.mjs -c examples/task-manager/evolve.config.mjs --dry-run
```

(Dry run will fail without a running MCP — that's expected. The check is that the generation phase doesn't crash before reaching prompt execution.)

- [ ] **Step 5: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/run.mjs
git commit -m "feat(run): Spec 2 generation phase — loads golden, generates train, in-batch holdout split"
```

---

### Task 8: Pre-fix scoring + scorePre population

**Files:**
- Modify: `lib/run.mjs` — `runAndGrade` stores `scorePre` on the result; the prompts-running chunk populates `q.scorePre` on every scored prompt before the fixer phase runs.

- [ ] **Step 1: Set `scorePre` on every scored prompt after the initial grade pass**

In `lib/run.mjs`, find `runAndGrade` around line 979. The function ends at line 1061 with:

```js
    const score = scorePrompt({ prompt: pText, ...result }, config);
    result.score = score;
    return { prompt: pText, promptObj, persona, ...result };
  }
```

Replace with:

```js
    const score = scorePrompt({ prompt: pText, ...result }, config);
    result.score = score;
    // Spec 2: scorePre is the first-pass score (before any fixer/replay).
    // scorePost is populated in the replay phase (Task 9).
    result.scorePre = score;
    return { prompt: pText, promptObj, persona, ...result };
  }
```

- [ ] **Step 2: Confirm the scoredPrompts transform picks up `scorePre`**

The transform from Task 6 Step 8j already reads `q.scorePre || null`. No further edit needed — this step is a verification.

- [ ] **Step 3: Run the full test suite**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS. Test count still 82.

- [ ] **Step 4: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/run.mjs
git commit -m "feat(run): populate scorePre on every prompt after first grade pass"
```

---

### Task 9: Replay all prompts + scorePost + overfitting detection

**Files:**
- Modify: `lib/run.mjs` — expand the current "replay failed prompts" block into "replay all prompts including holdout"; populate `scorePost` on every scored prompt; compute `runState.overfitting`.

- [ ] **Step 1: Rewrite the replay block**

In `lib/run.mjs`, find the current replay block around lines 1399–1437:

```js
      // Replay all failed prompts in parallel (always, not just after build)
      log(`  Replaying ${fixableErrors.length} failed prompts in PARALLEL...`);
      try { progress.setPhase(prog, 'replay'); } catch {}
      const replayResults = await Promise.all(fixableErrors.map(async (fe) => {
        const replay = await runPrompt(fe.prompt, fe.persona, config, runDateContext);
        const replayScore = scorePrompt({ prompt: fe.prompt, ...replay }, config);
        replay.score = replayScore;

        const originalQ = allResults
          .find(r => r.persona.id === fe.persona.id)
          ?.prompts.find(q => q.prompt === fe.prompt);
        const origScore = originalQ?.score;

        const fixed = isPassingScore(replayScore);
        const prevOk = isPassingScore(origScore);
        const verdict = fixed && !prevOk ? 'FIXED' : fixed ? 'STILL OK' : 'STILL FAILING';
        log(`  [${fe.persona.id}] Replay: ${verdict} (tools: ${origScore?.toolsUsed || '?'} -> ${replayScore.toolsUsed})`);

        const personaResult = allResults.find(r => r.persona.id === fe.persona.id);
        if (personaResult) {
          personaResult.prompts.push({ prompt: `[REPLAY] ${fe.prompt}`, ...replay });
        }

        return { persona: fe.persona, prompt: fe.prompt, verdict, replayScore };
      }));

      const fixedCount = replayResults.filter(r => r.verdict === 'FIXED').length;
      const stillFailing = replayResults.filter(r => r.verdict === 'STILL FAILING');
      log(`  Replay summary: ${fixedCount} FIXED, ${stillFailing.length} STILL FAILING`);
```

Replace with:

```js
      // Spec 2: Replay ALL prompts (including holdout), not just the failed ones.
      // Each prompt gets its scorePost from the replay result — even prompts that
      // passed pre-fix are re-run so pre/post deltas are comparable per-tier.
      const promptsToReplay = allResults.flatMap(r =>
        r.prompts.map(q => ({ persona: r.persona, q }))
      );
      log(`  Replaying ${promptsToReplay.length} prompt(s) (all tiers) in PARALLEL...`);
      try { progress.setPhase(prog, 'replay'); } catch {}

      // Throttle for local models (same pattern as the main run loop).
      const replayConcurrency = isLocalModel(config.answererModel || 'sonnet')
        ? (config.localConcurrency || 1)
        : promptsToReplay.length;

      const replayResults = [];
      for (let i = 0; i < promptsToReplay.length; i += replayConcurrency) {
        const chunk = promptsToReplay.slice(i, i + replayConcurrency);
        const chunkResults = await Promise.all(chunk.map(async ({ persona, q }) => {
          const replay = await runPrompt(q.prompt, persona, config, runDateContext);
          const replayScore = scorePrompt({ prompt: q.prompt, ...replay }, config);
          replay.score = replayScore;

          // Store scorePost back on the original scored entry so downstream
          // aggregation + logging + baseline see it.
          q.scorePost = replayScore;

          const pre = q.scorePre || q.score;
          const fixed = isPassingScore(replayScore);
          const prevOk = pre && isPassingScore(pre);
          const verdict = fixed && !prevOk ? 'FIXED'
                        : !fixed && prevOk ? 'REGRESSED'
                        : fixed ? 'STILL OK'
                        : 'STILL FAILING';
          log(`  [${persona.id}] [${q.promptObj?.lifecycle || 'train'}/${q.promptObj?.evaluation || 'fixer'}] Replay: ${verdict}`);

          return { persona, q, verdict, replayScore };
        }));
        replayResults.push(...chunkResults);
      }

      const fixedCount = replayResults.filter(r => r.verdict === 'FIXED').length;
      const regressedCount = replayResults.filter(r => r.verdict === 'REGRESSED').length;
      const stillFailing = replayResults.filter(r => r.verdict === 'STILL FAILING').map(r => ({
        persona: r.persona, prompt: r.q.prompt, replayScore: r.replayScore,
      }));
      log(`  Replay summary: ${fixedCount} FIXED, ${regressedCount} REGRESSED, ${stillFailing.length} STILL FAILING`);
```

Note the removal of `personaResult.prompts.push({ prompt: '[REPLAY] ...' })`. In Spec 2, replays update the existing scored entry in place via `q.scorePost = replayScore` — there are no duplicate `[REPLAY]` prompts in the scoredPrompts list anymore. If any downstream code filters on `!q.prompt.startsWith('[REPLAY]')` (see `lib/metrics.mjs:83` and `lib/metrics.mjs:130-140`), the filter becomes a no-op — leave it alone; it's harmless in the new shape.

- [ ] **Step 2: Update the deep-fix (autodev) block to use scorePost instead of pushing [DEV-REPLAY]**

Find the deep-fix replay block around lines 1462–1486:

```js
        for (const sf of stillFailing) {
          const replay2 = await runPrompt(sf.prompt, sf.persona, config, runDateContext);
          const replay2Score = scorePrompt({ prompt: sf.prompt, ...replay2 }, config);
          replay2.score = replay2Score;

          const fixed2 = isPassingScore(replay2Score);
          const verdict2 = fixed2 ? 'FIXED BY DEV' : 'STILL FAILING';
          log(`  [${sf.persona.id}] ${verdict2} (tools: ${sf.replayScore.toolsUsed} -> ${replay2Score.toolsUsed})`);

          const personaResult = allResults.find(r => r.persona.id === sf.persona.id);
          if (personaResult) {
            personaResult.prompts.push({ prompt: `[DEV-REPLAY] ${sf.prompt}`, ...replay2 });
          }
        }
```

Replace with:

```js
        for (const sf of stillFailing) {
          const replay2 = await runPrompt(sf.prompt, sf.persona, config, runDateContext);
          const replay2Score = scorePrompt({ prompt: sf.prompt, ...replay2 }, config);
          replay2.score = replay2Score;

          const fixed2 = isPassingScore(replay2Score);
          const verdict2 = fixed2 ? 'FIXED BY DEV' : 'STILL FAILING';
          log(`  [${sf.persona.id}] ${verdict2} (tools: ${sf.replayScore.toolsUsed} -> ${replay2Score.toolsUsed})`);

          // Update scorePost on the original scored entry.
          const personaResult = allResults.find(r => r.persona.id === sf.persona.id);
          const origQ = personaResult?.prompts.find(q => q.prompt === sf.prompt);
          if (origQ) {
            origQ.scorePost = replay2Score;
          }
        }
```

- [ ] **Step 3: Add overfitting detection after scoring buckets are computed**

In `lib/run.mjs`, find the block from Task 6 Step 8n where the aggregation buckets are computed (around the new "Write log" section). After the aggregation lines and before the `const logData = { ... }`, insert:

```js
  // Spec 2: Overfitting detection. train improved significantly AND holdout decayed?
  const perPromptPairs = scoredPrompts
    .filter(q => !q.invalid && !q.adversarial && q.lifecycle === 'train')
    .map(q => ({
      persona: q.persona,
      prompt: q.prompt,
      evaluation: q.evaluation,
      scorePre: q.scorePre,
      scorePost: q.scorePost,
    }));
  runState.overfitting = overfittingDetection({
    trainPre, trainPost, holdoutPre, holdoutPost,
    perPromptPairs,
    threshold: config.overfittingThreshold ?? 0.1,
  });

  if (runState.overfitting.detected) {
    log('');
    log('='.repeat(60));
    log(`OVERFITTING DETECTED: trainDelta=${runState.overfitting.trainDelta}, holdoutDelta=${runState.overfitting.holdoutDelta} (threshold=${runState.overfitting.threshold})`);
    log('='.repeat(60));
    for (const d of runState.overfitting.divergences) {
      log(`  ${d.persona}: ${d.holdoutRegressed.length} holdout regressed, ${d.trainImproved.length} train improved`);
    }
  }
```

- [ ] **Step 4: Wire `overfitting` into the log data**

In the `const logData = { ... }` object (around line 1725 post-Task-6), add an `overfitting` field after `reviewer: buildReviewerLogSection(runState),`:

```js
    reviewer: buildReviewerLogSection(runState),
    overfitting: runState.overfitting || { detected: false, trainDelta: 0, holdoutDelta: 0, threshold: config.overfittingThreshold ?? 0.1, divergences: [] },
```

- [ ] **Step 5: Run the full test suite**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS. Test count still 82.

- [ ] **Step 6: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/run.mjs
git commit -m "feat(run): replay all prompts (including holdout) for scorePost; overfitting detection via runState.overfitting"
```

---

### Task 10: Promoter-Agent invocation + promotion application

**Files:**
- Modify: `lib/run.mjs` — call `runPromoter` after overfitting detection, before the log write. Thread `runState.promoter` through.

- [ ] **Step 1: Add the Promoter invocation block**

In `lib/run.mjs`, find the section where overfitting detection was added in Task 9. Right after the overfitting log print (the `if (runState.overfitting.detected) { ... }` block) and before the `const logData = { ... }` assignment, insert:

```js
  // Spec 2: Promoter-Agent — nominate 0–3 passing train prompts for graduation.
  // Runs after overfitting detection and before log/metrics write so its
  // decisions are captured in runState.promoter and the run log.
  runState.promoter = { nominated: [], skipped: [], unmatched: [], duplicates: [], parseErrors: [], reviewerOutput: null };

  if (!runInvalid && !dryRun && !isRegression) {
    // Build the candidate list: train+fixer prompts that passed post-fix,
    // weren't dropped as invalid, aren't adversarial, aren't obsolete,
    // and aren't already in the failing-prompts store.
    const failingAll = failingStore.entries || [];
    const failingKeys = new Set(
      failingAll
        .filter(e => e.kind === 'prompt' && e.persona && e.prompt)
        .map(e => `${e.persona}::${e.prompt}`)
    );

    const candidates = [];
    for (const r of allResults) {
      for (const q of r.prompts) {
        if (q.promptObj?.lifecycle !== 'train') continue;
        if (q.promptObj?.evaluation !== 'fixer') continue;
        if (q.invalid === true) continue;
        if (q.promptObj?.adversarial === true) continue;
        if (q.obsolete === true) continue;
        const post = q.scorePost || q.score;
        if (!post || !isPassingScore(post)) continue;
        const key = `${r.persona.id}::${q.prompt}`;
        if (failingKeys.has(key)) continue;
        candidates.push({
          persona: r.persona.id,
          prompt: q.prompt,
          promptObj: q.promptObj || null,
          scorePre: q.scorePre || null,
          scorePost: post,
          toolCalls: (q.toolCalls || []).map(tc => tc.tool || tc),
        });
      }
    }

    const currentGolden = (promptSet?.prompts || []).filter(p => p.lifecycle === 'golden');

    if (candidates.length > 0) {
      try { progress.setPhase(prog, 'promoter'); } catch {}
      runState.promoter = await runPromoter({
        candidates,
        currentGolden,
        failingEntries: failingAll,
        config,
        runId: new Date().toISOString(),
      });
      try { progress.setPhase(prog, 'idle'); } catch {}

      if (runState.promoter.nominated.length > 0) {
        log(`\nPROMOTED ${runState.promoter.nominated.length} prompt(s) to golden:`);
        for (const n of runState.promoter.nominated) {
          log(`  [${n.persona}] ${n.promoterEvidence?.capabilityTag || '(untagged)'}: ${n.prompt.slice(0, 70)}`);
        }
      }
    } else {
      log(`  [promoter] no eligible candidates (0 passing train+fixer prompts after filters)`);
    }
  }
```

Note: this block references `failingStore` which was loaded in Task 7's generation phase (`const failingStore = loadFailingPrompts(config)`). If for any reason the generation phase is skipped (e.g., a future `isRegression` path), `failingStore` may be undefined. Guard with:

Find `const failingStore = loadFailingPrompts(config);` in Task 7's generation phase. The block above references `failingStore.entries || []` — that works fine as long as the generation phase runs. For robustness, at the top of the promoter block above, insert:

```js
  const failingStore = (typeof failingStore !== 'undefined' && failingStore) || loadFailingPrompts(config);
```

No — that's a variable-shadow trick that JS won't accept. Simpler: rename the generation-phase constant to something scoped, and re-load at the promoter site. Use this code at the very top of the promoter block instead:

```js
  // Re-load failing-prompts store for the promoter — don't rely on the
  // generation-phase local because regression mode skips generation.
  const promoterFailingStore = loadFailingPrompts(config);
```

And change `failingStore.entries` → `promoterFailingStore.entries` and `failingEntries: failingAll` accordingly.

- [ ] **Step 2: Add the promoter section to `logData`**

In the `const logData = { ... }` object (around where `overfitting` was added in Task 9), add a `promoter` field right after `overfitting`:

```js
    overfitting: runState.overfitting || { ... },
    promoter: {
      nominated: (runState.promoter?.nominated || []).map(n => ({
        persona: n.persona,
        prompt: n.prompt.slice(0, 200),
        capabilityTag: n.promoterEvidence?.capabilityTag,
        confidence: n.promoterEvidence?.confidence,
        reason: n.promoterEvidence?.reason,
      })),
      skipped: (runState.promoter?.skipped || []).map(s => ({ promptId: s.promptId, reason: s.reason })),
      unmatched: runState.promoter?.unmatched || [],
      duplicates: runState.promoter?.duplicates || [],
      parseErrors: runState.promoter?.parseErrors || [],
    },
```

- [ ] **Step 3: Run the full test suite**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS. Test count 82.

- [ ] **Step 4: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/run.mjs
git commit -m "feat(run): invoke Promoter-Agent after overfitting detection; thread runState.promoter into log"
```

---

### Task 11: Metrics + run-log additions

**Files:**
- Modify: `lib/metrics.mjs:14-34` (`emptyStore` — add `promotions` + `overfittingEvents`)
- Modify: `lib/metrics.mjs:54-183` (`updateMetrics` — record promoter + overfitting stats)

- [ ] **Step 1: Extend `emptyStore`**

In `lib/metrics.mjs`, find `emptyStore` at line 14:

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

Replace with:

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
    promotions: {
      totalPromoted: 0,
      lastPromotionRun: null,
      history: [],
    },
    overfittingEvents: {
      totalDetected: 0,
      history: [],
    },
    apparatus: { lastRefine: null, refineHistory: [] },
  };
}
```

- [ ] **Step 2: Record promoter + overfitting stats in `updateMetrics`**

In `lib/metrics.mjs`, find the end of the `updateMetrics` function (just before `saveMetrics(store, config); return store;` around line 180). After the `Record review stats` block (the `store.reviews.auditsPerformed += auditsThisRun;` block) and after the `store.reviews.failingPromptsTotal` refresh, insert:

```js
  // Spec 2: record promoter nominations from this run.
  if (!store.promotions) store.promotions = { totalPromoted: 0, lastPromotionRun: null, history: [] };
  const promoter = runState.promoter || {};
  const nominatedThisRun = (promoter.nominated || []).length;
  if (nominatedThisRun > 0) {
    store.promotions.totalPromoted += nominatedThisRun;
    store.promotions.lastPromotionRun = timestamp;
    store.promotions.history = cap([...(store.promotions.history || []), {
      ts: timestamp,
      nominated: nominatedThisRun,
      nominations: (promoter.nominated || []).map(n => ({
        persona: n.persona,
        capabilityTag: n.promoterEvidence?.capabilityTag,
        confidence: n.promoterEvidence?.confidence,
      })),
    }]);
  }

  // Spec 2: record overfitting events.
  if (!store.overfittingEvents) store.overfittingEvents = { totalDetected: 0, history: [] };
  const overfitting = runState.overfitting || {};
  if (overfitting.detected) {
    store.overfittingEvents.totalDetected += 1;
    store.overfittingEvents.history = cap([...(store.overfittingEvents.history || []), {
      ts: timestamp,
      trainDelta: overfitting.trainDelta,
      holdoutDelta: overfitting.holdoutDelta,
      threshold: overfitting.threshold,
      divergenceCount: (overfitting.divergences || []).length,
    }]);
  }
```

- [ ] **Step 3: Update the per-run `store.runs` entry to include the train/holdout/golden pre/post summary**

Find the `store.runs = cap([...store.runs, { ... }])` block inside `updateMetrics` (around line 62). Currently it reads:

```js
  store.runs = cap([...store.runs, {
    timestamp,
    mode: mode || 'full',
    successRate: parseFloat(scores.all.successRate) || 0,
    actionCompletionRate: scores.all.actionCompletionRate === 'N/A'
      ? null : parseFloat(scores.all.actionCompletionRate) || 0,
    errorRate: parseFloat(scores.all.errorRate) || 0,
    avgTools: parseFloat(scores.all.avgTools) || 0,
    totalPrompts: scores.all.total,
  }]);
```

Replace with:

```js
  const tierPct = s => (s && s.successRate !== undefined) ? parseFloat(s.successRate) || 0 : null;
  store.runs = cap([...store.runs, {
    timestamp,
    mode: mode || 'full',
    successRate: parseFloat(scores.all.successRate) || 0,
    actionCompletionRate: scores.all.actionCompletionRate === 'N/A'
      ? null : parseFloat(scores.all.actionCompletionRate) || 0,
    errorRate: parseFloat(scores.all.errorRate) || 0,
    avgTools: parseFloat(scores.all.avgTools) || 0,
    totalPrompts: scores.all.total,
    // Spec 2: per-tier pre/post success rates for quick scan.
    trainPre: tierPct(scores.train?.pre),
    trainPost: tierPct(scores.train?.post),
    holdoutPre: tierPct(scores.holdout?.pre),
    holdoutPost: tierPct(scores.holdout?.post),
    goldenPre: tierPct(scores.golden?.pre),
    goldenPost: tierPct(scores.golden?.post),
    promoted: (runState.promoter?.nominated || []).length,
    overfittingDetected: runState.overfitting?.detected === true,
  }]);
```

- [ ] **Step 4: Run the full test suite**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS. Test count 82.

- [ ] **Step 5: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add lib/metrics.mjs
git commit -m "feat(metrics): record promotions + overfittingEvents; per-run tier pre/post success rates"
```

---

### Task 12: Task-manager example wipe + README + E2E verification

**Files:**
- Delete: `examples/task-manager/.mcp-evolve/prompt-set.json` (if present; may already be gitignored)
- Modify: `README.md` (add a Spec 2 migration note)
- Grep verification: zero references to deleted symbols.
- Full `npm test` run.

- [ ] **Step 1: Check for and delete any stale v1 prompt-set in the task-manager example**

Run:

```bash
cd /Users/michaelperret/dev/mcp-evolve && ls examples/task-manager/.mcp-evolve/prompt-set.json 2>/dev/null && echo "FOUND" || echo "ABSENT"
```

If `FOUND`, delete it:

```bash
rm examples/task-manager/.mcp-evolve/prompt-set.json
```

If `ABSENT` (the file may be gitignored and never committed), no action — the example will scaffold a v2 empty prompt-set on the next `init` run.

- [ ] **Step 2: Update `README.md` with a Spec 2 migration note**

Read the current README to see its structure:

```bash
cat /Users/michaelperret/dev/mcp-evolve/README.md | head -80
```

Find an appropriate section (likely "Getting Started" or "Usage" near the top) and add the following paragraph. If no obvious spot exists, append to a section called "Migration notes" at the bottom:

```markdown
### Migration from Spec 1 (v1 prompt-set) to Spec 2 (v2 empty-golden)

Spec 2 redesigns the train/eval/golden structure. `prompt-set.json` now only persists **golden** prompts — train and holdout are generated fresh every run. The file schema is `{version: 2, prompts: [...]}`; entries gained `lifecycle: "golden"`, `evaluation: "fixer"`, `promoterEvidence`, and `promotedAt` fields, and lost `group`, `graduatedAt`, and `consecutivePasses`-as-streak-trigger.

To migrate a v1 project (including `examples/task-manager/`):

```bash
rm .mcp-evolve/prompt-set.json
node bin/cli.mjs init -c evolve.config.mjs
```

The load path refuses to start a run if it sees a v1 prompt-set (any prompt lacking `lifecycle`). The archive / git history is the backup — no backup file is written by the migration code.

Spec 2 also deletes the `--train` and `--eval` CLI flags (they were tied to the removed `persona.group` field) and adds a new Promoter-Agent that nominates passing train prompts for graduation to golden. See `docs/superpowers/specs/2026-04-11-train-eval-golden-redesign-design.md` for the full design.
```

- [ ] **Step 3: Run the grep verification — zero references to deleted symbols**

Run:

```bash
cd /Users/michaelperret/dev/mcp-evolve && \
  echo "=== persona.group ===" && git grep -n "persona\.group" lib/ bin/ test/ prompts/ || true && \
  echo "=== useFixedSets ===" && git grep -n "useFixedSets" lib/ bin/ test/ || true && \
  echo "=== graduationStreak ===" && git grep -n "graduationStreak" lib/ bin/ test/ || true && \
  echo "=== goldenBlockThreshold ===" && git grep -n "goldenBlockThreshold" lib/ bin/ test/ || true && \
  echo "=== maxTrainPerRun ===" && git grep -n "maxTrainPerRun" lib/ bin/ test/ || true && \
  echo "=== maxGoldenPerRun ===" && git grep -n "maxGoldenPerRun" lib/ bin/ test/ || true && \
  echo "=== loadGoldenSet ===" && git grep -n "loadGoldenSet" lib/ bin/ test/ || true && \
  echo "=== promoteToGoldenSet ===" && git grep -n "promoteToGoldenSet" lib/ bin/ test/ || true && \
  echo "=== getGoldenPrompts ===" && git grep -n "getGoldenPrompts" lib/ bin/ test/ || true && \
  echo "=== updateGoldenHealth ===" && git grep -n "updateGoldenHealth" lib/ bin/ test/ || true && \
  echo "=== updatePromptSetAfterRun ===" && git grep -n "updatePromptSetAfterRun" lib/ bin/ test/ || true && \
  echo "=== addTrainPrompts ===" && git grep -n "addTrainPrompts" lib/ bin/ test/ || true && \
  echo "=== getPromptsByGroup ===" && git grep -n "getPromptsByGroup" lib/ bin/ test/ || true && \
  echo "=== getPersonasByGroup ===" && git grep -n "getPersonasByGroup" lib/ bin/ test/ || true && \
  echo "=== createPromptSet ===" && git grep -n "createPromptSet" lib/ bin/ test/ || true
```

Each section should print its header and NO matching lines. Any hit means a missed reference — stop and fix it.

Note: matches inside `docs/` (the learnings, specs, plans, round-9 results) are expected and OK — those are historical records.

- [ ] **Step 4: Run the full test suite**

Run: `cd /Users/michaelperret/dev/mcp-evolve && npm test`
Expected: PASS. Final test count ≈ 82 (45 baseline + 2 config + 6 tagged-json + 5 eval scoreField + 7 split + 2 baseline v2 + 10 promoter-protocol + 5 promoter = 82).

- [ ] **Step 5: Smoke-test the init path end-to-end**

Run:

```bash
cd /Users/michaelperret/dev/mcp-evolve && node bin/cli.mjs init -c examples/task-manager/evolve.config.mjs
```

Expected output: `Wrote empty v2 prompt-set to .../examples/task-manager/.mcp-evolve/prompt-set.json`.

Verify:

```bash
cat examples/task-manager/.mcp-evolve/prompt-set.json
```

Expected:

```json
{
  "version": 2,
  "generatedAt": "...",
  "prompts": []
}
```

- [ ] **Step 6: Smoke-test the `status` command**

Run:

```bash
cd /Users/michaelperret/dev/mcp-evolve && node bin/cli.mjs status -c examples/task-manager/evolve.config.mjs
```

Expected: no crash, prints personas + `Prompt set: 0 persisted (0 golden, train+holdout generated fresh per run)`.

- [ ] **Step 7: Smoke-test the `failing list` command**

Run:

```bash
cd /Users/michaelperret/dev/mcp-evolve && node bin/cli.mjs failing list -c examples/task-manager/evolve.config.mjs
```

Expected: prints `No failing entries.` (or an existing list if you've done a prior run — either outcome is acceptable).

- [ ] **Step 8: Commit**

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add README.md
# Task-manager prompt-set.json is typically gitignored; if git status shows it as tracked, add it too:
git status
git commit -m "docs(spec-2): README migration notes; E2E verification of init + status + failing commands"
```

- [ ] **Step 9: Write the Spec 2 implementation notes (companion to spec-1-implementation-notes.md)**

Create `docs/learnings/spec-2-implementation-notes.md` (a fresh file mirroring the Spec 1 notes style). Sections:

- TL;DR for future work
- Architectural patterns reused from Spec 1 (pure+async wrapper for promoter, runState peer structure, tagged-JSON protocol, shared `tagged-json.mjs`)
- Bugs caught in per-task code review (fill in as they happen during execution)
- File inventory (new + touched + deleted)
- Open questions that remained for future work (e.g., golden×holdout hold-out golden, promoter self-critique, parametric templates)
- Verification checklist

Leave this file as a stub at the end of Task 12 if time-constrained — it can be filled in post-merge. The minimum viable content is:

```markdown
# Spec 2 Implementation Notes (Train / Eval / Golden Redesign)

**Implemented:** 2026-04-11+ in a subagent-driven session.
**Spec:** `/Users/michaelperret/dev/mcp-evolve/docs/superpowers/specs/2026-04-11-train-eval-golden-redesign-design.md`
**Plan executed:** `/Users/michaelperret/dev/mcp-evolve/docs/superpowers/plans/2026-04-11-train-eval-golden-redesign.md`

## TL;DR

- `prompt-set.json` is v2 now: only golden lifecycle persists, train+holdout are generated fresh every run.
- New generation phase loads golden, generates N per persona, splits K as holdout deterministically via `splitForHoldout(prompts, K, seed)`.
- Pre-fix scoring (`scorePre`) + post-fix scoring (`scorePost`) populated on every prompt; replay re-runs ALL prompts including holdout.
- Overfitting detection: `train_post - train_pre > threshold` AND `holdout_post - holdout_pre < -threshold` → `runState.overfitting.detected`.
- New Promoter-Agent (`lib/promoter.mjs`) nominates 0–3 passing train prompts per run. Filters against `failing-prompts.json`.
- Legacy mode is gone: `useFixedSets`, `persona.group`, `updatePromptSetAfterRun`, `updateGoldenHealth`, `createPromptSet`, `addTrainPrompts`, `loadGoldenSet`, `--train`/`--eval` flags all deleted.
- `extractTagged` factored into `lib/tagged-json.mjs` for reuse by reviewer-protocol and promoter-protocol.
- No `migrate` subcommand — `init` writes empty v2; `loadPromptSet` rejects v1.

## Verification

- `npm test` — 82 tests passing across 9 files.
- `git grep` for all deleted symbols — zero hits in `lib/`, `bin/`, `test/`.
- `node bin/cli.mjs init -c <config>` scaffolds a v2 empty prompt-set.
- `node bin/cli.mjs status -c <config>` shows Spec 2 tier display.
```

Commit:

```bash
cd /Users/michaelperret/dev/mcp-evolve
git add docs/learnings/spec-2-implementation-notes.md
git commit -m "docs(learnings): Spec 2 implementation notes stub (fill in with bug case studies as they land)"
```

- [ ] **Step 10: Final verification — git log summary**

Run:

```bash
cd /Users/michaelperret/dev/mcp-evolve && git log --oneline fc9e7e4..HEAD
```

You should see ~14 commits from Spec 2: one per task (+ intermediate fixups from per-task code reviews + this final docs commit).

- [ ] **Step 11: Print the completion banner**

```bash
echo "Spec 2 complete. Test count: 82. Branch: master. Ready for user to run 'node bin/cli.mjs migrate' (i.e., rm + init) in pubmanager and start Round 10."
```

---

## Self-review (run after writing, before handing off)

### 1. Spec coverage

Each numbered item in Spec 2's "What Spec 2 must do" list:

| Spec item | Task |
|---|---|
| 1. Two orthogonal fields on prompts: `lifecycle` + `evaluation`, remove `persona.group` | Tasks 6, 7 |
| 2. Train + holdout are ephemeral per run | Task 7 |
| 3. Holdout is in-batch split (K of N per persona, K=1, N=3 defaults) | Tasks 3, 7 |
| 4. Only golden persists in `prompt-set.json` | Tasks 6, 7, 10 |
| 5. Pre/post-fix scoring on every tier (`aggregateScores` scoreField) | Tasks 3, 8, 9 |
| 6. Replay re-runs ALL prompts including holdout | Task 9 |
| 7. Overfitting detection | Tasks 3, 9 |
| 8. New Promoter-Agent (runs via claude CLI, tagged-JSON output) | Task 5, 10 |
| 9. Clean-slate migration (via `init`, no subcommand per user decision) | Tasks 6 (init.mjs) |
| 10. Config additions + deletions | Task 1 |
| Baseline schema v2 (user decision) | Task 4 |
| checkStreak golden-only (user decision) | Task 4 |
| Promoter ↔ failing-prompts filter (user decision) | Task 10 |
| Shared tagged-JSON helper | Task 2 |
| Metrics + run-log additions | Task 11 |
| Task-manager + README + E2E | Task 12 |

Every spec item has a task. Good.

### 2. Placeholder scan

Search the plan for placeholder patterns:
- "TBD", "TODO", "fill in": none except the intentional "[TASK 7]" marker in Task 6's placeholder code (which is replaced in Task 7 — not a plan placeholder, it's a staging marker for the implementer).
- "implement later": none.
- "add appropriate error handling": none — specific guards are shown inline.
- "similar to Task N": Task 5 Step 9 references "mirrors the audit pattern" but the referenced pattern is also fully shown in-line, so it's not a load-bearing placeholder.

### 3. Type consistency

- `splitForHoldout(prompts, K, seed)` — consistent across Tasks 3, 7.
- `aggregateScores(scoredPrompts, scoreField = 'score')` — consistent across Tasks 3, 4, 6, 9.
- `overfittingDetection({trainPre, trainPost, holdoutPre, holdoutPost, perPromptPairs, threshold})` — consistent across Tasks 3, 9.
- `applyPromoterDecisions({reviewerOutput, candidates, config, runId})` + returns `{nominated, skipped, unmatched, duplicates}` — consistent across Tasks 5, 10.
- `runPromoter({candidates, currentGolden, failingEntries, config, runId})` — consistent across Tasks 5, 10.
- `runState.promoter` shape `{nominated, skipped, unmatched, duplicates, parseErrors, reviewerOutput}` — consistent across Tasks 10, 11.
- `runState.overfitting` shape `{detected, trainDelta, holdoutDelta, threshold, divergences}` — consistent across Tasks 3, 9, 11.
- `scoredPrompts` entry shape `{persona, prompt, lifecycle, evaluation, promptObj, score, scorePre, scorePost, adversarial, invalid, invalidReason}` — consistent across Tasks 6, 8, 9, 10, 11.
- Golden entry in `prompt-set.json`: `{persona, prompt, lifecycle: 'golden', evaluation: 'fixer', consecutivePasses, promotedAt, promoterEvidence, promptObj: {prompt, probe, invariant, probeType, adversarial, lifecycle, evaluation}}` — consistent in Tasks 5, 7, 10.
- Baseline v2 entry shape `{persona, lifecycle, evaluation, prompt, promptObj, scorePre, scorePost, score}` — consistent in Task 4, 9.

### 4. Ordering sanity

- Task 1 (config) has no dependencies.
- Task 2 (tagged-json) depends only on Task 1 being committed (not required — independent).
- Task 3 (eval helpers) adds new exports; no collisions with existing code.
- Task 4 (baseline v2) modifies `saveBaseline` and `loadBaseline` but depends on Task 3 for nothing (both touch `lib/eval.mjs`, but different functions — no merge conflict).
- Task 5 (promoter) depends on Task 2 (imports `extractTagged` from tagged-json).
- Task 6 is the destructive cut — must come AFTER Tasks 1–5 so those land on a stable substrate.
- Tasks 7–11 build on Task 6's cleaned substrate and layer additive behavior.
- Task 12 verifies the whole thing.

All tasks have their dependencies in order.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-11-train-eval-golden-redesign.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Four real bugs were caught this way in Spec 1; the same process is the right fit here.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
