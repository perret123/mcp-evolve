# Round 9: Pubman MCP — Runs 11-20 (in progress)

**Date:** 2026-04-11, 08:29 UTC start (10:29 CEST)
**Target:** pubman-mcp (local stdio, Firestore emulator)
**Config:** `pubmanager/evolve.config.mjs`
**Models:** `ollama:qwen3.5:35b-a3b-coding-nvfp4` (most), sonnet (fixer/reviewer/prefetch)
**Personas:** 9 (6 train, 3 eval)
**Streak config:** escalation at 2, competition at 3, graduationStreak 3
**Starting state (from Round 8):** prompt-set with 20 train + 7 golden = 27 prompts

Round 9 is the continuation of Round 8 against the same pubman MCP. Round 8 established the first fixer commits, eliminated all server errors by Run 10, and identified the plateau around 45-50% success rate. Round 9 is about (a) continuing the improvement-regression-improvement cycle, (b) discovering and remediating the fabricated-constraint anti-pattern, and (c) exercising the new progress tracker and timings log instrumentation.

---

## Summary Table (Runs 11-17)

| Run | Success | Action | All  | Train | Golden | Errors | Server | Model | Duration | Notes |
|-----|---------|--------|------|-------|--------|--------|--------|-------|----------|-------|
| 11  | 39.3%   | 83.3%  | 28   | 21    | 7      | 37     | 1      | 36    | 45.9 min | First run of Round 9 |
| 12  | 48.6%   | 90.0%  | 35   | 27    | 8      | 49     | 3      | 46    | 54.8 min | Escalation added prompts (+7) |
| 13  | 45.0%   | 75.0%  | 40   | 30    | 10     | 50     | 4      | 45    | 72.3 min | Escalation added more (+5) |
| 14  | 29.2%   | 77.3%  | 48   | 37    | 11     | 103    | 6      | 94    | 94.3 min | **Biggest regression** — escalation overwhelmed the local model |
| 15  | 27.3%   | 61.1%  | 44   | 33    | 11     | 79     | 2      | 76    | 85.1 min | Some prompts marked obsolete (-4) |
| 16  | 30.8%   | 81.3%  | 39   | 28    | 11     | 75     | **0**  | 75    | 49.0 min | **Zero server errors** (2nd time in the project) |
| 17  | 38.5%   | 66.7%  | 39   | 28    | 11     | 52     | 3      | 46    | 62.7 min | Recovery — despite the re-added fabricated guard still causing errors |
| 18  | (running) | —   | 36   | 25    | 11     | —      | —      | —     | —        | Guard reverted; invariant-contamination surfaced |
| 19  | (TBD)   | —      | —    | —     | —      | —      | —      | —     | —        | |
| 20  | (TBD)   | —      | —    | —     | —      | —      | —      | —     | —        | |

---

## The main incident: fabricated-constraint iteration

Round 9's most important finding was not a metric — it was a **process failure in the fixer** that took two iterations to remediate, and exposed a **structural tension** in the whole approach.

### Timeline

1. **Round 8, Runs 1-10** — the fixer added an `occupiedTableError` helper to `packages/pubman-mcp/src/tools/write.ts` (a helper + 4 call sites) that rejected every attempt to seat a new walk-in at a table with ANY existing guest. The helper was unambiguous: *"⛔ Table X is already occupied (N guest(s) seated). Cannot seat a new walk-in at an occupied table"*.

2. **Between Round 8 and Round 9** — the user reviewed the Round 8 changes and flagged that the constraint is WRONG. In the real pubman system, tables have multiple seats and multi-occupancy is supported up to seat capacity. The guard invented a business rule that doesn't exist.

3. **Round 9 starts** — the guard is still in place from Round 8. The fixer sees "table already occupied" errors in its Run 11 inputs and assumes the constraint is correct. It reinforces the error text to be more emphatic: *"Calling this tool again with X will ALWAYS fail — do not retry with this table name"*.

4. **Mid Run 16** — the user (I) manually reverted the guard: removed the helper function, removed all 4 call sites, rebuilt `dist/`, appended a note to the run log. The fixer prompt (`prompts/fixer.md` and `prompts/fixer-model-error.md`) was also updated with an abstract "NEVER fabricate domain constraints" rule.

5. **Run 16's model-error-fixer phase** — still running when the revert happened. It saw 23 errors containing "table already occupied" in its input. It read the (newly reverted) `write.ts` and noticed there was no occupancy check. It concluded: *"Obvious pattern — the errors reference occupancy and the code doesn't check for it; I should add a check"*. It **re-added the guard, this time inlined**, with a comment *"Occupancy check for walk-ins: seating a new party at an already-occupied table is **likely wrong**"* — explicitly uncertain, but the abstract prompt rule didn't stop it.

