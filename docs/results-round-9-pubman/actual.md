# Round 9: Pubman MCP — Runs 11-18 (CLOSED, stopped early)

**Date:** 2026-04-11, 08:29 UTC start (10:29 CEST) — closed ~20:10 CEST
**Target:** pubman-mcp (local stdio, Firestore emulator)
**Config:** `pubmanager/evolve.config.mjs`
**Models:** `ollama:qwen3.5:35b-a3b-coding-nvfp4` (most), sonnet (fixer/reviewer/prefetch)
**Personas:** 9 (6 train, 3 eval — but eval-bucket silently broken, see closeout)
**Streak config:** escalation at 2, competition at 3, graduationStreak 3
**Starting state (from Round 8):** prompt-set with 20 train + 7 golden = 27 prompts
**Final state:** Runs 11-18 complete; Run 19 aborted mid-run; Run 20 skipped. Round stopped early to proceed with architectural redesign — see Closeout section at bottom.

Round 9 was the continuation of Round 8 against the same pubman MCP. Round 8 had established the first fixer commits, eliminated all server errors by Run 10, and identified the plateau around 45-50% success rate. Round 9's goals were (a) continuing the improvement-regression-improvement cycle, (b) discovering and remediating the fabricated-constraint anti-pattern, and (c) exercising the new progress tracker and timings log instrumentation. All three goals were met — the anti-pattern was discovered, documented, and the prompt hardening demonstrably held in Run 18. The round was then closed in favor of a structural redesign rather than continuing to produce noise against a broken scoring model.

---

## Summary Table (Runs 11-18, final)

