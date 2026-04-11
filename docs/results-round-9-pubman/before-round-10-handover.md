# Before Round 10 — New Session Handover

**Written:** 2026-04-11 ~20:45 CEST
**Purpose:** everything a fresh Claude Code session needs to continue Round 10 work without replaying the Round 9 closeout conversation.

## TL;DR — 60 seconds

Round 9 of the mcp-evolve pubman evaluation was **stopped early at Run 18** (highest score of the round: 53.7% all / 90.9% golden). The round's goals were met: the fabricated-constraint anti-pattern was discovered, documented, and the hardened fixer prompt demonstrably held in Run 18.

Two **design specs** for Round 10 were then written, reviewed, and committed. They are **not yet implemented**.

- **Spec 1** — Reviewer Audit Upgrade + Failing-Prompts Set. **Blocks Round 10.** Implement first.
- **Spec 2** — Train / Eval / Golden Redesign. Depends on Spec 1. Implement second.

After both specs ship, run the clean-slate migration, then start Round 10 (10 qwen runs + 5 sonnet baseline runs).

**Do not start any mcp-evolve runs before Spec 1 is merged.** The fabricated-constraint risk is still live without the reviewer upgrade.

## Read these in order

1. **This document** (you are here)
2. `docs/results-round-9-pubman/actual.md` — full Round 9 narrative with the Closeout section at the bottom. Explains what happened, why Round 9 closed, the four key discoveries, and the Round 10 sequencing.
3. `docs/results-round-9-pubman/HANDOVER.md` — status of runtime services, archive locations, git state at closeout.
4. `docs/superpowers/specs/2026-04-11-reviewer-audit-upgrade-design.md` — Spec 1.
5. `docs/superpowers/specs/2026-04-11-train-eval-golden-redesign-design.md` — Spec 2.
6. `docs/learnings/fixer-fabricated-constraints.md` — the anti-pattern doc (with two addendums covering the compounding iteration).
7. `CLAUDE.md` — mcp-evolve architecture overview.

Only go further (e.g., read run.mjs, eval.mjs) when you are ready to start implementing. The specs are designed to be implementable without deep code diving first.

## Implementation sequence for Round 10

1. **Implement Spec 1** (Reviewer Audit Upgrade + Failing-Prompts Set)
   - Use the `writing-plans` skill to turn the spec into a step-by-step plan, then execute
   - Scope: ~300-400 LOC across `lib/run.mjs`, `lib/failing-prompts.mjs` (new), `prompts/reviewer.md` (rewrite), `prompts/user-sim.md` (anti-examples section), `prompts/fixer-model-error.md` (pattern filter), `lib/config.mjs`, `lib/eval.mjs`, `lib/metrics.mjs`, `bin/cli.mjs`
   - Verify with the 8 test cases listed in the spec's Verification section
   - Commit and merge before touching Spec 2

2. **Implement Spec 2** (Train / Eval / Golden Redesign)
   - Same pattern: writing-plans → execute
   - Scope: ~500-700 LOC, mostly in `lib/run.mjs`, `lib/eval.mjs`, `lib/promoter.mjs` (new), `prompts/promoter.md` (new), `lib/migrate-v2.mjs` (new), `lib/config.mjs`, `lib/metrics.mjs`, `bin/cli.mjs`
   - Verify with the 10 test cases listed in the spec's Verification section
   - Do NOT run the migration yet — that happens in step 3

3. **Run the clean-slate migration**
   - In `pubmanager/`, run: `node ../mcp-evolve/bin/cli.mjs migrate`
   - Verifies a backup is created, then wipes `.mcp-evolve/prompt-set.json` to `{version: 2, prompts: []}`
   - User already approved discarding all existing prompts (including the 11 pre-graduated golden) because of contamination risk from the Round 8/9 era

4. **Run Round 10 — primary**
   - 10 runs with `ollama:qwen3.5:35b-a3b-coding-nvfp4` as answerer (same as Round 9 for continuity)
   - Use a new wrapper script in `pubmanager/scripts/evolve-round-10.sh` (model on `scripts/evolve-runs-11-to-20.sh`)
   - Monitor `failing-prompts.json` after each run to confirm the reviewer is catching what it should
   - Track new metrics: `train_pre/post`, `holdout_pre/post`, `golden_pre/post`, `overfittingDetected` events

