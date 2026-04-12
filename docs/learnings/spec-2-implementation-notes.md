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

(Fill in with actual case studies from this session's review cycles.)

## Verification

- `npm test` — 83 tests passing across 10 files.
- `git grep` for all deleted symbols — zero hits in `lib/`, `bin/`.
- `node bin/cli.mjs init -c <config>` scaffolds a v2 empty prompt-set.
- `node bin/cli.mjs status -c <config>` shows Spec 2 tier display.
