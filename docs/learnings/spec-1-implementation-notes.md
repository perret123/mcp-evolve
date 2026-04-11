# Spec 1 Implementation Notes (Reviewer Audit Upgrade)

**Implemented:** 2026-04-11 in a subagent-driven session.
**Commit range:** `710451a` chore (remove obsolete date tests) through `fc9e7e4` chore (pre-merge cleanup). 18 commits total on `master` after the plan doc (`ffb9fad`) and handover (`fc37e4c`).
**Spec:** `/Users/michaelperret/dev/mcp-evolve/docs/superpowers/specs/2026-04-11-reviewer-audit-upgrade-design.md`
**Plan executed:** `/Users/michaelperret/dev/mcp-evolve/docs/superpowers/plans/2026-04-11-reviewer-audit-upgrade.md`

## TL;DR for future work

- Audit path `runAuditAndMerge` replaces the old `mergeFixBranches` call site. One reviewer LLM call per fix batch, model-error fixer goes through the same path via a worktree wrapper. Kill-switch: `config.reviewerAuditEnabled = false` bypasses the audit and auto-approves.
- `lib/failing-prompts.mjs` is a persistent cross-run store (`.mcp-evolve/failing-prompts.json`, version 1). Two entry kinds: `prompt` (fed as anti-example to the generator) and `pattern` (used as a pre-filter on the model-error fixer input).
- Adversarial prompts are a first-class signal now: `promptObj.adversarial === true` replaces the old `expectedOutcome: 'error'` mechanism. Grader scores them as pass on error; fixer skips their errors entirely; anti-example injection works.
- `runState` is threaded through `run()` in `lib/run.mjs` starting at line 871: `const runState = { audit: null }`. The fixer phase populates `runState.audit.fixer`, the model-error phase populates `runState.audit.modelError`, and both are consumed by `buildReviewerLogSection` (line 140) and `updateMetrics` (line 54 in `lib/metrics.mjs`).
- Reviewer output format is JSON inside `<AUDIT>` and `<PROMPT_REVIEW>` tags — NOT the YAML-ish block shown in the spec text. Node has no built-in YAML parser; `JSON.parse` on tagged extraction is much more robust. Spec 2's promoter should follow the same convention.

## Architectural patterns to reuse

### Pure-function + async-wrapper split

`lib/audit.mjs` exports two public functions:

- `applyAuditDecisions({ reviewerOutput, branches, scoredPrompts, runId, config })` — pure, synchronous, deterministic. Given a parsed reviewer output + the branches + the scored-prompt list, it mutates `scoredPrompts` (sets `invalid: true` / `invalidReason`), appends to `failing-prompts.json` via `addFailingEntry`, and rewrites `prompt-set.json` via `savePromptSet` if a dropped prompt was persisted as golden. No LLM calls, no git calls. Returns `{merged, rejected, droppedPrompts}`.
- `runAuditAndMerge({ branches, scoredPrompts, runId, config })` — async wrapper. Calls the reviewer LLM via `claude()`, parses the output via `parseReviewerOutput`, validates via `validateReviewerOutput`, then calls `applyAuditDecisions`. Returns the summary plus `reviewerOutput` and `parseErrors`.

**Why it matters:** 4 of the 5 audit tests (`test/audit.test.mjs`) run without a live Claude CLI. They synthesize a `reviewerOutput` object directly and call `applyAuditDecisions`. This makes the decision logic testable in ~2ms each.

Spec 2's promoter should follow the identical pattern: `applyPromoterDecisions` pure + `runPromoter` async wrapper. The pure function knows nothing about LLMs; it just takes `{nominations, candidates, currentGolden, config}` and returns the list of entries to append to `prompt-set.json`.

### runState threading for cross-phase data

The `runState` object is declared at the top of `run()` in `lib/run.mjs` (around line 871 — search for `const runState = { audit: null };`). It is populated by:

- Fixer phase: `runState.audit = { fixer: auditSummary }` at line 1384.
- Model-error phase: `runState.audit.modelError = meAudit` at line 1551.

It is consumed by:

- `buildReviewerLogSection(runState)` at line 140, which produces the `reviewer` section for the per-run log (`.mcp-evolve/logs/run-*.json`).
- `updateMetrics({ ..., runState }, config)` at line 54 of `lib/metrics.mjs`, which records audit stats into the persistent metrics store.

Spec 2 extends this pattern: add `runState.promoter = { nominations: [...], skipped: [...], parseErrors: [...] }` and `runState.overfitting = { detected, trainDelta, holdoutDelta, divergences }`. Both should be populated in the run flow and consumed by `buildRunLogSection(...)` and `updateMetrics`.