6. **Run 17** — runs against the re-added guard. Shows 10 `already occupied` errors again, despite being **AFTER** the revert.

7. **Between Run 17 and 18** — I reverted again, this time hardening the prompt with a **mandatory concrete checklist**:
   - `grep` the source for the error text you're about to write — if it exists, the guard is already there
   - Locate the backend handler and verify the backend actually rejects the condition
   - Check `git log --oneline -10 <file>` for recent commits that REMOVED the same guard
   - Re-read input errors with the hypothesis that they might be self-generated

8. **Run 18** — runs against the now-reverted code with the strengthened prompt. The grader's probe invariant shows *"Before: 2 guests at Tisch 5. After: 3 guests at Tisch 5"* — the backend successfully seated a third guest. **Multi-occupancy works**, confirming the guard was always wrong.

### Why the first prompt rule failed

The first version of `prompts/fixer.md`'s anti-fabrication rule was too abstract:

> "Do NOT fabricate domain constraints. Before adding any check that rejects an input, verify: (1) is the constraint actually enforced by the backend? (2) could the input be legitimate in a scenario you haven't considered? (3) are you reinterpreting an error?"

Sonnet read this and **still added the guard**, explicitly acknowledging its own uncertainty in a code comment (*"likely wrong"*). The reason: sonnet's pattern-matching saw 23 errors referencing `⛔ Table X is already occupied` and concluded they represented real backend failures. It never performed check (3) — "are you reinterpreting an error?" — because it didn't know it was reinterpreting anything; it thought it was handling a real failure mode.

**Abstract rules don't counteract strong pattern-matches.** The fix is concrete, mandatory, action-oriented checks:

> 1. grep the source for the error text you're about to write
> 2. find the backend handler and read it
> 3. check git log for recent removals

These are commands sonnet can actually execute, and they close the inference gap that allowed the fabrication.

### The circular-error trap

The deeper insight is that fabricated constraints create **a self-reinforcing feedback loop**:

```
1. Fixer adds "X is already occupied" error
2. Next run sees LLM retry attempts against the guard → errors logged
3. Next fixer sees the errors, assumes they're legitimate, reinforces the guard
4. Loop tightens: error text becomes more insistent, prompt set gets more prompts that trigger it
```

Each iteration makes the guard harder to remove by making the evidence for it look stronger. Left unchecked, within a few runs the "constraint" becomes load-bearing in the prompt set (escalated prompts work around it), the golden set (prompts that pass rely on it), and the fixer's mental model (it's been there so long it must be right).

**The lesson for mcp-evolve architecture:** the fixer's incentive structure (make tests green) is **structurally in tension** with correctness. Every guard that stops an LLM retry loop scores higher than a messier but truthful failure. Prompt rules can raise the bar, but they can't reliably overcome this incentive.

### The probe contamination side effect

As a secondary effect, **the probes themselves got polluted** by the fabricated guard. Run 18 shows:

> "Metamorphic invariant violated: The invariant requires Tisch 5 to be empty before the action, but probe data shows it had 2 guests before seating the new party. Before: 2 guests at Tisch 5. After: 3 guests at Tisch 5."

The probe was originally generated during a run where the guard was active, so it established the invariant "Tisch 5 empty before an action that seats a walk-in". Now that the guard is gone and multi-occupancy works, the probe's invariant is **false** — but the grader is still enforcing it. The LLM did the right thing (seat a third guest at Tisch 5), the backend accepted it, and the grader still flagged it as a failure.

This means **probe invariants need a freshness or correctness audit** whenever the MCP's behavior changes. Simply generating probes from runs and treating them as ground truth assumes the MCP is already correct — which is the very thing mcp-evolve is supposed to verify.

---

## Key trajectory observations

### Success rate over Round 9

```
Run 11: 39% ████████████
Run 12: 49% ███████████████   ← improving
Run 13: 45% █████████████
Run 14: 29% █████████          ← escalation regression
Run 15: 27% ████████           ← still regressed
Run 16: 31% █████████          ← partial recovery (0 server errors!)
Run 17: 39% ████████████       ← recovered to Run 11 level
```

The pattern: steady improvement → large regression from escalation → slow recovery. This is the intended behavior; Round 8 showed the same shape.

### Prompt set evolution

```
Run 11: 28 prompts (21 train + 7 golden)
Run 14: 48 prompts (37 train + 11 golden)   ← +20 in 3 runs from escalation
Run 17: 39 prompts (28 train + 11 golden)   ← some marked obsolete
Run 18: 36 prompts (25 train + 11 golden)
```

Escalation added ~20 prompts over Runs 12-14. Then obsolete-marking removed ~12 over Runs 15-18. The system is self-pruning.

### Error trend

