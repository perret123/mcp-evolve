# Spec 2 Kickoff — Fresh Session Start Prompt

**Purpose:** Everything a fresh Claude Code session needs to start implementing Spec 2 (Train / Eval / Golden Redesign) for mcp-evolve, picking up from the completed Spec 1.

**How to use this file:** The user will paste the contents of this file (or ask Claude Code to read it) at the start of a new session. The session should follow the instructions verbatim: read the listed files, ask the clarifying questions, invoke writing-plans, then execute via subagent-driven-development.

---

## Session greeting for the fresh context

Hi! You're picking up Round 10 work on the mcp-evolve self-improving MCP test harness at `/Users/michaelperret/dev/mcp-evolve`. Spec 1 (Reviewer Audit Upgrade) landed in the previous session — 18 commits on master, 45 tests passing, ending at `fc9e7e4 chore(spec-1): pre-merge cleanup`. Your job is to implement Spec 2 (Train / Eval / Golden Redesign), which was written in the same Round 10 planning session as Spec 1 but deliberately staged to land AFTER Spec 1.

**Do not skip the context.** Read the files listed below BEFORE proposing any code. They give you the full picture of what Spec 1 added, what Spec 2 will touch, and what the user's preferences are. Skipping context is how Task 6 of Spec 1 shipped a null-alignment bug that would have poisoned every reviewer invocation.

## Reading list (in order)