### Tagged-JSON reviewer output

Reviewer emits two JSON blocks at the end of its response:

```
<AUDIT>
[ { branch, fixType, backendCheck: {...}, decision, reason }, ... ]
</AUDIT>

<PROMPT_REVIEW>
[ { promptId, persona, invariantStatus, decision, reason }, ... ]
</PROMPT_REVIEW>
```

Parser (`lib/reviewer-protocol.mjs:parseReviewerOutput`) extracts tags with a regex, attempts `JSON.parse`, reports parse errors as structured `parseErrors`. Validator (`validateReviewerOutput`) checks enum values and semantic constraints (rejection_path requires backendCheck.performed; merge with conclusion=fabrication is an error). 11 tests in `test/reviewer-protocol.test.mjs`.

Spec 2's promoter output should use the same format: `<NOMINATIONS>` and `<SKIPPED>` tagged JSON blocks, parsed and validated the same way. Reusable utilities from `reviewer-protocol.mjs` are not exported — if Spec 2 wants the tag-extraction logic, factor `extractTagged` out into a shared module.

### test/timings.test.mjs try/finally convention

File-touching tests MUST use try/finally + `rmSync(..., { recursive: true, force: true })` to avoid tmpdir leaks on assertion failure. This was not part of the original plan but was added after a code review flag — compare `test/failing-prompts.test.mjs` (uses cleanup pattern) with `test/audit.test.mjs` (also uses cleanup). The pattern to follow:

```js
test('my test', () => {
  const cfg = makeCfg();
  try {
    // ... test body ...
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});
```

Spec 2 test files that touch `prompt-set.json`, `failing-prompts.json`, migration backups, or promoter payload dumps must use this pattern from the first commit.

### buildReviewerPayload pattern for per-branch LLM context

`lib/audit.mjs:buildReviewerPayload` (line 30) builds the text payload sent to the reviewer LLM. Each branch section includes: index, branchName, worktreePath, persona, prompt, probe, invariant, probeType, lifecycle, error summary, and a truncated diff. Empty fields are filtered via `filter(Boolean)`.

Spec 2's promoter payload should follow the same structure per-candidate: persona, prompt, capabilityTag guess, toolCallSignature, probe invariant, reviewer status (kept / not-reviewed), plus a global header listing existing golden capabilities for distinctness comparison.

## Bugs caught in per-task code review (the process works)

Four real bugs were caught AFTER the task implementer finished but BEFORE the task merged. Each one would have been latent until a later task exercised the code path. These are case studies in why the per-task review matters.

### 1. normalizeErrorText over-aggressive hyphen-id regex (Task 2)

**Original regex** in `lib/failing-prompts.mjs`:

```js
.replace(/\b[a-z0-9]{2,}-[a-z0-9-]{2,}\b/gi, '')
```

**Problem:** stripped domain vocabulary like `walk-in`, `fast-book`, `end-of-day`. Any pattern-level entry generated from errors containing those words would collapse to an empty or near-empty string, causing false signature collisions in Task 7's model-error pattern filter — the `new RegExp(fp.patternRegex, 'i').test(errorText)` check would match everything because `patternRegex` was essentially empty.

**Fix** (commit `d08497f` — fix(failing-prompts): tighten normalizeErrorText to preserve domain vocabulary):

```js
.replace(/\b(?=[a-z0-9-]*\d)[a-z0-9]{2,}(?:-[a-z0-9]+){1,}\b/gi, '')
```

Positive lookahead requires at least one digit in the matched token. `tisch-5`, `tx-12345` still get stripped; `walk-in`, `fast-book`, `end-of-day` survive. New edge-case test: `test/failing-prompts.test.mjs:122 — 'normalizeErrorText handles edge cases and preserves domain vocabulary'`.

### 2. validateReviewerOutput crashes on null/undefined (Task 3)

**Problem:** the whole point of `lib/reviewer-protocol.mjs:validateReviewerOutput` is to be a safe funnel from untrusted LLM output to a validated decision structure, but the original implementation threw `TypeError: Cannot read properties of null (reading 'branch')` when passed `{audits: [null], promptReviews: []}` or `undefined`. A crash during validation would bypass the entire audit safety net.

**Fix** (commit `478503f` — fix(reviewer-protocol): guard against null inputs and add identifiers to error messages):

- Top-level guard: `if (!parsed || typeof parsed !== 'object') return ['validateReviewerOutput: parsed input is not an object'];`
- Per-entry guards in both loops: `if (!a || typeof a !== 'object') { errors.push(...); continue; }`
- Every error message now includes the branch or promptId for easier triage.

