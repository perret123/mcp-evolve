# Round 9 — Handover Notes (CLOSED)

**Originally written:** 2026-04-11 ~18:30 CEST (during Run 18)
**Updated:** 2026-04-11 ~20:15 CEST (closeout)
**Status:** Round 9 closed. Runs 11-18 complete. Run 19 aborted mid-run. Run 20 skipped. See `actual.md` Closeout section for full rationale.

## Current state

### Final run summary
- **Runs 11-18 complete** — all scored, analysed, documented in `actual.md`
- **Run 19 aborted** at 63% through its prompt-running phase (26/41 prompts graded, no fixer/scoring/log)
- **Run 20 skipped** entirely
- **No background processes** — wrapper (`evolve-runs-11-to-20.sh`) and node runner killed ~20:10 CEST
- **Highest score:** Run 18 at 53.7% all / 90.9% golden — the clean post-revert baseline

### Why stopped early
The round's goals (discover + remediate the fabricated-constraint anti-pattern, exercise new instrumentation, produce actionable Round 10 plan) were met. Run 18 provided the clean data point confirming the hardened fixer prompt held. Running 19 and 20 would have produced noise against a stale scoring reference (23 of 32 Run 18 errors were contaminated probe-invariant violations). Round 10 requires architectural changes first — see specs below.

## Key files (read these first in a new session)

### Round 10 design specs (NEW — written 2026-04-11 during closeout)
- `mcp-evolve/docs/superpowers/specs/2026-04-11-reviewer-audit-upgrade-design.md` — Spec 1: upgrade existing reviewer to audit-first-merge-second, add failing-prompts store, anti-example generator feed, adversarial flag support. **Round-10 blocking.**
- `mcp-evolve/docs/superpowers/specs/2026-04-11-train-eval-golden-redesign-design.md` — Spec 2: two orthogonal fields (lifecycle + evaluation), ephemeral train+holdout, promoter-agent graduation, clean-slate migration. Depends on Spec 1.

### Context & findings
- `mcp-evolve/docs/results-round-8-pubman/` — Round 8 (runs 1-10) results, predicted vs actual
- `mcp-evolve/docs/results-round-9-pubman/actual.md` — Round 9 final state, trajectory, fabricated-constraint incident, full closeout with Round 10 plan
- `mcp-evolve/docs/learnings/fixer-fabricated-constraints.md` — the anti-pattern doc with 2 addendums, circular-error trap explanation
- `mcp-evolve/CLAUDE.md` — mcp-evolve architecture overview

### Current code state
- `mcp-evolve/prompts/fixer.md` — hardened with mandatory grep/git/backend-check checklist (should prevent re-fabrication)
- `mcp-evolve/prompts/fixer-model-error.md` — same hardening for model-error pattern detection
- `mcp-evolve/lib/progress.mjs` — ETA tracker (uses timings.jsonl for refinement)
- `mcp-evolve/lib/timings.mjs` — append-only JSONL log with query API
- `mcp-evolve/lib/init-seed.mjs` — `--init-seed` command
- `mcp-evolve/lib/run.mjs` — instrumented with phase tracking throughout
- `mcp-evolve/bin/cli.mjs` — CLI flags `--current-run`, `--total-runs`, `--init-seed`, `--mcp-discovery`

### Pubman config & scripts
- `pubmanager/evolve.config.mjs` — 9 personas, aggressive settings (streakThreshold:2, competitionStreakMultiplier:1.5, graduationStreak:3, modelErrorThreshold:2), all models configurable, mostly local (ollama:qwen3.5:35b)
- `pubmanager/scripts/extract-emulator-state.mjs` — standalone Firestore extractor (no LLM, no deps)
- `pubmanager/scripts/evolve-runs-4-to-10.sh` — Round 8 wrapper (already done)
- `pubmanager/scripts/evolve-runs-11-to-20.sh` — Round 9 wrapper (currently running)
- `pubmanager/.mcp-evolve/prompt-set.json` — current persisted prompt set (~36 prompts, 11 golden)
- `pubmanager/.mcp-evolve/timings.jsonl` — event log from all Round 9 runs
- `pubmanager/.mcp-evolve/logs/run-*.json` — per-run score snapshots

## Session-specific decisions (DO NOT re-litigate)

These were decided in this session. A new session should honor them, not question them.

1. **Use `ollama:qwen3.5:35b-a3b-coding-nvfp4` as primary model**, sonnet only for fixer/reviewer/prefetch/prompt-gen. Reason: user's Claude subscription was maxed out; local model is sufficient to find structural bugs, even if it plateaus at lower success rates.

2. **No seed/reset hook** — emulator runs continuously, obsolete-marking handles stale prompts. The original `seed` hook referenced `emulators/test-seed/` which doesn't exist.

3. **admin-1@tester.com as dev user** — UID `kTVrH4qQsnY36ZXOttWG0taZ3qSJ`, pre-wired in `pubmanager/mcp-evolve.json` as `MCP_DEV_UID`.

4. **The occupied-table guard is FABRICATED** — user confirmed pubman supports multi-occupancy. Do NOT re-add it. Run 18 at start showed the backend successfully seating 3 guests at Tisch 5 (before: 2, after: 3).

5. **metrics.json shape** — escalations/fixes/competitions now have defensive `|| []` fallbacks. Do NOT remove these.

6. **Aggressive Round 9 config** (streakThreshold=2, competitionStreakMultiplier=1.5, graduationStreak=3) — user wants faster feedback loops. Don't reset to defaults.