5. **Run Round 10 — Sonnet baseline**
   - 5 runs with `sonnet` as answerer, everything else identical
   - Separate log directory so results are not intermixed
   - Purpose: isolate "local-model plateau" from "architectural plateau"

6. **Round 10 cleanup backlog** (after runs stabilise)
   - Cleanup shouty error messages in `packages/pubman-mcp/src/tools/helpers.ts` (`⛔ STOP`, `REQUIRED NEXT ACTION` etc.)
   - Grep pubman-mcp for other candidate fabricated constraints (`isError: true` + hardcoded domain messages)
   - Mine `.mcp-evolve/timings.jsonl` for per-tool / per-persona timing patterns

## Non-negotiables — do not re-litigate

These were decided during the Round 9 closeout session. Honor them in Round 10; do not re-open them unless you have strong new evidence.

1. **The existing reviewer is upgraded; no new review agent is added.** Spec 1 rewrites `prompts/reviewer.md` and changes the reviewer's output parser; it does not introduce a new role.

2. **Case matrix is two orthogonal decisions.** For each fixer output, the reviewer asks separately (a) is the fix legit? and (b) is the prompt legit? These produce four outcomes (merge+keep, merge+drop, reject+keep, reject+drop). Do not collapse them into a single "good/bad" call.

3. **Backend check via grep only — no extra LLM call for the check.** The reviewer itself is an LLM running in Claude Code CLI with Read/Grep/Bash tools. It performs its own grep-based investigation. There is no separate "audit LLM" invoked as an additional step.

4. **Failing prompts are fed to the generator as anti-examples, not as a mechanical filter.** The LLM handles semantic avoidance through prompt context. Do not build a regex/embedding filter. Exception: pattern-level failing entries (from model-error-fixer rejections) are applied as a pre-filter on the model-error fixer's input.

5. **No expiry mechanism for failing-prompts in V1.** YAGNI. Add auto-expiry only if the failing set proves unmanageable in practice.

6. **N=3 prompts per persona, K=1 holdout per persona** as defaults. Configurable via `promptsPerPersona` / `holdoutPerPersona` in `evolve.config.mjs`.

7. **Eval (holdout) runs twice: pre-fix AND post-fix.** The replay phase re-runs all prompts including holdout, and the pre/post delta is the overfitting signal. Do not collapse this to a single pre-fix run.

8. **Clean-slate migration — wipe all existing prompts, including golden.** The user explicitly approved this over the "keep the 11 golden" option. Contamination risk from the Round 8/9 era outweighs the value of preserving earned golden.

9. **Two separate agents for reviewer and promoter.** They do different things (different inputs, outputs, incentives, pipeline positions). Do not unify them. They may share a meta-philosophy ("correctness over tests-green"), but not code.

10. **Answerer receives no system prompt — tool descriptions must carry the context.** If context-awareness is missing (language, domain conventions, confirm-before-writes), the fix is in tool descriptions, not in a system prompt. The fixer's scope explicitly includes description improvements for this reason.

11. **Probe contamination is handled as a side effect of Spec 1 — no separate probe-regeneration step.** When a contaminated invariant triggers a fix attempt, the reviewer's case matrix drops the prompt from scoring and pushes it to the failing-prompts store. The contaminated invariant disappears with the prompt.

12. **Adversarial prompts are supported via an optional `adversarial: boolean` field, defaulting to false.** V1 generator does NOT automatically produce adversarial prompts (`adversarialRatio: 0` default). Existing or manually-added adversarial prompts are respected. Opt-in only.

## Gotchas — traps to avoid

- **Do not start mcp-evolve runs before Spec 1 is merged.** Round 9 stopped because running without the reviewer upgrade carries fresh fabrication risk every iteration.

- **The occupied-table guard is STILL a risk.** It was reverted twice in Round 9. Without the reviewer upgrade, a fresh run could cause the fixer to re-fabricate it. Spec 1's reviewer is the structural defense.

