# Round 9 — Handover Notes

**Written:** 2026-04-11 ~18:30 CEST (during Run 18)
**Purpose:** everything a new chat session needs to continue Round 9 and start Round 10 without re-deriving context.

## Current state (at handover)

### Runs 11-20 in progress
- **Runs 11-17 complete** — results in `actual.md`, summary table and detailed analysis
- **Run 18 running** at time of writing (started 18:14 CEST, at ~3/36 prompts last check)
- **Runs 19-20 queued** — bash loop `pubmanager/scripts/evolve-runs-11-to-20.sh` will continue automatically
- **Background task ID:** `bo3zlcaxq` in this session — new session won't have access to the streaming output, but the final results will be in `pubmanager/.mcp-evolve/logs/run-2026-04-11T*.json`
- **Expected completion:** ~21:00 CEST (3 runs × ~60min)

### What to do when runs finish

1. Extract Run 18-20 scores from `pubmanager/.mcp-evolve/logs/`:
   ```python
   python3 -c "
   import json, os
   for f in sorted(os.listdir('.mcp-evolve/logs/')):
     if f > 'run-2026-04-11T16':
       d = json.load(open(f'.mcp-evolve/logs/{f}'))
       s = d.get('scores',{}).get('all',{})
       sm = d.get('summary',{})
       cats = sm.get('errorsByCategory',{})
       print(f'{f}: {s.get(\"successRate\")}% / {sm.get(\"totalPrompts\")}p / {sm.get(\"totalErrors\")}e (s:{cats.get(\"server\",0)} m:{cats.get(\"model\",0)})')
   "
   ```
2. Update `docs/results-round-9-pubman/actual.md` with the final row in the summary table, trajectory charts, and Round 10 recommendations section finalized.
3. Mark Round 9 complete — move "in progress" → "COMPLETE" in title.

## Key files (read these first in a new session)

### Context & findings
- `mcp-evolve/docs/results-round-8-pubman/` — Round 8 (runs 1-10) results, predicted vs actual
- `mcp-evolve/docs/results-round-9-pubman/actual.md` — Round 9 current state, trajectory, fabricated-constraint incident, Round 10 recommendations
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

## Known open issues

### Must address in Round 10

1. **Fabricated constraint risk** — even with strengthened prompts, the fixer might still try to re-add the occupied-table guard or similar. Run 18-20 will reveal whether the new mandatory checklist works. If it fails, need an actual review agent (not just a prompt rule).

2. **Probe invariant contamination** — at least one probe (metamorphic invariant for Tisch 5) was generated during the guard era and is now a false positive. Others may exist. Need audit.

3. **Eval personas = 0 in every run** — waiter-payments, waiter-management, new-employee never actually ran. Probably config/filtering bug. Quick investigation needed.

4. **State pollution from write-tool prompts** — "seat guest at Tisch 5" runs 3× = 3 extra guests. User proposed optional `freshTrainEach` mode with 4 design options for graduation (see actual.md Recommendation 1). Needs brainstorm before implementation.

### Nice-to-have for Round 10

5. **Sonnet baseline** — run 10 iterations with sonnet as answerer to compare plateau behavior.
6. **Timings.jsonl analytics** — mine the structured log for per-tool/per-persona patterns.
7. **Polluted error messages cleanup** — tone down the `⛔ STOP` / `REQUIRED NEXT ACTION` shouty hints.
8. **Audit for other fabricated constraints** — grep pubman-mcp for similar patterns.

## What a new chat session should do first

```
1. Read docs/results-round-9-pubman/HANDOVER.md (this file)
2. Read docs/results-round-9-pubman/actual.md (full context)
3. Check if Runs 18-20 finished:
     grep "RUN [0-9]\+ \(COMPLETE\|FAILED\)" .mcp-evolve/run-11-to-20.log
4. If complete: extract scores, update actual.md with final results
5. If still running: wait or query pubmanager/.mcp-evolve/logs/
6. Then ask the user what Round 10 priorities should be
```

## Git state at handover

**mcp-evolve** (master branch):
```
4c9d66c docs(round-9): add Round 9 in-progress results for pubman (runs 11-17)
3f0cd7e feat(prompts): mandatory self-check before adding rejection logic
06b4e7f docs(learnings): add Round 9 addendum on compounding fabricated constraints
b6339c4 feat(prompts): forbid fabricated domain constraints in fixer
b258bcd feat: progress tracker, timings log, defensive metrics, round 8 results
78eed66 feat: init-seed, configurable timeouts/thresholds, legacy baseline compat
```

**pubmanager** (release/3.0.8 branch):
```
86a8e7f3 revert: remove occupied-table guard (2nd time)
6456dd14 revert: remove fabricated occupiedTableError guard from manage_guest
3a3813f6 feat: pubman-mcp improvements from mcp-evolve Round 8 (10 runs)
c4abc47a feat: mcp-evolve integration
```

pubmanager has uncommitted changes in `packages/pubman-mcp/src/tools/helpers.ts` and `read.ts` from ongoing Run 18 fixer activity — these should be reviewed when the run finishes.

## Background processes still running

- **bo3zlcaxq** in the current session — Runs 18-20 loop (will finish naturally)
- **PID 95265** — the top-level bash process for the loop (see `ps aux | grep evolve-runs-11-to-20`)
- The ollama model is running at localhost:11434
- The Firebase emulator is running at localhost:8080/5001/9099/9199
- The pubman-mcp dist/ is up to date (rebuilt after both reverts)

If you need to stop everything: `pkill -f "evolve-runs-11-to-20"` will kill the wrapper loop, but the currently-running node mcp-evolve process will finish its current run first.