| Run | Success | Action | All  | Train | Golden | Errors | Server | Model | Duration | Notes |
|-----|---------|--------|------|-------|--------|--------|--------|-------|----------|-------|
| 11  | 39.3%   | 83.3%  | 28   | 21    | 7      | 37     | 1      | 36    | 45.9 min | First run of Round 9 |
| 12  | 48.6%   | 90.0%  | 35   | 27    | 8      | 49     | 3      | 46    | 54.8 min | Escalation added prompts (+7) |
| 13  | 45.0%   | 75.0%  | 40   | 30    | 10     | 50     | 4      | 45    | 72.3 min | Escalation added more (+5) |
| 14  | 29.2%   | 77.3%  | 48   | 37    | 11     | 103    | 6      | 94    | 94.3 min | **Biggest regression** — escalation overwhelmed the local model |
| 15  | 27.3%   | 61.1%  | 44   | 33    | 11     | 79     | 2      | 76    | 85.1 min | Some prompts marked obsolete (-4) |
| 16  | 30.8%   | 81.3%  | 39   | 28    | 11     | 75     | **0**  | 75    | 49.0 min | **Zero server errors** (2nd time in the project) |
| 17  | 38.5%   | 66.7%  | 39   | 28    | 11     | 52     | 3      | 46    | 62.7 min | Recovery — despite the re-added fabricated guard still causing errors |
| 18  | **53.7%** | **76.5%** | 41 | 30   | 11     | 32     | 4      | 27    | 78.7 min | **Best run of Round 9.** Guard reverted (2nd time), hardened checklist held. Golden 90.9%, train 40%. 23/32 errors are contaminated probe-invariant violations (`harness:grading`), not real MCP bugs. |
| 19  | aborted | —      | 26/41 partial | — | — | — | — | — | ~36 min (partial) | Stopped mid-run (63% of prompts done) for architectural redesign |
| 20  | skipped | —      | —    | —     | —      | —      | —      | —     | —        | Skipped — round closed after Run 18 data confirmed hardening held |

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
Run 18: 54% ████████████████   ← NEW HIGH, post-revert + hardening
```

The pattern: steady improvement → large regression from escalation → slow recovery → breakthrough after the fabricated-guard revert and hardened checklist. Run 18 is the highest score of Round 9 and also matches Round 8's ceiling from a much cleaner state. The golden bucket hit 90.9% (10/11 passing), confirming that the main drag on earlier runs was the guard's feedback loop — not the underlying MCP.

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

## Run 18 final state (last completed run)

- **Prompt set:** 41 (30 train, 11 golden)
- **Eval personas still 0** — silent bug confirmed in follow-up investigation (see Closeout)
- **Fabricated guard:** reverted twice, prompt hardened, rebuilt dist — **held through Run 18**
- **Probe contamination:** confirmed active — 23 of 32 errors are `harness:grading` (probe-invariant violations), most of which are false positives from the pre-revert invariant generation era

### What Run 18 validated and invalidated

**Validated:**
1. **Multi-occupancy works correctly in the backend** — probe readings showed Tisch 5 going from 2 → 3 guests cleanly
2. **The strengthened fixer prompt holds** — no re-addition of the occupied-table guard across the full Run 18 fixer phase; the mandatory `grep`/`git log`/backend-read checklist blocked the regression
3. **Round 8's ceiling (45-50%) was artificially constrained** by the fabricated guard — with it removed, Run 18 hit 53.7% cleanly on a stable prompt set
4. **Golden set is robust** — 90.9% pass rate on the 11 golden prompts shows the promoted capabilities do genuinely work

**Invalidated / remaining known issues:**
1. Probe invariants from the guard era are still load-bearing and producing false positives — `harness:grading` error class dominates Run 18's 32-error tally
2. `scores.eval` is still 0 — root cause now understood (persona.group vs prompt.group conflation, see Closeout)
3. Shouty error messages in `helpers.ts` are still present but not causing failures anymore — backlog cleanup

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

---

## Closeout — Round 9 stopped early for architectural redesign

**Decision date:** 2026-04-11 ~20:10 CEST
**Decision context:** After Run 18 completed successfully (53.7% all / 90.9% golden, highest of the round) and while Run 19 was 63% through its prompt-running phase, Round 9 was stopped early. Run 19 was aborted mid-run, Run 20 was skipped entirely.

### Why stop early

1. **The round's goals were met.** Round 9 was about (a) continuing the improvement cycle, (b) discovering and remediating the fabricated-constraint anti-pattern, and (c) exercising the new progress tracker and timings log instrumentation. All three happened. Run 18 provided the clean data point needed to confirm the hardening worked. Runs 19-20 would have been noise-repetition, not new signal.
2. **Probe contamination makes further runs noisy.** 23 of 32 Run 18 errors were `harness:grading` — probe-invariant violations from the guard-era invariant generation that enshrined incorrect expectations as ground truth. Every additional run adds more noise against a stale scoring reference.
3. **No reviewer safety net yet.** Without the Reviewer Audit Upgrade (see specs below), each additional run carried fresh risk of the fixer re-fabricating constraints. With hardened prompts working but not bulletproof, stopping was safer than letting the loop run.
4. **Clean-slate migration will wipe everything anyway.** The Train/Eval/Golden Redesign (see specs below) discards all 25 persistent train prompts AND all 11 golden prompts in favor of starting fresh on a clean architecture. Any work Runs 19-20 would have produced would be immediately garbage-collected.
5. **Compute budget better spent on Sonnet baseline.** Round 10 includes a planned Sonnet-as-answerer baseline to separate "local-model plateau" from "architectural plateau". The ~3 hours Runs 19-20 would have consumed is a much better investment in that baseline.

### Key discoveries from the post-Run-18 investigation

After Run 18 finished and before stopping, a deeper architectural investigation surfaced several issues not visible from the run data alone. These shape Round 10's plan.

**1. `scores.eval` silently broken for 20+ runs.** The bug is a namespace conflict: personas have `group: 'train' | 'eval'` (hold-out intent) and prompts have `group: 'train' | 'golden'` (lifecycle). The scoring aggregation in `lib/run.mjs:1560` filters with `q.group === 'eval'`, which never matches any prompt because prompts only ever carry `train` or `golden`. Pubman's 3 eval-flagged personas (`waiter-payments`, `waiter-management`, `new-employee`) DO run — their 13 prompts live in the prompt-set as `group: "train"` — but they are pooled into the train bucket, and the eval bucket is always empty. The hold-out guarantee the design intended was never enforced. Round 10 fixes this via a two-field split: `lifecycle: train|golden` + `evaluation: fixer|holdout`.

**2. The fabricated-constraint anti-pattern is structural, not incidental.** The fixer is rewarded for making tests green; adding a guard that short-circuits a retry loop is the cheapest path to green. Sonnet fabricated the occupied-table guard twice, the second time explicitly writing *"likely wrong"* in a code comment while doing so. Abstract prompt rules cannot reliably override strong pattern-matching — only evidence-based concrete checks (grep, git log, backend read) can. This warrants a dedicated audit checkpoint between fixer and merge, which Round 10 implements by upgrading the reviewer.

**3. State pollution from persisted write-prompts is a design constraint, not a bug.** A "seat guest at Tisch 5" prompt running 10 times creates 10 extra guests. The emulator runs continuously. Over enough runs, prompt inputs reference an accumulating mess. The fix is to generate train prompts fresh each run from the current data state, and keep only golden prompts persistent.

**4. Probe invariants can be contaminated by incorrect MCP behavior.** If probes are generated while the MCP is wrong (e.g., with a fabricated guard active), the invariants encode the wrong behavior as ground truth. Once the MCP is corrected, those invariants become false-positive failures. Run 18 shows this directly: the Tisch 5 "must be empty" invariant, generated during the guard era, now flags the correct (multi-occupancy) backend behavior as a violation. A dedicated audit mechanism is needed — or, as Round 10 handles it, the reviewer dropping contaminated prompts from scoring naturally cleans the invariant set as a side effect.

### Architectural decisions — Round 10 plan

The discussion after Run 18 worked through the structural issues and produced two design specs, both written and committed to `mcp-evolve/docs/superpowers/specs/`:

**Spec 1 — Reviewer Audit Upgrade + Failing-Prompts Set**
Path: `mcp-evolve/docs/superpowers/specs/2026-04-11-reviewer-audit-upgrade-design.md`

The existing reviewer role (currently: merges parallel fixer diffs) is upgraded to "audit first, merge second". It gains a mandatory concrete checklist (`grep` for error text, `grep` for backend handler, read handler, `git log` for recent removals) that runs on any fixer diff adding a rejection path. It emits a structured `AUDIT` + `PROMPT_REVIEW` output with a two-orthogonal-decision case matrix: is the fix legit? is the prompt legit? Four possible outcomes (merge+keep, merge+drop, reject+keep, reject+drop).

Dropped prompts are persisted to a new `.mcp-evolve/failing-prompts.json` store with two entry kinds: per-prompt (from the regular fixer) and per-pattern (from the model-error fixer). The generator receives failing entries as **anti-examples** — the LLM handles semantic avoidance rather than mechanical filter. An optional `adversarial: boolean` field on prompts supports by-design-failing test cases so the reviewer can distinguish contamination from intentional failure.

The reviewer is the natural place for this because it already sees every diff before merge, runs via Claude Code CLI with Read/Grep/Edit tools (and now Bash, for git log), and is a single decision point. No new agent is added. The upgrade is Round-10 blocking — without it, further runs carry unmitigated fabrication risk.

**Spec 2 — Train / Eval / Golden Redesign**
Path: `mcp-evolve/docs/superpowers/specs/2026-04-11-train-eval-golden-redesign-design.md`

A structural redesign of how mcp-evolve organises its test sets. Key changes:

- **Two orthogonal fields on prompts** instead of one overloaded `group`: `lifecycle: train|golden` + `evaluation: fixer|holdout`. Personas lose their `group` field entirely.
- **Train and holdout are ephemeral per run.** Generated fresh every run against the current emulator state. Holdout is an in-batch split (K of N per persona, default K=1, N=3) so train and holdout come from the same distribution, enabling same-run overfitting detection.
- **Golden is the only persistent tier and the only source of cross-run comparability.** Graduation is no longer streak-based (the exact same prompt never runs twice in the new world) but instead handled by a new **Promoter-Agent** that nominates 0-3 passing train prompts per run based on capability coverage, pass quality, and distinctness from existing golden.
- **Pre/post-fix scoring on every tier.** Replay re-runs all prompts including holdout after the fixer applies changes, so same-run overfitting is detectable: `train_post - train_pre > threshold` AND `holdout_post - holdout_pre < -threshold` emits an `overfittingDetected` alarm.
- **Clean-slate migration.** All 25 existing train prompts and all 11 existing golden prompts are discarded. The `.mcp-evolve/prompt-set.json` is wiped (backup preserved) and starts empty on the next run. Rationale: the guard-era contamination makes the existing prompt set unreliable as a foundation.

Spec 2 depends on Spec 1 (uses the reviewer's case matrix, the adversarial flag, and the failing-prompts store). The implementation order is Spec 1 → Spec 2 → Round 10 runs.

### Round 10 sequencing

1. Implement Spec 1 (Reviewer Audit Upgrade + Failing-Prompts Set)
2. Implement Spec 2 (Train / Eval / Golden Redesign)
3. Execute the clean-slate migration (`node bin/cli.mjs migrate`)
4. Run Round 10 with:
   - `ollama:qwen3.5:35b-a3b-coding-nvfp4` as primary answerer (same as Round 9 for continuity)
   - 10 runs, track the new `train_pre/post`, `holdout_pre/post`, `golden_pre/post` metrics
   - Review the `failing-prompts.json` after each run to ensure the reviewer is catching what it should
5. After Round 10, run a separate 5-run Sonnet-as-answerer baseline for model comparison
6. Follow-up: MCP cleanup pass (shouty error messages, fabricated constraint audit) once the architecture has proven itself

### Deferred / explicitly out of scope for Round 10

- Shape-based graduation (classification by persona + intent + tool signature)
- Parametric prompt templates
- Auto-expiry of failing-prompts entries based on error-signature removal from source
- Semantic/embedding-based dedup
- Shared checklist fragment between reviewer and promoter (they are distinct enough to stay separate in V1)
- Hold-out golden (the empty fourth cell of the lifecycle × evaluation matrix)

### Archive / state preservation

Before any Round 10 work touches the emulator or the prompt set, the following was archived on 2026-04-11 ~20:12 CEST:

- `pubmanager/.mcp-evolve/prompt-set.json.round-9-final` — snapshot of the final prompt set (36 prompts: 25 train + 11 golden)
- `pubmanager/.mcp-evolve/archive/round-9/logs/` — full copy of all per-run JSON logs for Runs 1-18 (Round 8 + Round 9)
- `pubmanager/.mcp-evolve/archive/round-9/timings.jsonl` — event log from all instrumented runs
- `pubmanager/.mcp-evolve/archive/round-9/metrics.json` — the full metrics snapshot

These are the evidence base for any future re-analysis of Round 8/9 in light of lessons learned. The wipe done by Spec 2's migration step does not touch the archive.

---

*Round 9 closed 2026-04-11 ~20:10 CEST. See specs above for the full Round 10 plan.*