New regression tests: 4 added (`'validateReviewerOutput returns error for undefined input'`, `'... for null input'`, `'handles null audit entries without crashing'`, `'handles null prompt review entries without crashing'`).

### 3. escapeRegex(errorKey).slice(0, 200) can produce invalid regex (Task 5)

**Original code** in `lib/audit.mjs`:

```js
patternRegex: escapeRegex(errorKey).slice(0, 200),
```

**Problem:** slicing AFTER escaping can chop mid-`\X` pair, leaving a trailing backslash that makes `new RegExp(...)` throw when Task 7's pattern filter tries to compile it. Latent: would only trip once a persisted pattern-level entry happened to fall on that boundary. Error would surface during a model-error fixer run after a reviewer rejection, in production pubman runs.

**Fix** (commit `b43dfee` — fix(audit): guard patternRegex truncation and document scoredPrompts mutation):

```js
patternRegex: escapeRegex(errorKey.slice(0, 200)),
```

Source-slice first, escape second. The 200-char boundary always falls on a plain character. New regression test: `test/audit.test.mjs:180 — 'applyAuditDecisions persists pattern-level failing entry for rejected model-error branches'` exercises the full path with regex metacharacters in the error text.

### 4. fixResults[idx] alignment breaks after .filter(Boolean) (Task 6)

**Original plan code** in `lib/run.mjs` Phase B:

```js
const fixResults = (await Promise.all(fixPromises)).filter(Boolean);
const branchesForAudit = fixResults.map((fr, idx) => ({
  ...fr,
  fixableError: fixableErrors[idx],
  kind: 'fixer',
}));
```

**Problem:** `fixPromises` was one-per-fixableError. If any fixer returned null (no changes produced), `.filter(Boolean)` dropped it and every subsequent `fixResults[idx]` paired with the WRONG `fixableErrors[idx]`. Silent wrong-persona, wrong-prompt, wrong-probe context fed to the reviewer — who would then audit a diff against a completely unrelated triggering error and arrive at arbitrary conclusions.

**Fix** (commit `6386dbe` — fix(run): align fixResults with fixableErrors before filtering nulls):

```js
const allFixResults = await Promise.all(fixPromises);
const branchesForAudit = allFixResults
  .map((fr, idx) => fr ? { ...fr, fixableError: fixableErrors[idx], kind: 'fixer' } : null)
  .filter(Boolean);
const fixResults = allFixResults.filter(Boolean); // kept for worktree cleanup
```

Pair BEFORE filtering; filter AFTER. The fix lives at `lib/run.mjs:1330-1339`.

### Process lesson

The implementer finishing quickly does not mean compliance. Spec review (does the code match the plan?) and code quality review (is the code correct in edge cases?) catch different things — all four bugs above were found by the code-quality reviewer, not the spec reviewer. The most impactful catch was #4 (Task 6), because it would have silently poisoned reviewer context in every fix batch where any fixer returned null.

Batch Minor issues into a final cleanup commit (`fc9e7e4`) rather than per-task fix commits — more efficient than spawning per-issue reviewer loops. Four per-task Important fixes are sufficient; the rest can be collected and landed together.

## File/module inventory (new + touched in Spec 1)

### New modules

- `/Users/michaelperret/dev/mcp-evolve/lib/failing-prompts.mjs` — 98 lines (post-fix). 8 exports: `loadFailingPrompts`, `saveFailingPrompts`, `addFailingEntry`, `getFailingForPersona`, `getFailingPatterns`, `clearAllFailing`, `removeFailing`, `normalizeErrorText`. External deps: `node:fs`, `node:path`, `node:crypto`. Store version 1. No external libs beyond Node built-ins.
- `/Users/michaelperret/dev/mcp-evolve/lib/reviewer-protocol.mjs` — 132 lines (post-null-guard fix). 2 exports: `parseReviewerOutput`, `validateReviewerOutput`. No external deps. Enum sets defined at top: `VALID_FIX_TYPES`, `VALID_DECISIONS`, `VALID_METHODS`, `VALID_CONCLUSIONS`, `VALID_INVARIANT_STATUS`, `VALID_PROMPT_DECISIONS`.
- `/Users/michaelperret/dev/mcp-evolve/lib/audit.mjs` — 276 lines (post-escapeRegex fix). 2 exports: `applyAuditDecisions` (pure) and `runAuditAndMerge` (async wrapper). Private helpers: `buildReviewerPayload`, `log`, `escapeRegex`. Imports from `claude.mjs`, `reviewer-protocol.mjs`, `failing-prompts.mjs`, `eval.mjs`.