- **The "eval personas" that appear to exist in pubman's config are misconfigured.** Pubman has three personas (`waiter-payments`, `waiter-management`, `new-employee`) marked `group: 'eval'`. This field is silently ignored — their prompts run as normal train prompts and `scores.eval` is always 0. Spec 2 resolves this by moving eval marking from per-persona to per-prompt via the new `evaluation: fixer|holdout` field. Do not try to "fix" the persona config — it gets removed as part of Spec 2's config migration.

- **Probe invariants in `.mcp-evolve/prompt-set.json` are contaminated.** At least the Tisch 5 "must be empty before seating" invariant is enshrining the old fabricated guard's behaviour as ground truth. This is why Run 18 had 23 `harness:grading` errors — the backend is doing the right thing (multi-occupancy), but the probe says it shouldn't. The clean-slate migration in Spec 2 wipes these; do not try to manually fix them before the migration.

- **Round 8 + Round 9 baseline files in `.mcp-evolve/baselines/` reference prompts that will be wiped.** The clean-slate migration will leave those baselines dangling. They are preserved in `pubmanager/.mcp-evolve/archive/round-9/` for historical inspection but will not match any live prompts after migration.

- **Backend changes from Round 9 are committed to pubmanager.** Do not re-run the fixer on the current backend expecting a clean slate — the improvements from Round 9 (getFloorStatus active filter, manageGuest seats normalization, finalizeDailyTurnover dedup, etc.) are already merged. See pubmanager commit `caab390d` for the full list.

- **pubman's `reviewerTools` config must be extended.** Spec 1 requires the reviewer to run `git log`, which needs the `Bash` tool. Default `reviewerTools` is currently `'Read,Edit,Grep,Glob'`. Spec 1's implementation adds `Bash`. If you forget this, the audit checklist will silently fail on the git-log step.

- **The rebuild step for pubman-mcp is manual.** After any changes to `packages/pubman-mcp/src/tools/*.ts`, run `cd packages/pubman-mcp && npm run build` to update `dist/`. The running MCP server loads from `dist/`, not from source. mcp-evolve invokes the MCP via stdio using the dist path.

## Repo state at closeout

### pubmanager — branch `release/3.0.8`

Last 3 commits (new from the closeout session):

```
13606d13 chore(mcp-evolve): untrack runtime state files
c33c9093 chore(mcp-evolve): archive Round 9 state and add runs 11-20 wrapper script
caab390d feat: pubman-mcp improvements from mcp-evolve Round 9 (runs 11-18)
```

Commit `caab390d` includes the clear-cut MCP-layer improvements from Round 9 plus four backend callable changes that were reviewed and approved in the closeout session:
- `packages/pubman-mcp/src/tools/{helpers,read,write}.ts` — all Round 9 fixer improvements
- `functions/lib/api/callables/reads/getFloorStatus.js` — active filter + rooms lookup (with a detailed JSDoc comment explaining the MCP-primary-consumer motivation)
- `functions/lib/api/callables/reads/getFinancialData.js` — voucher date filter
- `functions/lib/api/callables/guests/manageGuest.js` — seats normalization
- `functions/lib/api/callables/payments/finalizeDailyTurnover.js` — duplicate-empty guard

Commit `c33c9093` committed the frozen Round 9 archive to `pubmanager/.mcp-evolve/archive/round-9/`, the `prompt-set.json.round-9-final` backup, and the `scripts/evolve-runs-11-to-20.sh` wrapper.

Commit `13606d13` untracked three runtime state files and updated `.gitignore` so future runs do not produce git noise on `metrics.json`, `prompt-set.json`, `timings.jsonl`, or `run-*.log`.

Intentional uncommitted at closeout (pre-existing, unrelated to Round 9):
- `apps/pubman/pubspec.lock` — Flutter lockfile version bumps from unrelated branch work
- `deployment/checklist.md` — one-line ops comment

Leave these alone; they are someone else's in-progress work.

### mcp-evolve — branch `master`

Last 3 commits (new from the closeout session):