```
Run 11:  37 errors
Run 14: 103 errors   ← escalation shock
Run 17:  52 errors   ← recovery
```

The 103-error spike in Run 14 corresponds exactly to the escalation-driven prompt-set growth. The fixer caught up by Run 17.

### Server errors

```
Run 11: 1
Run 12: 3
Run 13: 4
Run 14: 6
Run 15: 2
Run 16: 0   ← perfect run on the backend side
Run 17: 3
```

Run 16's zero is the second all-clean run in the project (Run 10 was the first). The Run 17 uptick was from the re-added fabricated guard producing server errors via its `isError: true` paths.

---

## Infrastructure improvements during Round 9

Round 9 surfaced and fixed multiple mcp-evolve harness issues:

1. **`metrics.json` shape bugs** — `escalations.history` and `fixes.history` crashes when the file was partially initialized (Round 9's Runs 4-7 all crashed on these). Fixed with defensive `|| []` fallbacks in `lib/metrics.mjs`.

2. **Timings log** — added `lib/timings.mjs` (append-only JSONL, schema-versioned, POSIX atomic) + `lib/progress.mjs` (timeout-based initial ETA, rolling-average refined ETA, per-run and across-run context). Instrumented all phases in `lib/run.mjs`: `seed`, `healthcheck`, `prefetch`, `generation`, `prompts_run`, `fix_batch`, `reviewer`, `replay`, `deep_fix`, `model_error_fix`, `escalate`, `compete`, `autodev`, `metrics_update`.

3. **CLI multi-run flags** — `--current-run N --total-runs M` for cross-run progress display. The progress bar now shows `Run 17/20 | [████░░░] 14/36 (38%) | elapsed 23m | ETA 4h02m | avg 1m04s/prompt`.

4. **Fixer prompt hardening** — `prompts/fixer.md` and `prompts/fixer-model-error.md` now include the mandatory grep/git/backend-check checklist.

5. **Learnings doc** — `docs/learnings/fixer-fabricated-constraints.md` is the permanent record of the anti-pattern, with two addendums covering the compounding iteration and the stronger rule.

---

## Prediction vs Reality (Round 9)

### Where Round 8's prediction still holds

| Round 8 prediction | Round 9 actual |
|---|---|
| Fixer finds real bugs | ✅ Continued — more tool description improvements |
| Errors drop within a difficulty level | ✅ Run 14 → 17: 103 → 52 (−49%) |
| Escalation triggers when streak hits threshold | ✅ Escalation fired multiple times across Runs 11-17 |
| Run-over-run speed improvements | ⚠️ Duration grew until prompt set stabilized |
| Plateau around 45-50% with local model | ✅ Peaks at 48.6% (Run 12), recovers to 38.5% (Run 17) |

### What Round 9 revealed that Round 8 missed

1. **Fabricated constraints compound over runs** — not a single-run issue; each iteration hardens the wrong assumption
2. **Abstract prompt rules don't defeat strong pattern-matches** — concrete grep/git checklists work better
3. **Probes get polluted** by incorrect MCP behavior, becoming load-bearing for wrong assumptions
4. **The fixer's incentive structure is structurally misaligned** with correctness — the tests-green signal can actively reward fabrication

These are **structural findings about mcp-evolve itself**, not about pubman. They suggest mcp-evolve needs a dedicated review step — an agent whose job is specifically to audit new rejection logic against the backend, not to make tests green.

---

## Status as of Run 18 start

- **Prompt set:** 36 (25 train, 11 golden)
- **Eval personas still 0** — same issue as Round 8, not yet investigated
- **Fabricated guard:** reverted twice, prompt hardened, rebuilt dist
- **Probe contamination:** known, not yet remediated (would need to regenerate invariants or mark polluted probes obsolete)
- **Runs remaining:** 18, 19, 20 (~4 hours ETA)

### Expected behavior for Runs 18-20

1. **First prompt in Run 18 already showed multi-occupancy working** — backend accepted going from 2 → 3 guests at Tisch 5
2. **Probe invariants will throw false-positive failures** until they're regenerated — expect some `metamorphic invariant violated` grades that are actually correct behavior
3. **If the strengthened prompt works** the fixer should not re-add the occupied-table guard
4. **Model error count may rise** temporarily because the polluted probes will count LLM correctness as failures

---

## Recommended next steps (for Round 10)

### Architectural

1. **Optional fresh-train mode** — new config `freshTrainEach: boolean` + CLI `--fresh-train`. When enabled, discards persisted train prompts at the start of each run and regenerates them via the prompt LLM. Rationale: train prompts with write-tool side effects pollute state across runs (a "seat guest at Tisch 5" prompt running 10 times creates 10 guests). Fresh train each run prevents this accumulation.

   **Design question (must be resolved before implementation): how does graduation work?**

   The current graduation mechanism is based on `consecutivePasses >= graduationStreak` — the exact same prompt must pass N runs in a row. With fresh-train, the exact same prompt never runs twice, so this mechanism breaks. Four possible resolutions, none obviously correct:

   - **(a) First-pass promotion.** Any fresh train prompt that scores 100% on its single run graduates immediately to golden. Pro: simple, no history tracking. Con: one lucky pass isn't reliability evidence; golden gets polluted with easy prompts. Mitigation: require multiple graders or a second run to confirm.

   - **(b) Prompt-template grouping.** Instead of exact-match, group prompts by their "shape" (persona + intent tag + tool-coverage signature) and track passes across the group. If 3 prompts of the "seat-walk-in" shape pass across 3 runs, promote a representative to golden. Pro: matches user intent (test the capability, not the exact phrasing). Con: requires classification infrastructure; hard to define "shape" mechanically.

   - **(c) Explicit promotion in the run.** The answerer or grader marks prompts it considered notable, and those get promoted. Or a new "promoter" role reviews the run's passing prompts and picks a handful to add to golden. Pro: intentional curation. Con: more LLM calls per run; promotion becomes subjective.

   - **(d) Hybrid: keep persisting prompts, but regenerate only the ones that created state.** Mark prompts with write-tool intent as "ephemeral"; they run once and are discarded. Read-only prompts persist and graduate normally. Pro: surgical fix for the actual pain point (state pollution is only from writes). Con: requires classifying prompts by intent; read prompts still repeat identically across runs which has its own staleness issues.

   **Recommendation for Round 10:** start with (d) — it's the most conservative change and targets the actual problem. Add an `ephemeral: boolean` field to prompts in `prompt-set.json`; set to true for prompts that call write tools (detected via heuristic: prompt text contains imperative verbs, OR answerer's first attempt calls a write tool, OR a config list like `ephemeralIntents: ['seat', 'order', 'pay', 'move']`). At the start of each run, filter out `ephemeral && consecutivePasses > 0` prompts and regenerate fresh ones for that persona. Read-only prompts keep the existing graduation flow.

   If (d) proves insufficient, escalate to (a) or (b). Skip (c) unless the user explicitly wants curation in the loop.

   Implementation sketch: after `loadPromptSet`, filter `promptSet.prompts` to keep only `q.group === 'golden'` and non-ephemeral train prompts that haven't yet scored, then call `generatePrompts` per persona and `addTrainPrompts` to fill the gap. Can be run-level (CLI flag) or config-level (default off).