### New test files

- `/Users/michaelperret/dev/mcp-evolve/test/config.test.mjs` — 1 test: `'loadConfig sets reviewerAuditEnabled default true'`.
- `/Users/michaelperret/dev/mcp-evolve/test/failing-prompts.test.mjs` — 9 tests (8 original + 1 edge-case test added in fix `d08497f`).
- `/Users/michaelperret/dev/mcp-evolve/test/reviewer-protocol.test.mjs` — 11 tests (7 original + 4 null-guard regression tests added in fix `478503f`).
- `/Users/michaelperret/dev/mcp-evolve/test/audit.test.mjs` — 5 tests (4 original + 1 regex-metachar regression test added in fix `b43dfee`).
- 1 test appended to `/Users/michaelperret/dev/mcp-evolve/test/eval.test.mjs`: `'scorePrompt treats adversarial prompts with errors as passing when no false success'`.

**Test count:** 5 + 1 + 9 + 11 + 6 + 13 = 45 tests across 6 files (`audit`, `config`, `eval`, `failing-prompts`, `reviewer-protocol`, `timings`). Baseline for Spec 2 start.

### Touched files

- `/Users/michaelperret/dev/mcp-evolve/lib/run.mjs` — biggest touch by far. Deleted `mergeFixBranches` function entirely. Added `runModelErrorFixerInWorktree` helper. Added `buildReviewerLogSection(runState)` at line 140. Added `runState = { audit: null }` initialization at the top of `run()` around line 871. Threaded `runState` through the fixer + model-error phases. Added adversarial filter to `fixableErrors` collection. Added `failingEntries` parameter to `generatePrompts` (line 257). Added anti-examples section construction. Added `getFailingPatterns` filter on model-error input. Replaced `expectedOutcome` pickup with `adversarialFlag`. Replaced `expectedOutcomeHint` grader hint with `adversarialHint`. Removed the dead `--skip-reviewer` CLI flag and `effectiveSkipReviewer` local in cleanup commit.
- `/Users/michaelperret/dev/mcp-evolve/lib/eval.mjs` — `aggregateScores` excludes `invalid: true` prompts (line 166). `obsoleteCount` recomputed to exclude invalid prompts. New `invalidCount` field in the return object. Also: in the cleanup commit, `addTrainPrompts` now propagates the `adversarial` field (line 637) — this was an Important issue caught in the final whole-implementation review.
- `/Users/michaelperret/dev/mcp-evolve/lib/config.mjs` — added `reviewerAuditEnabled: true` (default), extended `reviewerTools` default to include `Bash`, renamed `adversarialRate` → `adversarialRatio` with default `0` (hard rename; no backwards compat). Added `merged.failingPromptsPath = join(merged.dataDir, 'failing-prompts.json')` alongside the other data-dir paths.
- `/Users/michaelperret/dev/mcp-evolve/lib/metrics.mjs` — added `reviews` section to `emptyStore()` (line 24). `updateMetrics` gains `runState = {}` destructured parameter. Added review-stats accumulation block (lines 152-180). Top-level `import { loadFailingPrompts } from './failing-prompts.mjs'` (line 10) to avoid the ESM `require` hack.
- `/Users/michaelperret/dev/mcp-evolve/lib/init.mjs` — `generatePrompts` call at line 123 passes `[]` for `failingEntries` (init runs before any failing entries exist).
- `/Users/michaelperret/dev/mcp-evolve/bin/cli.mjs` — added `failing` subcommand group at line 190 (`list`, `clear <id>`, `clear-all`). Updated `--help` text at line 75. In cleanup commit: removed `'skip-reviewer'` flag option, removed corresponding usage line, removed `skipReviewer` from the `run()` call's args.
- `/Users/michaelperret/dev/mcp-evolve/prompts/reviewer.md` — full rewrite. Current version is 100 lines (previous was ~12 lines of merge instructions). Contains decision matrix, audit checklist (5 mandatory checks for rejection-path diffs), PROMPT_REVIEW contamination detection, applying approved changes instructions, output format spec, and constraints.
- `/Users/michaelperret/dev/mcp-evolve/prompts/fixer-model-error.md` — added a note at the top that pattern-matching failing entries are pre-filtered from its input.
- `/Users/michaelperret/dev/mcp-evolve/prompts/grader.md` — replaced `expectedOutcome: 'error'` rule with adversarial semantics: if `adversarial: true`, score as pass when errors are present, fail only on false-success.
- `/Users/michaelperret/dev/mcp-evolve/prompts/user-sim.md` — added end-of-file notes about anti-examples and the `adversarial: true` flag. The anti-examples section is built in `generatePrompts` and inlined into the generation prompt; user-sim.md just tells the LLM not to mechanically copy from it.
- `/Users/michaelperret/dev/mcp-evolve/README.md` — one-line update in cleanup commit (`fc9e7e4`).