```
<sha> docs(round-9): add Before-Round-10 handover for new sessions
8da4bb9 docs(specs): Round 10 design specs — reviewer audit upgrade + train/eval/golden redesign
e2f7977 docs(round-9): closeout — stopped early at Run 18, transition to Round 10
```

(the latest hash will be this file's own commit)

`e2f7977` updates `actual.md` and `HANDOVER.md` with the closeout content.
`8da4bb9` commits the two Round 10 specs.
The latest commit adds this handover document.

Current branch is `master`, 9+ commits ahead of `origin/master`. Not pushed yet. The user may or may not want to push — check with them.

### Runtime services

- **ollama at localhost:11434** — was running during Round 9. May or may not still be running. Verify with `curl -s localhost:11434/api/tags` before starting Round 10.
- **Firebase emulator at localhost:8080/5001/9099/9199** — was running. Verify with `curl -s localhost:8080` before starting Round 10. If not running, start with `cd pubmanager && ./emulators/start.sh`.
- **pubman-mcp `dist/`** — was rebuilt after the Round 9 reverts. After any new fixer runs or manual edits, remember to `cd pubmanager/packages/pubman-mcp && npm run build`.
- **No mcp-evolve processes running.** All wrapper loops and node runners were killed at closeout (~20:10 CEST).

## Archive locations

Everything from Round 8 + Round 9 is preserved under:

- `pubmanager/.mcp-evolve/archive/round-9/logs/` — 16 per-run JSON log snapshots (Runs 1-18)
- `pubmanager/.mcp-evolve/archive/round-9/metrics.json` — metrics.json at closeout
- `pubmanager/.mcp-evolve/archive/round-9/timings.jsonl` — full event log from all instrumented runs
- `pubmanager/.mcp-evolve/prompt-set.json.round-9-final` — final prompt set (36 entries: 25 train + 11 golden)

These are committed in pubmanager commit `c33c9093`. The clean-slate migration in Spec 2 does NOT touch the archive.

## Key configuration values for Round 10

When implementing Spec 2, use these defaults (already specified in the spec but worth surfacing here):

```js
// In evolve.config.mjs or pubmanager/evolve.config.mjs
{
  promptsPerPersona: 3,          // N
  holdoutPerPersona: 1,          // K
  maxPromotionsPerRun: 3,
  promoterModel: 'sonnet',
  overfittingThreshold: 0.1,     // 10% delta triggers alarm
  adversarialRatio: 0,           // V1: no auto-generated adversarial prompts
  reviewerAuditEnabled: true,    // kill-switch, default on

  // reviewerTools must include Bash for git log
  reviewerTools: 'Read,Edit,Grep,Glob,Bash',
}
```

## Session history summary

The Round 9 closeout session covered (in order):

1. Status check on running runs (Runs 11-17 complete, Run 18 finished during the session, Run 19 was running)
2. Honest project assessment — potential, structural limits, what to fix
3. Deep dive on the eval-personas silent bug (namespace collision between persona.group and prompt.group)
4. Discussion of train/eval/golden semantics and what each tier should actually do
5. Design session on the architecture: fresh-per-run train, in-batch holdout split, earned golden via Promoter-Agent
6. Reframing of the reviewer mechanism: don't reject fixes and loop, instead reject fixes and drop problematic prompts
7. Failing-prompts set as anti-examples — the elegant version that avoids endless loops
8. Writing both specs (Spec 1 + Spec 2) with self-review
9. Decision to stop Round 9 early (~20:10 CEST) to avoid wasted compute on contaminated data
10. Process cleanup — killing processes, archiving state, updating docs
11. Review of uncommitted pubmanager changes + three commits
12. Review of uncommitted mcp-evolve changes + three commits (including this handover doc)

Total session output: 2 design specs (~40KB), 1 closeout narrative (+8KB to actual.md), 1 updated handover, 1 new handover (this file), 6 commits, and a cleanly preserved Round 8/9 archive.

## Closing note

The Round 9 → Round 10 transition is structured to let you work without re-deriving context. Read this document, then actual.md, then the specs. If anything in the specs seems wrong or under-specified, discuss with the user before starting implementation — both specs were hand-reviewed but there may be edge cases that were missed.

Good luck with Round 10.