2. **Add a review step** to the fixer pipeline — a dedicated agent whose job is to audit rejection logic against the backend before merging fixer branches. The Round 9 fabricated-constraint incident shows that prompt rules alone don't counteract the fixer's incentive structure. A separate agent with different incentives (correctness audit, not tests-green) could catch fabrications before they land.

3. **Audit probe invariants** — scan `.mcp-evolve/prompt-set.json` for probes that reference behavior that changed, mark obsolete or regenerate. Round 9's "Tisch 5 should be empty" invariant is the canonical example: it was generated during a run where the fabricated guard was active, so the invariant assumed tables are always empty before seating. Once the guard was removed, the invariant became a false positive. A periodic audit (or a run-level `--regenerate-probes` flag) would keep invariants fresh.

### Investigation

4. **Investigate eval personas** — they show 0 in every run across both Round 8 and Round 9. Something is filtering them out; probably a config issue in how eval personas are loaded, or a silent exclusion in the prompt-set filtering logic. Quick win.

5. **Baseline with sonnet as answerer** for one 10-run cycle. Would show whether the 45-50% plateau is inherent to the local qwen3.5:35b model or also affects frontier models. Expensive but informative.

6. **Mine `.mcp-evolve/timings.jsonl`** for per-tool and per-persona timing patterns. The Round 9 instrumentation captures phase_start/phase_end for every stage including individual prompts and tool calls. Likely questions answerable from the data: "which tool is slowest on average?", "which persona's prompts take longest?", "how much of a run is spent in fixer vs prompts vs prefetch?".

### Cleanup

7. **Clean up polluted error messages** in `packages/pubman-mcp/src/tools/helpers.ts`. Round 8/9 fixer iterations added many aggressive hints (`⛔ STOP`, `REQUIRED NEXT ACTION`, `NEVER retry`). Some are useful; others are shouty and may actively harm the LLM's ability to reason. Worth a pass to tone down the ones that don't add information.

8. **Audit for other fabricated constraints** — now that the occupied-table case is known, grep pubman-mcp for similar patterns: `isError: true` with hardcoded domain-specific messages, `Cannot X` / `already Y` strings. Each one is a candidate for the same investigation (does the backend actually enforce this?).

---

*This document will be updated as Runs 18, 19, and 20 complete.*