### Files deleted

- `/Users/michaelperret/dev/mcp-evolve/test/dates.test.mjs` — obsolete. Date handling was removed from the harness in a previous round. Deleted in `710451a` (first commit of the Spec 1 implementation).

## Integration gaps between tasks (watch for these in Spec 2)

### 1. addTrainPrompts dropped the adversarial field on round-trip

Task 8's adversarial migration did not catch that `lib/eval.mjs:addTrainPrompts` (line 625) constructs a NEW `promptObj` when persisting escalation output into `prompt-set.json`. The constructor only copied `prompt`, `probe`, `invariant`, `probeType` — not `adversarial`. Any escalated prompt with `adversarial: true` would have its flag stripped on persistence.

Fixed in the final cleanup commit `fc9e7e4`:

```js
promptObj: {
  prompt: q.prompt,
  probe: q.probe,
  invariant: q.invariant,
  probeType: q.probeType,
  adversarial: q.adversarial === true || q.promptObj?.adversarial === true || false,
},
```

**Lesson for Spec 2:** when adding fields to `promptObj`, `grep` for EVERY place that constructs or clones a `promptObj`. Candidates to check: `addTrainPrompts`, `createPromptSet` (line 556), `saveBaseline` (line 191), `generatePrompts` return shape, `runAndGrade`'s `probeData` handling.

### 2. --skip-reviewer CLI flag was dead code pre-Spec-1

The `--skip-reviewer` flag existed in `bin/cli.mjs` and a `skipReviewer` parameter was accepted by `run()`, but NOTHING read the derived `effectiveSkipReviewer` local. It was leftover from a previous refactor. Spec 1's cleanup removed all three places (flag declaration, help text, parameter destructure). The new kill-switch is `config.reviewerAuditEnabled`.

**Lesson for Spec 2:** do NOT add a new CLI flag if there's an equivalent config field. Prefer `config.migrationAutoRun` over `--auto-migrate`, `config.promoterEnabled` over `--skip-promoter`, etc. CLI flags are for ad-hoc overrides, not persistent behavior.

### 3. Orphan comment after mergeFixBranches deletion

Task 6 deleted the `mergeFixBranches` function body (around the original line 568) but left the `// --- Reviewer ---` section heading standalone with no content. Cleaned up in the final commit `fc9e7e4` (`lib/run.mjs:718`).

**Lesson for Spec 2:** when deleting a function, `grep` for its section heading too. If the plan says "delete function X", also inspect the lines immediately before and after for comments that scoped to it.

## Spec 2 load-bearing things from Spec 1

Spec 2 MUST preserve these. Breaking any of them re-opens the fabrication risk that Round 9 exposed.

1. **The failing-prompts store is persistent and MUST survive Spec 2's clean-slate migration.** Spec 2's migration wipes `prompt-set.json` to `{version: 2, prompts: []}` but MUST NOT touch `failing-prompts.json`. The store accumulates across runs and feeds both generation anti-examples and model-error fixer filtering. A blank failing-prompts store at Spec 2 merge time means Round 10 loses the defense against re-introducing the Round 9 contaminants.

2. **Adversarial prompts must survive the ephemeral-train rewrite.** Spec 2's fresh-per-run generator still needs to honor `promptObj.adversarial === true`. The grader (`prompts/grader.md`), fixer-input filter (`lib/run.mjs:1272` — `if (q.promptObj?.adversarial === true) continue;`), and scoring (`aggregateScores` excludes adversarial from the passing denominator via `q.invalid` flag — no, actually adversarial prompts are not filtered out of scoring; they're graded as pass by the grader) all read this field. Spec 2 should NOT touch the grader prompt for this reason.

3. **The reviewer.md prompt is audit-first, not merge-first.** Spec 2's promoter prompt lives in a NEW file (`prompts/promoter.md`); it must NOT modify `prompts/reviewer.md`. The two agents have distinct philosophies: reviewer = correctness over tests-green; promoter = capability coverage over prompt count. Do not attempt to unify.

4. **`config.reviewerAuditEnabled` is the audit kill-switch.** Spec 2 should NOT bypass the audit. Pubman's Round 10 runs are ONLY safe if the audit is on. Leave the default at `true`. If you need to test a code path without the reviewer, set this flag in a local config, not by short-circuiting `runAuditAndMerge`.