## Known open issues — status after closeout

### Resolved by design (covered in specs)

1. **Fabricated constraint risk** → Spec 1 (Reviewer Audit Upgrade). The hardened fixer prompt held in Run 18, but prompts alone are not enough — Spec 1 adds an evidence-based audit checkpoint between fixer and merge that can reject diffs with concrete backend-check evidence.

2. **Probe invariant contamination** → resolved as a side effect of Spec 1. When a contaminated invariant triggers a fix attempt, the reviewer's case matrix can drop the prompt (and its invariant) from scoring and push it to the failing-prompts store. No separate regeneration mechanism needed in V1.

3. **Eval personas = 0 in every run** → root cause identified (persona.group vs prompt.group namespace collision). Spec 2 resolves by introducing two orthogonal fields: `lifecycle: train|golden` + `evaluation: fixer|holdout`. Personas lose their `group` field entirely.

4. **State pollution from write-tool prompts** → Spec 2 resolves by making train and holdout ephemeral per run. The design question about graduation mechanics (4 options in original actual.md Recommendation 1) was resolved in favor of a new Promoter-Agent (option a from the discussion).

### Scheduled for Round 10 (not spec-covered, but planned)

5. **Sonnet baseline** — 5 runs with sonnet as answerer, separate log ablage. After the main Round 10 qwen runs complete.
6. **Timings.jsonl analytics** — low-priority analysis, pulls data from existing archive.

### Deferred to backlog (after Round 10 stabilises)

7. **Polluted error messages cleanup** — tone down `⛔ STOP` / `REQUIRED NEXT ACTION` in `packages/pubman-mcp/src/tools/helpers.ts`. Not blocking anything, just noise.
8. **Audit for other fabricated constraints** — grep pubman-mcp for `isError: true` + hardcoded domain messages. Each hit is a candidate for "does the backend actually enforce this?" investigation.
9. **Auto-expiry of failing-prompts entries** when the triggering error signature no longer appears in MCP source. V2 if the failing-prompts store grows unmanageable.

## What a new chat session should do first

```
1. Read docs/results-round-9-pubman/HANDOVER.md (this file) — Round 9 status & context
2. Read docs/results-round-9-pubman/actual.md (full round narrative including Closeout section)
3. Read docs/superpowers/specs/2026-04-11-reviewer-audit-upgrade-design.md (Spec 1)
4. Read docs/superpowers/specs/2026-04-11-train-eval-golden-redesign-design.md (Spec 2)
5. Ask the user: proceed with Spec 1 implementation (writing-plans skill), or discuss specs first?
```

Round 10 starts only after Spec 1 is implemented and verified. Do NOT start a new run loop before the reviewer upgrade is in place — fabrication risk is unmitigated without it.

## Git state at closeout

**mcp-evolve** (master branch) — same as mid-run handover, plus the two new specs in `docs/superpowers/specs/`:
```
4c9d66c docs(round-9): add Round 9 in-progress results for pubman (runs 11-17)
3f0cd7e feat(prompts): mandatory self-check before adding rejection logic
06b4e7f docs(learnings): add Round 9 addendum on compounding fabricated constraints
b6339c4 feat(prompts): forbid fabricated domain constraints in fixer
```
Uncommitted at closeout:
- `docs/results-round-9-pubman/actual.md` (Closeout section added, Run 18 data)
- `docs/results-round-9-pubman/HANDOVER.md` (this file, closeout update)
- `docs/superpowers/specs/2026-04-11-reviewer-audit-upgrade-design.md` (NEW)
- `docs/superpowers/specs/2026-04-11-train-eval-golden-redesign-design.md` (NEW)

**pubmanager** (release/3.0.8 branch):
```
86a8e7f3 revert: remove occupied-table guard (2nd time)
6456dd14 revert: remove fabricated occupiedTableError guard from manage_guest
3a3813f6 feat: pubman-mcp improvements from mcp-evolve Round 8 (10 runs)
c4abc47a feat: mcp-evolve integration
```
Uncommitted at closeout: any changes in `packages/pubman-mcp/src/tools/helpers.ts` and `read.ts` that accumulated during Runs 11-18 but were never committed. Review and decide whether to keep, amend, or revert before starting Round 10 implementation.

## Background processes — all stopped

Runtime services that were running during Round 9 and should still be available (but verify before Round 10):
- ollama at localhost:11434 (may need restart)
- Firebase emulator at localhost:8080/5001/9099/9199 (keep running across sessions is fine)
- pubman-mcp `dist/` rebuilt after both reverts (re-verify before Round 10)

Stopped at closeout (~20:10 CEST):
- Wrapper loop `evolve-runs-11-to-20.sh` (was PID 95278)
- Node runner for Run 19 (was PID 97293, `--current-run 19 --total-runs 20`)
- Parent zsh wrapper (was PID 95265)

## Archive locations

Everything from Round 8+9 is preserved under `pubmanager/.mcp-evolve/archive/round-9/`:
- `archive/round-9/logs/` — all per-run JSON logs (Runs 1-18)
- `archive/round-9/timings.jsonl` — full event log
- `archive/round-9/metrics.json` — metrics snapshot
- `pubmanager/.mcp-evolve/prompt-set.json.round-9-final` — final prompt set (36 entries: 25 train + 11 golden)

Spec 2's clean-slate migration will wipe the live `prompt-set.json` but leave the archive untouched.
