# Spec 2 Implementation Notes (Train / Eval / Golden Redesign)

**Implemented:** 2026-04-12 in a subagent-driven session.
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

## Bugs caught in per-task code review

Five real bugs were caught by the per-task review process (spec-compliance + code-quality two-stage review). All were fixed before the next task started.

### 1. `buildPromoterPayload` emits `[object Object]` for tool calls (Task 5, Critical)

The plan's code for the promoter payload joined `c.toolCalls` directly, but `toolCalls` in the existing codebase is an array of `{tool, input, result}` objects, not strings. The join produced `[object Object], [object Object]` in the LLM payload. Fixed by mapping to `t.tool` before joining.

### 2. `maxPromotionsPerRun: 0` silently becomes 3 (Task 5, Important)

`const cap = Math.max(0, Number(config.maxPromotionsPerRun) || 3)` — the `|| 3` short-circuit clobbers an explicit `0` (disable promotion) to `3`. Fixed with `Number.isFinite(raw) ? raw : 3`.

### 3. Parameter named `reviewerOutput` in promoter module (Task 5, Important)

Copy-paste from `audit.mjs` left the promoter's destructured parameter named `reviewerOutput` even though the value is the promoter's parsed output. The misleading name leaked into `runPromoter`'s public return shape. Renamed to `promoterOutput` across both source and test files.

### 4. `runPromoter` doesn't handle claude() ERROR string return (Task 5, Important)

`lib/claude.mjs` resolves with `"ERROR: ..."` on process errors rather than throwing. The try/catch in `runPromoter` would never fire. Added an explicit `output.startsWith('ERROR:')` check that returns early with `parseErrors` populated.

### 5. Stale `goldenSetPath` in autodev + orphaned imports + dead CLI flags (Task 6, Important)

The destructive cut deleted `loadGoldenSet` but `lib/autodev.mjs` still read from `config.goldenSetPath` (the old `golden-set.json`). Fixed by switching to `config.promptSetPath` and filtering by `lifecycle === 'golden'`. Also removed orphaned imports (`checkDiversity`, `autoDev`) from run.mjs and dead CLI flags (`--golden-max`, `--skip-golden`).

### Near-miss: Task 1 absence-assertions deleted (Task 6, caught in spec review)

The implementer deleted 4 `assert.equal(cfg.graduationStreak, undefined)` assertions from `test/config.test.mjs` to satisfy the verification grep. These were valid regression guards from Task 1. Restored in a follow-up commit; the grep was updated to only scan `lib/` and `bin/` (test files may reference deleted symbols by name in absence-assertions).

### Process lesson

All five bugs were in the plan text itself (copy-paste from audit.mjs, wrong assumption about toolCalls shape, overly strict verification grep). The two-stage review process — spec compliance first, then code quality — caught them at different stages: the Critical (C1) and the Important naming issue (I2) were caught by the code-quality reviewer, while the absence-assertions near-miss was caught by the spec-compliance reviewer. The Spec 1 lesson holds: the implementer finishing quickly does not mean compliance.

## File inventory (new + touched in Spec 2)

### New modules
- `lib/tagged-json.mjs` — shared `extractTagged` helper (27 lines)
- `lib/promoter-protocol.mjs` — parse + validate `<NOMINATIONS>` + `<SKIPPED>` (102 lines)
- `lib/promoter.mjs` — `applyPromoterDecisions` (pure) + `runPromoter` (async) (217 lines)
- `prompts/promoter.md` — promoter system prompt with 6 nomination criteria (60 lines)

### New test files
- `test/tagged-json.test.mjs` — 6 tests
- `test/promoter-protocol.test.mjs` — 10 tests
- `test/promoter.test.mjs` — 6 tests (5 original + 1 cap-zero regression)
- `test/split-for-holdout.test.mjs` — 7 tests

### Touched files
- `lib/config.mjs` — +6 fields, -4 fields, sanity check, persona.group warning
- `lib/eval.mjs` — +4 exports (hashString, mulberry32, splitForHoldout, overfittingDetection), aggregateScores scoreField param, baseline v2, checkStreak golden-only, loadPromptSet v1 rejection. Deleted 8 functions.
- `lib/run.mjs` — deleted legacy mode (~450 LOC), new generation phase, scorePre/scorePost, replay-all, overfitting detection, promoter invocation, new scoring buckets
- `lib/init.mjs` — fullInit rewritten to empty v2
- `lib/reviewer-protocol.mjs` — import extractTagged from tagged-json
- `lib/audit.mjs` — lifecycle instead of group
- `lib/personas.mjs` — deleted getPersonasByGroup
- `lib/autodev.mjs` — dropped persona.group, fixed goldenSetPath
- `lib/compete.mjs` — replaced promoteToGoldenSet with loadPromptSet/savePromptSet
- `lib/index.mjs` — removed loadGoldenSet export
- `lib/metrics.mjs` — promotions + overfittingEvents sections
- `bin/cli.mjs` — deleted --train/--eval, updated status command
- `test/config.test.mjs` — +2 tests
- `test/eval.test.mjs` — +7 tests (scoreField, overfitting, baseline v2)
- `test/audit.test.mjs` — fixtures updated group→lifecycle
- `prompts/fixer.md` — knowledge-dir hint
- `prompts/fixer-model-error.md` — knowledge-dir hint
- `prompts/reviewer.md` — knowledge-dir hint
- `prompts/user-sim.md` — knowledge-dir hint

### Commits (14 implementation + 1 plan + 1 knowledge hints)
Test count: 45 → 83 (+38 across 4 new test files + 9 additions to existing files).

## Verification

- `npm test` — 83 tests passing across 10 files.
- `git grep` for all deleted symbols — zero hits in `lib/`, `bin/`.
- `node bin/cli.mjs init -c <config>` scaffolds a v2 empty prompt-set.
- `node bin/cli.mjs status -c <config>` shows Spec 2 tier display.
- Round 10 sonnet baseline: 8 runs completed, 17 golden prompts built, 0 overfitting events.

## Round 10 results

See `/Users/michaelperret/dev/mcp-evolve/docs/results-round-10-pubman/actual.md` for the full Round 10 narrative with per-run scores, golden-set inventory, fixer changes committed to pubmanager, and next-steps.