5. **`runState.audit` structure is `{ fixer: {...}, modelError: {...} }`.** Spec 2 adds `runState.promoter = {...}` and `runState.overfitting = {...}` alongside — do not nest under `audit`. Keep them peers.

6. **The audit's PROMPT_REVIEW can drop golden prompts and the harness removes them from `prompt-set.json`.** When a reviewer emits `PROMPT_REVIEW` with `decision: drop` and the scored prompt has `group === 'golden'`, `applyAuditDecisions` filters it out of the prompt-set and calls `savePromptSet`. This happens in `lib/audit.mjs:196-204`. Spec 2 must preserve this behavior when golden semantics change — promoted golden prompts should still be droppable by the reviewer's PROMPT_REVIEW. The existing test is `test/audit.test.mjs:80 — 'applyAuditDecisions removes golden prompt from prompt-set.json when dropped'`.

7. **Pattern-level failing entries for model-error rejections.** When the reviewer rejects a model-error fixer batch, a regex pattern is persisted via `addFailingEntry` with `kind: 'pattern'`. The model-error path in Spec 2 should still go through the worktree-wrapped `runModelErrorFixerInWorktree` helper and flow to `runAuditAndMerge` with `kind: 'model-error'` set on the branch object. The pattern persistence logic lives in `lib/audit.mjs:132-149`.

## Things Spec 2 will touch (pre-known surface area)

Concrete file:line anchors. Keep this list as a grep target for writing the Spec 2 plan.

- **Scoring aggregation block** in `lib/run.mjs:1568-1581` (the `scoredPrompts` transform). Spec 2 needs `scorePre`/`scorePost` fields on every entry + `lifecycle` + `evaluation`. This block was already touched in Task 10 of Spec 1 to add `invalid`/`invalidReason` — Spec 2 stacks on top.

- **aggregateScores signature** at `lib/eval.mjs:165`. Currently `aggregateScores(scoredPrompts)`. Spec 2 needs to add an optional second parameter: `aggregateScores(scoredPrompts, scoreField = 'score')`. Existing callers keep the default, Spec 2 callers pass `'scorePre'` or `'scorePost'`.

- **Scoring bucket computation** in `lib/run.mjs:1720-1723`:

  ```js
  const allScores = aggregateScores(scoredPrompts);
  const trainScores = aggregateScores(scoredPrompts.filter(q => q.group === 'train'));
  const goldenScores = aggregateScores(scoredPrompts.filter(q => q.group === 'golden'));
  const evalScores = aggregateScores(scoredPrompts.filter(q => q.group === 'eval'));
  ```

  This is the literal block Spec 2's design doc says to replace. The `group === 'eval'` filter is the silent-bug source: no prompt ever has `group: 'eval'` (that field is on personas, not prompts), so `evalScores.total === 0` in every pubman run. Spec 2 replaces with filters on `lifecycle` and `evaluation`.

- **Log scores object** at `lib/run.mjs:1733`: `scores: { all: allScores, train: trainScores, golden: goldenScores, eval: evalScores }`. Spec 2 changes to `{ all, train: { pre, post }, holdout: { pre, post }, golden: { pre, post } }`.

- **checkStreak semantics** in `lib/eval.mjs:399-443`. Reads `q.score` via `isPassingScore(q.score)`. Spec 2 needs to decide which tier counts. Recommended: "golden_post streak" because train is ephemeral. Current implementation reads `q.score` via the baseline files, so the streak-check touches baselines not live run state.

- **saveBaseline schema** in `lib/eval.mjs:191-218`. Writes per-prompt `{persona, group, prompt, promptObj, score}`. Spec 2 needs to decide whether to save `scorePre`/`scorePost`/`lifecycle`/`evaluation` or freeze v1 baselines as the format `--regression` replay expects. If baselines store both, regression replay becomes compatible without migration; if only `score`, then pre-fix replay becomes the v2 behavior. Open question — surface in the Spec 2 kickoff.

- **generatePrompts signature** at `lib/run.mjs:257`:

  ```js
  export async function generatePrompts(persona, config, fullContext, runDateContext, failingEntries = []) {
  ```

  Already has `failingEntries` from Task 9 of Spec 1. Spec 2 adds `lifecycle`, `evaluation`, `N`, `K` concepts (or pushes the split to a `splitForHoldout` helper). The adversarial hint is already set up via `config.adversarialRatio` at `lib/run.mjs:265`.