1. **This file.** (You are here.)
2. `/Users/michaelperret/dev/mcp-evolve/docs/learnings/spec-1-implementation-notes.md` — What landed in Spec 1. TL;DR, architectural patterns to reuse (pure + async wrapper, runState threading, tagged-JSON output), bugs caught in review (4 case studies), file inventory, integration gaps between tasks, and a full list of things Spec 2 will touch with file:line references. This is your grep target for the plan.
3. `/Users/michaelperret/dev/mcp-evolve/docs/learnings/fixer-fabricated-constraints.md` — The Round 9 anti-pattern that drove Spec 1 and informs Spec 2's clean-slate migration. Read the addendums — they explain why the circular-error trap happens.
4. `/Users/michaelperret/dev/mcp-evolve/docs/superpowers/specs/2026-04-11-train-eval-golden-redesign-design.md` — The Spec 2 design doc. This is what you'll turn into an implementation plan.
5. `/Users/michaelperret/dev/mcp-evolve/docs/superpowers/specs/2026-04-11-reviewer-audit-upgrade-design.md` — The Spec 1 design doc. Spec 2 depends on Spec 1's audit + failing-prompts + adversarial flag.
6. `/Users/michaelperret/dev/mcp-evolve/docs/results-round-9-pubman/before-round-10-handover.md` — The handover narrative from Round 9 closeout. Non-negotiables (items #1-#12 in section "Non-negotiables — do not re-litigate") — DO NOT re-open these.
7. `/Users/michaelperret/dev/mcp-evolve/CLAUDE.md` — The mcp-evolve architecture overview.
8. `/Users/michaelperret/dev/mcp-evolve/docs/superpowers/plans/2026-04-11-reviewer-audit-upgrade.md` — The executed Spec 1 plan. Shows the task granularity and code-block format the user prefers. Use this as a structural template when writing the Spec 2 plan.

## Confirmed user preferences (do not re-ask)

These were all decided during Spec 1 execution. They apply to Spec 2.

1. **Hard rename / breaking changes are OK.** User chose "hard rename" for `adversarialRate` → `adversarialRatio` (no backwards compat shim). Expect similar for `persona.group` removal — delete the field, update all readers, no shim.

2. **Work directly on master branch.** User approved this explicitly for Spec 1. They are the only developer; no feature branches needed unless the user says otherwise. Do not switch branches or propose PR-based workflow.

3. **Remove legacy mode entirely.** User explicitly said in Round 9 closeout: "yes - we can remove the 'legacy' mode as we will continue with a new test/eval/golden mode". Spec 2 should delete the `!useFixedSets` branches in `lib/run.mjs` (18 occurrences of `useFixedSets`), delete `updateGoldenHealth`, `updatePromptSetAfterRun`, `goldenBlockThreshold`, and migrate the task-manager example accordingly. The `examples/task-manager/` prompt-set can be regenerated via `init` after Spec 2 merges.

4. **JSON in tagged blocks for LLM structured output.** Used in Spec 1's reviewer (`<AUDIT>`, `<PROMPT_REVIEW>`). Spec 2's promoter should use the same format: `<NOMINATIONS>` and `<SKIPPED>` tagged JSON blocks. Node has no built-in YAML parser and `JSON.parse` on a regex-extracted block is the most reliable pattern.

5. **Test runner is `node --test test/*.mjs`** via `npm test`. Baseline before Spec 2 is 45 passing tests (6 test files).

6. **Per-task code review catches real bugs.** The user will run the same subagent-driven-development loop for Spec 2. Plan accordingly: TDD with per-task spec review + per-task code quality review. Four bugs were caught mid-Spec-1 this way — read `spec-1-implementation-notes.md` section "Bugs caught in per-task code review" for the case studies.

7. **Do not delete `docs/learnings/` content.** These are permanent references. When Spec 2 is done, add `docs/learnings/spec-2-implementation-notes.md` alongside this file.

8. **Minor issues batch into final cleanup commit, not per-task fixes.** The Spec 1 pattern was: per-task Important fixes were committed individually; Minor style/dead-code issues accumulated into a single `chore(spec-X): pre-merge cleanup` commit at the end. More efficient than spawning reviewer-loops per Minor issue.

## What Spec 1 delivered that Spec 2 depends on

See `docs/learnings/spec-1-implementation-notes.md` sections "File/module inventory" and "Spec 2 load-bearing things from Spec 1" for the detailed inventory. The essentials:

- **Audit path is mode-agnostic.** `runAuditAndMerge` in `lib/audit.mjs` works whether the generator is generating fresh per run (Spec 2) or reading from a persisted prompt-set (Spec 1 pubman). Spec 2's new generator calls it the same way.
- **Failing-prompts store** with prompt-kind and pattern-kind entries, persisted at `.mcp-evolve/failing-prompts.json`. MUST NOT be wiped by Spec 2's migration.
- **`adversarial: true` prompt field** (explicit, not `expectedOutcome: 'error'`). The grader, fixer-input filter, anti-examples injector, and promoter (new in Spec 2) all read this field.
- **Config additions from Spec 1:** `reviewerAuditEnabled` (default `true`), `reviewerTools` includes `Bash`, `adversarialRatio: 0`, `failingPromptsPath` derived from `dataDir`.
- **runState threading pattern.** `runState.audit.{fixer,modelError}` populated per-phase, consumed by metrics + run log. Spec 2 adds `runState.promoter` and `runState.overfitting` as peers.
- **JSDoc convention.** Public functions get JSDoc (`applyAuditDecisions` is the template); private helpers don't.
- **Test convention.** try/finally + `rmSync(..., { recursive: true, force: true })` for any test that touches the filesystem.

## What Spec 2 must do (high-level from the spec)

1. **Two orthogonal fields on prompts:** `lifecycle: train|golden` + `evaluation: fixer|holdout`. Remove `persona.group` entirely (7+ files, 9+ code lines — grep don't eyeball).
2. **Train + holdout are ephemeral per run.** Generated fresh every run against current emulator state (uses the existing `generatePrompts` plus a new holdout-split step).
3. **Holdout is in-batch split** (K of N per persona, default K=1, N=3) — same generation distribution as train, not a separate static set.
4. **Only golden persists** in `prompt-set.json`. Train/holdout live in the run log and the scored list, never in `prompt-set.json`.
5. **Pre/post-fix scoring on every tier.** Emit `train_pre`, `train_post`, `holdout_pre`, `holdout_post`, `golden_pre`, `golden_post`. `aggregateScores` gains an optional `scoreField` parameter.
6. **Replay phase re-runs ALL prompts** including holdout. This is the doubling of answerer calls. Current replay only re-runs failed prompts — Spec 2 expands that.
7. **Overfitting detection.** `train_post - train_pre > threshold` AND `holdout_post - holdout_pre < -threshold` → `overfittingDetected: true`. Default threshold 0.1 (10%).
8. **New Promoter-Agent.** Nominates 0-3 passing train prompts per run for graduation to golden. Criteria: distinctness from existing golden, clean pass, idempotent state change, anchor value. Runs via claude CLI with `config.promoterModel` default `sonnet`. Output in tagged JSON (`<NOMINATIONS>`, `<SKIPPED>`).
9. **Clean-slate migration.** Wipe `.mcp-evolve/prompt-set.json` to `{version: 2, prompts: []}`. Preserve a backup file next to the original. User already approved discarding all existing prompts in Round 9 closeout (non-negotiable #8).
10. **Config additions.** `promptsPerPersona: 3`, `holdoutPerPersona: 1`, `overfittingThreshold: 0.1`, `maxPromotionsPerRun: 3`, `promoterModel: 'sonnet'`, `promoterPromptFile: 'promoter.md'`. Delete `graduationStreak`, `goldenBlockThreshold`, `maxTrainPerRun`, `maxGoldenPerRun`.

## Suggested implementation sequence

Plan scope is estimated at ~500-700 LOC across ~10-12 tasks. Mirror the Spec 1 plan's task granularity: one TDD cycle per task (write test → confirm fail → implement → confirm pass → commit).

1. **Write the plan first, don't start coding.** The user's workflow is: spec → plan (via `superpowers:writing-plans`) → execute (via `superpowers:subagent-driven-development`). Start by reading the listed files, asking the clarifying questions, then invoking writing-plans. Do NOT skip the plan step.

2. **Ask clarifying questions BEFORE writing the plan.** During Spec 1 kickoff the user answered decision questions via AskUserQuestion that shaped the plan architecture. Repeat that pattern. Minimum required questions (see "Open questions Spec 2 will need to answer" below for full list):
   - Legacy mode disposition: delete entirely vs keep as parallel unused code path
   - `saveBaseline` schema: store scorePre+scorePost or only scorePost
   - `checkStreak` semantics: golden_post only or all tiers
   - Clean-slate migration timing: explicit `migrate` subcommand only, or `--auto-migrate` opt-in flag, or auto-run on first detected v1 prompt-set
   - Promoter output format: `<NOMINATIONS>` + `<SKIPPED>` tagged JSON (recommended — mirrors Spec 1)
   - CLI flag disposition: delete `--train` / `--eval` or repurpose

3. **Plan structure mirrors Spec 1's.** See `docs/superpowers/plans/2026-04-11-reviewer-audit-upgrade.md` for the template. Task granularity: one TDD cycle per task. Each task ≤ 5 steps. Exact file paths with line-number anchors (copy the anchors from `spec-1-implementation-notes.md` "Things Spec 2 will touch"). Exact code blocks for both the test and the implementation.

4. **Task 1: config scaffolding.** Add new config fields (`promptsPerPersona` already exists; add `holdoutPerPersona`, `overfittingThreshold`, `maxPromotionsPerRun`, `promoterModel`, `promoterPromptFile`). Delete `graduationStreak`, `goldenBlockThreshold`, `maxTrainPerRun`, `maxGoldenPerRun`. Add sanity check: error if `holdoutPerPersona >= promptsPerPersona`. Add warning at load time if any persona still has `group: 'eval'`. Test: `test/config.test.mjs` gains new assertions.

5. **Task 2: migration helper early.** Create `lib/migrate-v2.mjs` with `migrateV2(config)` function. Writes a backup to `promptSetPath.backup.<date>.json`, then writes `{version: 2, prompts: [], migratedFrom: <v1 version>, migratedAt: <ISO>}`. Tests: `test/migrate-v2.test.mjs` with try/finally temp dirs. Wire into `bin/cli.mjs` as `migrate` subcommand. The migration MUST NOT touch `failing-prompts.json`.

6. **Task 3: splitForHoldout helper in eval.mjs.** `splitForHoldout(prompts, K, seed)` deterministically splits N prompts into train/holdout using a seeded RNG (e.g., `mulberry32(hashString(runStartTime + persona.id))`). Tests: same seed yields same split; K marked `evaluation: 'holdout'`, rest `evaluation: 'fixer'`; all get `lifecycle: 'train'`.

7. **Task 4: aggregateScores gains scoreField parameter.** `lib/eval.mjs:165`. Change `aggregateScores(scoredPrompts, scoreField = 'score')` and read `q[scoreField]` where it currently reads `q.score`. All existing callers keep the default; Spec 2 callers pass `'scorePre'` or `'scorePost'`. Update `test/eval.test.mjs` to cover both paths.

8. **Task 5: promoter module + prompt.** Create `lib/promoter.mjs` mirroring `lib/audit.mjs` structure: `applyPromoterDecisions` (pure) and `runPromoter` (async wrapper). Create `prompts/promoter.md` with the promoter-agent prompt from the spec design doc. Create `lib/promoter-protocol.mjs` for parsing `<NOMINATIONS>` + `<SKIPPED>` tagged JSON (OR factor `extractTagged` out of `reviewer-protocol.mjs` into a shared module). Tests: `test/promoter.test.mjs` with synthesized reviewer-style output. Pass the failing-prompts store as input to the promoter so it doesn't nominate prompts already rejected — this was flagged in spec-1-implementation-notes.md open questions.

9. **Task 6: fresh train+holdout generation wired into run flow.** In `lib/run.mjs`, add a new generation phase that runs every run (not just init). Calls existing `generatePrompts(persona, config, fullContext, runDateContext, failingEntries)` from Spec 1, then `splitForHoldout` for the in-batch split. The generated prompts get `lifecycle: 'train'` and either `evaluation: 'fixer'` or `evaluation: 'holdout'`. Loaded golden gets `lifecycle: 'golden'`, `evaluation: 'fixer'`. Combine into `promptsToRun`.

10. **Task 7: pre-fix scoring + scorePre field.** After the first answerer+grade pass, each prompt gets `scorePre = q.score`. Compute `trainPre`, `holdoutPre`, `goldenPre` via `aggregateScores(..., 'scorePre')`. Emit to run log.

11. **Task 8: replay all prompts + scorePost field.** Currently replay only re-runs failed prompts. Spec 2 expands to re-run ALL prompts (including holdout) after fixer applies changes. Each prompt gets `scorePost = replayScore`. Compute `trainPost`, `holdoutPost`, `goldenPost`. Emit to run log.

12. **Task 9: overfitting detection.** After post-fix scoring, compute deltas and emit `runState.overfitting = {detected, trainDelta, holdoutDelta, threshold, divergences}`. Per-prompt divergence check: for each holdout prompt that went pass→fail, find any train prompt by the same persona that went fail→pass. Emit warning log line with banner if detected.

13. **Task 10: Promoter-Agent invocation.** After overfitting detection, run `runPromoter({candidates, currentGolden, config, failingEntries, runId})`. Apply nominations via `applyPromoterDecisions`, which appends to `prompt-set.json` with `lifecycle: 'golden'`, `evaluation: 'fixer'`, `promoterEvidence`, `promotedAt`, `consecutivePasses: 1`. Emit `runState.promoter` and thread through run log + metrics.

14. **Task 11: legacy mode deletion + task-manager migration.** Delete all `!useFixedSets` branches. Delete `updatePromptSetAfterRun`, `updateGoldenHealth`, `addTrainPrompts` (or rewrite to inject into current run instead of persist). Delete `goldenBlockThreshold` usage. Migrate `examples/task-manager/` — either wipe its `.mcp-evolve/prompt-set.json` and let `init` regenerate, or document that task-manager needs re-initialization after Spec 2. Estimate ~300 LOC deletions plus task-manager fix-ups.

15. **Task 12: E2E verification + manual tests.** Run `npm test` (expect new tests to pass, old tests that referenced legacy mode may need updates). Run `node bin/cli.mjs migrate` on a test pubmanager checkout. Run one full iteration of pubman through the new flow. Verify: failing-prompts.json still feeds anti-examples, adversarial prompts still filter out, reviewer audit still catches fabrications, promoter nominates at most maxPromotionsPerRun, overfitting detection fires on a synthetic case.

## Non-negotiables from Round 9 handover

Copied from `docs/results-round-9-pubman/before-round-10-handover.md` section "Non-negotiables — do not re-litigate" (lines 67-93). DO NOT re-open these.

1. The existing reviewer is upgraded; no new review agent added. **(Spec 1 — done.)**
2. Case matrix is two orthogonal decisions: is the fix legit, is the prompt legit. **(Spec 1 — done.)**
3. Backend check via grep only — no extra LLM call for the check. **(Spec 1 — done.)**
4. Failing prompts are fed as anti-examples to the generator, not as a mechanical filter. Exception: pattern-level failing entries ARE a mechanical filter on the model-error fixer input. **(Spec 1 — done.)**
5. No expiry mechanism for failing-prompts in V1. YAGNI. **(Spec 1 — done.)**
6. N=3 prompts per persona, K=1 holdout per persona as defaults. Configurable.
7. Eval (holdout) runs twice — pre-fix AND post-fix. Replay includes holdout.
8. Clean-slate migration — wipe all existing prompts, including golden. User explicitly approved this over "keep the 11 golden" because of contamination risk.
9. Two separate agents for reviewer and promoter. Not unified. Different inputs, outputs, incentives, pipeline positions.
10. Answerer receives no system prompt — tool descriptions must carry the context. If context-awareness is missing (language, domain conventions, confirm-before-writes), the fix is in tool descriptions, not in a system prompt.
11. Probe contamination is handled as a side effect of Spec 1 — no separate probe-regeneration step. **(Spec 1 — done.)**
12. Adversarial prompts supported via optional `adversarial: boolean` field, default false. V1 generator does NOT auto-produce (`adversarialRatio: 0` default). **(Spec 1 — done.)**

## Open questions Spec 2 will need to answer

Decide these with the user during the clarifying-questions phase, before invoking writing-plans.

1. **What replaces saveBaseline in the pre/post world?** Save `scorePre` AND `scorePost` per prompt? Or only `scorePost` (the final state)? Recommendation: save both, with the `score` field remaining as an alias for `scorePost` for backwards compat with `isPassingScore` consumers. Add a `version: 2` field to the baseline file so `--regression` replay can handle old + new formats.

2. **checkStreak semantics.** Is "100% run" defined as `golden_post.successRate === 100`? What if there are 0 golden prompts (first run after migration)? Recommendation: golden_post only; streak is 0 when there are no golden prompts yet. The first few post-migration runs will have empty golden, so no streak.

3. **Competition trigger.** Still uses `streak × competitionStreakMultiplier`. Does competition still fire only when golden is 100%? Recommendation: unchanged — still tied to golden_post streaks. Feature competition is a "we've won this territory, go find new territory" signal, not an overfitting indicator.

4. **Legacy mode disposition.** User said to remove entirely. But task-manager example uses a v1 prompt-set. Recommendation: (a) delete all `!useFixedSets` code paths, (b) wipe `examples/task-manager/.mcp-evolve/prompt-set.json` during Spec 2 migration too, (c) document that running task-manager after Spec 2 requires `node bin/cli.mjs init` to regenerate. User already approved removing legacy mode, so (a) is non-negotiable; (b) and (c) are implementation choices.

5. **`--train` / `--eval` CLI flags.** After `persona.group` removal these do nothing meaningful. Recommendation: delete both. They're artifacts of the old per-persona train/eval distinction.

6. **Baseline compatibility.** `--regression` reads baseline JSON. Recommendation: baselines store both pre and post; if an older baseline only has `score`, treat it as `scorePost` only. Include a `version: 2` field in new baselines. Add a compatibility layer in `loadBaseline` that normalizes old and new formats.

7. **Promoter ↔ failing-prompts interaction.** Spec 2 doesn't say explicitly. Recommendation: pass `failingEntries` as an input to `runPromoter` and skip candidates whose `(persona, prompt)` pair is in `failing-prompts.json`. Otherwise a prompt could be promoted, then rejected by the reviewer next run, then re-promoted the run after — a loop.

8. **Probe contamination check at promotion time.** When the promoter nominates a passing train prompt, does it check that the probe invariant is valid? Recommendation: add a light check to the promoter prompt — "reject candidates whose probe invariant contradicts any tool call in the successful trace". Spec 1's reviewer catches contamination during the FIX phase, but train prompts that pass without triggering fixer are never seen by the reviewer, so a contaminated invariant could slip through.

9. **Migration trigger.** Explicit `migrate` subcommand only, or opt-in `--auto-migrate` flag, or auto-run on first detected v1 prompt-set? Recommendation: explicit only. User must run `node bin/cli.mjs migrate` before Round 10. Auto-migrate risks surprise wipes.

10. **runState.promoter + runState.overfitting structure.** Peers of `runState.audit` — do NOT nest. Design: `runState = { audit: {fixer, modelError}, promoter: {...}, overfitting: {...} }`.

## Known gotchas

From `docs/learnings/spec-1-implementation-notes.md` section "Integration gaps between tasks", plus Spec 2-specific:

- **`lib/eval.mjs:addTrainPrompts` is the constructor for persisted promptObj.** Every field addition (scorePre, scorePost, lifecycle, evaluation) needs to touch this OR the function should be deprecated and replaced. In Spec 2, it's likely replaced by `addGoldenFromPromotion` (a new helper that appends a promoter-nominated prompt to `prompt-set.json` with the golden lifecycle).
- **`persona.group` is in 9 code locations across `lib/run.mjs` + `lib/eval.mjs`.** Use grep, don't eyeball. See `spec-1-implementation-notes.md` "Things Spec 2 will touch" for the exact line numbers.
- **`lib/init.mjs` auto-generates personas AND prompts.** Spec 2 should change `init` so first-run creates an empty prompt-set (`{version: 2, prompts: []}`), not a populated one. The `createPromptSet(allPrompts, 0)` call at `init.mjs:139` goes away.
- **The task-manager example config** uses legacy mode implicitly (the `useFixedSets` flag is derived from `!!promptSet` at `run.mjs:943`). Migrating it is scope creep but user approved removing legacy mode, so it must happen.
- **`.mcp-evolve/baselines/` files** are consumed by `--regression` mode. If the baseline schema changes, regression replay needs to handle both v1 (only `score`) and v2 (pre + post). Add the compat layer or freeze v1 baselines and require v2 runs to build new ones.
- **`config.maxTrainPerRun` / `maxGoldenPerRun`** — old sampling strategy. In Spec 2 the generator produces exactly N per persona, so both fields become meaningless. Delete, don't deprecate.
- **`reviewer-protocol.mjs` has an `extractTagged` helper** that Spec 2 needs for promoter output parsing. Either duplicate it in `promoter-protocol.mjs` or factor it out into a shared module. Duplicating is faster; factoring is cleaner. Recommendation: factor into `lib/tagged-json.mjs` exporting `extractTagged` and use from both protocol files.
- **The `scoredPrompts` transform at `lib/run.mjs:1568-1581`** is the ONE place that converts raw results into the scoring-shape entries. Spec 2's `lifecycle` + `evaluation` + `scorePre` + `scorePost` + `invalid` all need to flow through this block. It was already touched in Task 10 of Spec 1 for `invalid`/`invalidReason`.

## Commands the fresh session will need

```bash
# Read the Spec 1 plan as a structural template
Read /Users/michaelperret/dev/mcp-evolve/docs/superpowers/plans/2026-04-11-reviewer-audit-upgrade.md

# Read the Spec 2 design doc
Read /Users/michaelperret/dev/mcp-evolve/docs/superpowers/specs/2026-04-11-train-eval-golden-redesign-design.md

# Baseline tests (should be 45 passing)
cd /Users/michaelperret/dev/mcp-evolve && npm test

# Check Spec 1 commits (last 18 on master)
cd /Users/michaelperret/dev/mcp-evolve && git log --oneline fc37e4c..HEAD

# Smoke test the failing-prompts CLI (reachable from pubmanager)
cd /Users/michaelperret/dev/pubmanager && node ../mcp-evolve/bin/cli.mjs failing list

# Invoke the plan-writing skill (after clarifying questions)
Skill({skill: "superpowers:writing-plans"})

# Invoke the executor (after plan approval)
Skill({skill: "superpowers:subagent-driven-development"})
```

## How to handle the session handoff

1. **The user will paste this file OR point Claude Code at it** (e.g., "read `docs/learnings/spec-2-kickoff-prompt.md` and start").

2. **Acknowledge the context.** Say what you've read and what you understand about the task. Do NOT immediately propose code. Do NOT immediately invoke writing-plans.

3. **Read the listed files in order.** spec-1-implementation-notes.md first (it has the file:line anchors you'll need for the plan); then the Spec 2 design doc; then the Round 9 handover. The Spec 1 design doc and plan are reference material — skim them for context but don't read cover-to-cover.

4. **Ask the clarifying questions** from section "Open questions Spec 2 will need to answer". Use `AskUserQuestion` if the tool is available. Bundle the high-impact decisions into a single question call; don't spam per-question.

5. **Invoke writing-plans skill** after the clarifying questions are answered. Follow the same task-granularity and format as the Spec 1 plan. Mirror the structure: File Structure section at the top, then numbered tasks with Files/Steps/Commit subsections.

6. **Get plan approval before executing.** The user may edit the plan. Wait for explicit go.

7. **Invoke subagent-driven-development** to execute. Between each Spec 2 task: per-task spec review + per-task code review. This catches real bugs — 4 of them in Spec 1.

8. **Final whole-implementation review** before closing out. Verify: no legacy mode references remain, `persona.group` grep returns zero, `useFixedSets` grep returns zero, all new config fields are documented, the migration backup path works, test count has increased correctly.

9. **After Spec 2 merges:** the user runs `node bin/cli.mjs migrate` in `/Users/michaelperret/dev/pubmanager`, which wipes `prompt-set.json` to v2 empty and saves a backup. Then Round 10 begins: 10 runs with `ollama:qwen3.5:35b-a3b-coding-nvfp4` answerer + 5 runs `sonnet` baseline. You will NOT run Round 10 yourself — the user kicks it off via their wrapper script in `pubmanager/scripts/`.

## Current git state at the time of this writing

- **Branch:** `master`.
- **HEAD commit:** expected to be at or near `fc9e7e4 chore(spec-1): pre-merge cleanup`, plus whatever commits land from the cleanup subagent running in parallel to this writing.
- **Tests:** 45 passing across 6 test files (`audit`, `config`, `eval`, `failing-prompts`, `reviewer-protocol`, `timings`). Verify with `npm test` before starting.
- **Files that Spec 2 will need to touch:** listed in `docs/learnings/spec-1-implementation-notes.md` section "Things Spec 2 will touch" with file:line anchors.
- **Parallel session:** at the time of this writing, a sibling subagent is running pre-merge cleanup. Do NOT start Spec 2 code changes until the cleanup commits have all landed on `master` and the working tree is clean. Check `git status` before touching anything.

## Final thought

Spec 1 landed 18 commits and caught 4 real bugs mid-flight because the subagent-driven-development loop worked. Spec 2 has more surface area (~500-700 LOC vs Spec 1's ~400 LOC), legacy code deletion, and a new agent role. Plan carefully, respect the non-negotiables, use the patterns from Spec 1, and let the per-task review catch the bugs it will catch.

Good luck with Spec 2.
