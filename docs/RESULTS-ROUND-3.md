# Task Manager — Round 3 Results — Fixed Question Sets (25 runs)

Round 3 introduced a fundamentally different architecture: fixed question sets generated at init, with graduation and escalation-on-graduation. All models switched to Sonnet.

## Architecture Changes

1. **Fixed question sets**: `mcp-evolve init` generates N questions, validates all pass, saves as `question-set.json`. Runs replay the same questions — scores are directly comparable.
2. **Train/golden split**: 30% randomly promoted to golden at init. Golden questions act as a regression gate — fixes are rejected if they break golden.
3. **Graduation**: Train questions passing 10 consecutive times graduate to golden. Graduation triggers escalation to generate replacement train questions.
4. **Model-error filtering**: Grading errors classified as model behavior (counting, interpretation) skip the fixer. Only server-category errors dispatch the fixer.
5. **All Sonnet**: Every role (answerer, grader, fixer, escalator) uses Sonnet. Clean runs take ~1 minute.
6. **Parallel everything**: All questions answered simultaneously, not per-persona.

## Run-by-Run Results

| Run | All | Train | Golden | Questions | T/G | Duration | Key Events |
|-----|-----|-------|--------|-----------|-----|----------|------------|
| 1 | 95.2% | — | — | 21 | 14/6 | 3.4m | 1 counting error, fixed on replay |
| 2 | 100% | — | — | 20 | 14/6 | 58s | Clean |
| 3 | 90.9% | — | — | 22 | 14/6 | 6.6m | 2 model errors, fixer wasted ~5m (pre-filter) |
| 4 | 100% | — | — | 20 | 14/6 | 56s | Clean, model-error filter working |
| 5 | 100% | — | — | 20 | 14/6 | 81s | Clean |
| 6 | 100% | — | — | 20 | 14/6 | 4.8m | **Escalation #1** (streak=3) |
| 7 | 100% | — | — | 20 | 14/6 | 4.0m | **Escalation #2** (streak=4) |
| 8 | 96.0% | 94.7% | — | 25 | 19/6 | 80s | Escalation questions active, 1 model error |
| 9 | 85.2% | 81.0% | — | 27 | 19/6 | 8.0m | Server error: fixer + deep-fix both failed |
| 10 | 92.0% | 89.5% | — | 25 | 19/6 | 69s | 2 model errors |
| 11 | 96.0% | 94.7% | — | 25 | 19/6 | 63s | 1 model error |
| 12 | 92.3% | 90.0% | — | 26 | 19/6 | 3.1m | 1 server error, fixed on replay |
| 13 | 100% | 100% | — | 25 | 6/19 | 82s | **13 questions graduated to golden!** |
| 14 | 92.3% | 71.4% | — | 26 | 6/19 | 6.2m | 1 server error, fixed on replay |
| 15 | 96.0% | 83.3% | — | 25 | 6/19 | 75s | 1 model error |
| 16 | 96.0% | 83.3% | **100%** | 25 | 6/19 | 76s | Golden scores now visible |
| 17 | 100% | 100% | **100%** | 25 | 4/21 | 6.3m | **Graduated 2 → escalation generated 2 replacements** |
| 18 | 92.3% | 60.0% | **100%** | 26 | 5/21 | 4.3m | New escalation question, fixer fixed on replay |
| 19 | 92.0% | 50.0% | **100%** | 25 | 3/22 | 5.8m | **Graduated 1 → escalation generated 1 replacement** |
| 20 | 93.3% | 75.0% | **100%** | 30 | 8/22 | 92s | 2 model errors |
| 21 | 86.7% | 62.5% | 95.5% | 30 | 8/22 | 97s | Golden flaky (counting error) |
| 22 | 83.3% | 50.0% | 95.5% | 30 | 8/22 | 95s | Counting errors dominate |
| 23 | 93.3% | 87.5% | 95.5% | 30 | 8/22 | 2.4m | Counting error on golden too |
| 24 | **16.7%** | 0.0% | 22.7% | 30 | 8/22 | 64s | **Harness failure** (auth expiry) |
| 25 | 93.3% | 75.0% | **100%** | 30 | 8/22 | 112s | Recovered |

## Key Findings

### What Worked

1. **Comparable scores.** Runs 1-7 all tested the same 20 questions. Score changes reflect real server/model behavior, not question variance.
2. **Speed.** Clean runs: ~1 minute (was ~4-10 min with fresh generation). 25 questions answered in parallel.
3. **Golden as regression gate.** 100% golden across runs 16-20, never broken by fixes. One golden question became flaky in runs 21-23 (counting error — model issue, not regression).
4. **Graduation works.** Run 13 graduated 13 questions at once. Runs 17 and 19 triggered graduation-escalation, replacing graduated questions with new ones.
5. **Model-error filter saves time.** Counting/interpretation errors skip the fixer (~5 min saved per run with model errors). Only server bugs get fixer attention.
6. **Fixer makes real improvements.** Run 9's fixer added `isOverdue` field and completed-task warnings — useful even though the specific question wasn't fixed.

### What Didn't Work

1. **Planted bugs not found.** The 3 planted bugs (title-only search, missing completedAt, silent delete) were never caught across 25 runs. Init validation creates questions that pass the buggy server, so bugs producing plausible-looking wrong answers are invisible.
2. **Escalation generates workflow complexity, not correctness probes.** The escalator found edge cases (task disambiguation, acknowledging no-ops) but never generated questions that cross-check tool outputs against their descriptions.
3. **Counting errors are the dominant failure mode.** The LLM consistently miscounts items in lists. This is a model limitation — the server returns correct data, the LLM just can't count it. The model-error filter correctly avoids wasting fixer time on these.

### Escalator Prompt Evolution

The escalator prompt went through 3 versions during Round 3:
1. **Original "harder workflows"** — generated complex multi-step questions that tested the LLM more than the server
2. **"Correctness probes"** — instructed to verify tools do what descriptions claim (committed but never tested)
3. **"Diverse natural questions"** (final) — simplified to just be a persona generating random questions with full system context. The theory: volume + diversity + time will find every bug, same as Round 1/2 did with fresh questions per run.

## Round 3 vs Round 1 & 2

| Metric | Round 1 (35 runs) | Round 2 (15 runs) | Round 3 (25 runs) |
|--------|-------------------|-------------------|-------------------|
| Model | Opus | Opus | Sonnet |
| Question generation | Fresh per run | Fresh per run | Fixed set + escalation |
| Scores comparable? | No | No | **Yes** |
| Clean run duration | ~4 min | ~4 min | **~1 min** |
| All bugs found? | Partial (2/3) | **All 3 by Run 2** | **None** |
| Escalation trigger | 3x 100% streak | 3x 100% streak | Graduation + streak |
| Graduation | N/A | N/A | 10 consecutive passes |
| Dominant failure | Server bugs | Server bugs | **Model counting** |

## Bottom Line

Fixed question sets solve the comparability problem and dramatically improve speed. Graduation-triggered escalation keeps the train set fresh. Golden regression gating works.

But the architecture has a blind spot: **init validation filters out questions that would expose bugs producing plausible wrong answers.** The system needs a mechanism to test tool correctness — not just workflow completion — that doesn't rely on the answerer getting the right result on the first try.

The planted bugs were found in Rounds 1/2 by accident: fresh random questions + volume eventually hit the right patterns. Round 3's fixed-set approach trades that discovery power for comparability and speed. The escalator is meant to recover that discovery power, but needs more runs (or a correctness-probing mode) to match the old approach's coverage.