- **Legacy mode paths** — all 18 occurrences of `useFixedSets` in `lib/run.mjs`. Spec 2 says legacy mode can stay but won't be exercised. The user explicitly said (in Round 9 closeout) to remove legacy mode entirely as part of Spec 2. That means every `!useFixedSets` branch in `lib/run.mjs` should be deleted, plus the `loadGoldenSet`/`updateGoldenHealth`/`goldenBlockThreshold` code path in `lib/eval.mjs`. The `examples/task-manager/evolve.config.mjs` does NOT set `useFixedSets` explicitly — the flag is derived from `!!promptSet` at `lib/run.mjs:943`, so task-manager currently runs in whichever mode its prompt-set.json implies. Task-manager will need to be migrated to the v2 format, which means its prompt-set.json either gets wiped or re-scaffolded via `init` after Spec 2 merges.

- **init.mjs createPromptSet** at `lib/init.mjs:139` + `lib/eval.mjs:556-577`. `createPromptSet(allPrompts, 0)` creates a prompt-set with `goldenPercent = 0` (all train). Spec 2 wants an empty prompt-set initially: `{version: 2, prompts: []}`. The `createPromptSet` function can either be deleted or reworked to always produce `{version: 2, prompts: []}` regardless of input.

- **graduationStreak config** at `lib/config.mjs:184` (default 10, pubman override 3). Dead after Spec 2 replaces with Promoter-Agent. Delete this field and its single consumer (`lib/eval.mjs:604`).

- **persona.group field** appears in 7 files of the repo, and 9 locations in `lib/` code:
  - `lib/run.mjs:1144` — display string in persona header log line
  - `lib/run.mjs:1270` — legacy filter: `if (!useFixedSets && (r.persona.group || 'train') !== 'train') continue`
  - `lib/run.mjs:1279` — lifecycle derivation: `let lifecycle = r.persona.group || 'train'`
  - `lib/run.mjs:1352` — reviewer scoredPrompts shadow: `: (r.persona.group || 'train')`
  - `lib/run.mjs:1495` — model-error legacy filter
  - `lib/run.mjs:1570` — scoredPrompts transform `let group = r.persona.group`
  - `lib/run.mjs:1748` — additional log scoring path
  - `lib/eval.mjs:200` — saveBaseline writes `group: r.persona.group`
  - `lib/eval.mjs:473` — another saveBaseline-adjacent path
  Removing `persona.group` means every line above needs a different source of truth. Spec 2's new lifecycle/evaluation is per-prompt, not per-persona, so the fix is straightforward: read from `scoredPrompt.lifecycle` / `scoredPrompt.evaluation` instead of `r.persona.group`.

- **Escalation** (`lib/run.mjs:723-838` — `escalate` function, plus callers at lines 1611-1619 and 1686-1693). Currently calls `addTrainPrompts(promptSet, escalationResults, config)` which PERSISTS to `prompt-set.json`. Spec 2 says escalation output is ephemeral train — inject into current run's `promptsToRun` rather than persisting. Modify `addTrainPrompts` to return the entries OR delete it entirely and inline the pushing of new prompts to an in-memory array.

- **Feature competition trigger** at `lib/run.mjs:1535-1542` + `lib/compete.mjs`. Fires at `streak × competitionStreakMultiplier` when golden hits 100% multiple times in a row. Spec 2 keeps this in principle, but streak semantics change because train no longer persists. The check should move to `golden_post.successRate === 100` via `checkStreak`.

- **updatePromptSetAfterRun** at `lib/eval.mjs:583-622`. Streak-based graduation (`consecutivePasses >= graduationStreak`). Entirely replaced by Promoter-Agent in Spec 2. Delete.

- **updateGoldenHealth / goldenBlockThreshold** at `lib/eval.mjs:500-540` + `lib/autodev.mjs`. Legacy golden set health tracking. Removed with legacy mode.

- **`maxTrainPerRun` / `maxGoldenPerRun`** config fields at `lib/config.mjs:193,196`. Sampling strategy — in Spec 2 the generator produces exactly N per persona, so both fields become meaningless. Delete.

## Open questions Spec 2 will need to answer

The spec doc is intentionally vague on these. The kickoff session must decide.

1. **What replaces saveBaseline in the pre/post world?** Save `scorePre` AND `scorePost` per prompt? Or only `scorePost`? Regression replay (`--regression`) reads baselines — that path must still work. Likely answer: save both; default the `score` field to `scorePost` for backwards-compat.

2. **checkStreak semantics.** Is "100% run" defined as `golden_post.successRate === 100`? What if there are 0 golden prompts (first run after migration)? Suggested: golden_post only, and streak is 0 when there are no golden prompts yet.

3. **Competition trigger.** Still uses `streak × competitionStreakMultiplier`. Does competition still fire only when golden is 100%, or is it now independent? Unchanged in the spec doc but worth being explicit.

4. **Legacy mode disposition.** User said to remove entirely. But `examples/task-manager/` uses a prompt-set.json that pre-dates v2. Decide: (a) delete legacy code entirely, migrate task-manager example by running `init` with the new generator; (b) keep legacy as parallel unused-by-pubman code path — user rejected this in Round 9 closeout, so (a) wins.

5. **--train / --eval CLI flags.** After `persona.group` removal, these do nothing meaningful. Delete entirely, or repurpose as `--holdout-only` / `--train-only` for the new lifecycle/evaluation model? Lean toward delete.

6. **Baseline compatibility.** `--regression` mode reads baseline JSON. Spec 2 adds pre/post. Recommendation: baselines store both `scorePre` and `scorePost`; if an older baseline only has `score`, treat it as `scorePost` only. Include a version field in the baseline file for future migrations.

7. **How does the Promoter-Agent interact with the failing-prompts store?** Spec 2 doesn't say explicitly. Should the promoter receive the failing-prompts list as an additional input and NOT nominate any `(persona, prompt)` already in `failing-prompts.json`? Probably yes — otherwise a prompt can be promoted, then rejected by the reviewer next run, then re-promoted the run after. Worth making explicit in the plan.

8. **Probe contamination check at promotion time.** When the promoter nominates a passing train prompt, does it check that the probe invariant is valid? Spec 1's reviewer drops contaminated prompts DURING the fixer phase, so by promotion time any contamination should already be surfaced. But if a train prompt passes WITHOUT triggering fixer (no errors at all), the reviewer never sees it, so a contaminated invariant could slip through. Recommendation: the promoter's nomination criteria should include a light contamination check (e.g., "is the invariant text reasonable given the prompt text?").

## Round 9 / Round 10 context

Round 9 was stopped early at Run 18 because of fabricated-constraint risk — sonnet re-added the `occupiedTableError` guard twice (once inline with `// likely wrong` as the comment), and the pubman prompt-set had accumulated contaminated probe invariants (Tisch 5 "must be empty" invariant enshrining the fabricated rule). Spec 1 is the structural defense: the audit catches fabrications AT merge time, and the reviewer's PROMPT_REVIEW drops contaminated prompts AT run time.

Spec 2 restructures train/eval/golden to address the other two Round 9 issues: state pollution from persistent write-prompts (train is now ephemeral) and the silent eval-bucket bug (lifecycle + evaluation are per-prompt orthogonal fields; `group` is retired). After Spec 2 + clean-slate migration, Round 10 starts: 10 runs with `ollama:qwen3.5:35b-a3b-coding-nvfp4` as answerer + 5 runs `sonnet` baseline.

**Non-negotiable from the handover:** no mcp-evolve runs between Spec 1 merge and Spec 2 merge. Fabrication risk is defended (Spec 1 is in place), but contaminated probes are still live without Spec 2's clean-slate wipe, so any run would score against stale invariants. The sequence is: Spec 1 merges → Spec 2 plan written → Spec 2 executes → `node bin/cli.mjs migrate` in pubmanager → Round 10 begins.

## How to verify Spec 1 is working (for future readers)

1. `cd /Users/michaelperret/dev/mcp-evolve && npm test` — all tests pass. Baseline is 45 tests across 6 files: `audit.test.mjs` (5), `config.test.mjs` (1), `eval.test.mjs` (6), `failing-prompts.test.mjs` (9), `reviewer-protocol.test.mjs` (11), `timings.test.mjs` (13).
2. `git grep expectedOutcome lib/ prompts/ test/` returns zero matches in production code (may still appear in older round-9 docs/baselines).
3. `git grep adversarialRate lib/` returns zero matches. Only `adversarialRatio` remains.
4. `git grep mergeFixBranches lib/` returns zero matches.
5. `.mcp-evolve/failing-prompts.json` is created on first run that drops a prompt.
6. `.mcp-evolve/metrics.json` gains a `reviews` section after first run (or is pre-populated by `loadMetrics` merging with `emptyStore`).
7. Per-run logs under `.mcp-evolve/logs/run-*.json` have a `reviewer` section with `auditsPerformed`, `fixesMerged`, `fixesRejected`, `rejectedFixes`, `droppedPrompts`, `parseErrors`.
8. Running `node bin/cli.mjs failing list` works and reports either entries grouped by persona or `"No failing entries."`.
9. Running `node bin/cli.mjs failing clear-all` wipes the store.
