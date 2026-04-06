# Task Manager — Round 2 Results

15 runs of mcp-evolve against the task-manager MCP server, reset to its original buggy state (3 planted bugs, sloppy descriptions). Unlike Round 1 (where the harness itself was being built), Round 2 uses the fully mature mcp-evolve harness from day one.

The first 6 runs documented the fast-convergence phase. Runs 7-15, added in the addendum below, show what happened once escalation, blocked golden questions, and late harness failures entered the picture.

## Key Difference from Round 1

Round 1 took 35 runs and evolved both the harness and the server simultaneously. Round 2 starts with all harness improvements in place: LLM grading (Sonnet, no truncation), parallel fixers in git worktrees, Claude-driven merge, name-only answerer context, relative dates in escalation, replay always runs.

**Result: Round 2 fixed all 3 planted bugs by Run 2 and hit first 100% by Run 3 — versus Run 4 for Round 1's first 100%.**

## Initial Run-by-Run Results (Runs 1-6)

| Run | Success | Questions | Errors/q | Duration | Key Event |
|-----|---------|-----------|----------|----------|-----------|
| 1 | 90.9% | 11 | 0.09 | 9.7m | Grader catches counting error (Grandma). Replay fixes it. 1 promoted to golden set. |
| 2 | 80.0% | 10 | 0.60 | 8.8m | Grader catches: missing write tools for action, tag search by keyword not tag. **Reviewer fixes ALL 3 planted bugs + rewrites all descriptions.** |
| 3 | **100%** | 10 | 0.00 | 4.2m | First perfect run. No fixes needed. |
| 4 | **100%** | 12 | 0.00 | 4.4m | Second consecutive 100%. Golden set questions passing. |
| 5 | **100%** | 12 | 0.00 | 8.2m | **Streak = 3 → ESCALATION triggered!** 5 harder questions generated and promoted to golden set. |
| 6 | 78.9% | 19 | 0.16 | 11.0m | Escalation questions break streak. Stuck-in-read-loop on Grandma's garden question. **Deep fix resolves it.** |

## What mcp-evolve Fixed

### All 3 Planted Bugs Fixed by Run 2

1. **`search_tasks` — title-only search** (planted bug)
   - Before: `tasks.filter(t => t.title.toLowerCase().includes(q))`
   - After: Searches title, description, AND tags
   - Detected by: Grader flagging wrong results for tag-based queries

2. **`update_task` — missing completedAt** (planted bug)
   - Before: Generic field loop, never sets `completedAt`
   - After: Sets `completedAt` on status→"completed", clears it on other status changes
   - Detected by: Reviewer during description improvement pass

3. **`delete_task` — silent success on missing IDs** (planted bug)
   - Before: Always returns `{ success: true }` even for non-existent tasks
   - After: Returns error with `isError: true` for missing task IDs
   - Detected by: Reviewer during description improvement pass

4. **`get_task` — null instead of error** (sloppy code)
   - Before: Returns `JSON.stringify(null)` for missing tasks
   - After: Returns error message with `isError: true`
   - Fixed alongside planted bugs

### Description Improvements

Every tool description was rewritten from terse 1-liners to detailed documentation:

| Tool | Before | After |
|------|--------|-------|
| Server instructions | 1-line generic | Lists read/write tools, mandates write tools for action requests |
| `list_tasks` | "Get tasks." | Full filter documentation with valid values |
| `get_task` | "Get a single task by its ID." | Explains full details including description/completedAt |
| `search_tasks` | "Search tasks across all fields." | Documents full-text across title/description/tags, suggests list_tasks for field filtering |
| `get_stats` | "Get statistics." | Lists all stats: total, by-status, overdue, completion rate, top assignees |
| `update_task` | "Update a task." | Explains use cases: mark complete, reassign, change priority, etc. |
| `delete_task` | "Delete a task." | Warns about permanence |
| `create_task` | "Create a new task." | (already adequate) |

### Server Changes Summary

57 insertions, 29 deletions in `server.mjs` — all applied by Run 2's reviewer pass.

## Escalation Questions Generated (Run 5)

After 3 consecutive 100% runs, mcp-evolve generated harder multi-step questions:

1. **Alex**: Delete task + create replacement with different attributes
2. **Sam**: Reassign ALL of a person's tasks + push due dates back by 1 week
3. **Mia**: Undo completed status + reschedule due dates
4. **Grandma**: Search + read details + update assignee on unassigned matches
5. **Neighbor**: Complex date-range analysis comparing past vs. future completion rates

These escalation questions are significantly harder than the base questions — they require multi-step tool sequences and cross-referencing results.

## Golden Set Growth (Runs 1-6)

| After Run | Golden Questions | Source |
|-----------|-----------------|--------|
| 1 | 1 | Replay fix (Grandma counting) |
| 2 | 2 | Replay fix (Alex write tools) |
| 5 | 7 | 5 escalation questions promoted |
| 6 | 7 | Deep fix promoted (Grandma garden) |

## Persona Performance (Runs 1-6)

| Persona | Group | Questions | Failures | History |
|---------|-------|-----------|----------|---------|
| Alex (Owner) | train | 15 | 1 | 100→50→100→100→100→100 |
| Sam (Partner) | train | 13 | 0 | 100→100→100→100→100→100 |
| Mia (Teen) | eval | 13 | 2 | 100→50→100→100→100→67 |
| Grandma Ruth | train | 17 | 2 | 50→100→100→100→100→80 |
| Neighbor Dave | eval | 13 | 1 | 100→100→100→100→100→67 |

- **Sam**: Perfect across all runs (0 failures)
- **Eval personas** (Mia, Neighbor): Impacted more by escalation questions since no fixing is applied
- **Grandma**: Most questions (17) due to golden set focus and escalation

## Early Round 2 vs Round 1 Comparison (Runs 1-6)

| Metric | Round 1 (35 runs) | Round 2 (6 runs) |
|--------|-------------------|-------------------|
| First 100% | Run 4 | Run 3 |
| All bugs found | Partial (2/3 substantive) | **All 3 by Run 2** |
| All bugs fixed | Only search partially | **All 3 by Run 2** |
| First escalation | Run 23 | Run 5 |
| Avg run duration (clean) | ~4 min | ~4 min |
| Avg run duration (fix cycle) | ~10 min | ~10 min |
| Description quality | Evolved over 35 runs | Comprehensive by Run 2 |

### Initial Six-Run Takeaways

1. **Mature harness = faster convergence**: Round 2 fixed everything in 2 runs vs. 35+ in Round 1.
2. **Reviewer is the star**: The reviewer step rewrote ALL descriptions AND fixed 2 of 3 planted bugs in a single pass.
3. **Grader catches real bugs**: The Sonnet grader correctly identified title-only search, missing write tools, and counting errors.
4. **Escalation works**: Harder questions dropped scores from 100% to 79%, validating the difficulty increase.
5. **Deep fix is the safety net**: When regular fix + replay failed (stuck-in-read-loop), deep fix resolved it on first try.
6. **Description >> code fixes**: Same finding as Round 1 — improving tool descriptions has more impact than code changes.

## Technical Notes

- Answerer model: Opus (name-only context)
- Grader model: Sonnet (no truncation)
- Fixer model: Opus (isolated git worktrees)
- Reviewer model: Opus
- Escalator model: Opus
- Questions per persona: 2 (plus golden set)
- Streak threshold: 3 consecutive 100% runs

## Addendum — Runs 7-15

The first 6 runs answered "can the mature harness converge quickly on the original bug set?" The next 9 runs answered the harder question: "does that convergence hold once the golden set contains multi-step workflows and the harness itself is under more stress?"

### Run-by-Run Results (Runs 7-15)

| Run | Success | Questions | Action Completion | Errors/q | Duration | Key Event |
|-----|---------|-----------|-------------------|----------|----------|-----------|
| 7 | 78.6% | 14 | 83.3% | 0.21 | 8.3m | Real hard-question failures: wrong "next Wednesday" date, incomplete chore reassignment, truncated analytical verdict. |
| 8 | 80.0% | 15 | 100.0% | 0.40 | 9.6m | Ownership confusion ("Mia's tasks" vs tasks merely mentioning Mia), "next Friday" ambiguity, truncated answer to Grandma. |
| 9 | 75.0% | 12 | 100.0% | 0.42 | 7.2m | Wrong task deleted, date ambiguity still unresolved, Neighbor comparison still cut off. |
| 10 | 90.9% | 11 | 100.0% | 0.09 | 7.4m | Most late issues fixed; only remaining failure is over-matching a non-school task in Mia's reopen flow. |
| 11 | **100.0%** | 16 | 75.0% | 0.00 | 9.5m | Clean score, but action metric exposes a no-op gap: one action request passed without a write call. |
| 12 | 94.1% | 17 | 66.7% | 0.18 | 13.6m | Another replay promoted, but Alex's delete+create workflow still skipped the delete step. |
| 13 | 47.6% | 21 | 0.0% | 1.48 | 21.2m | Harness/tool-availability collapse: answerer used `LSP` for every question and claimed MCP tools were unavailable. |
| 14 | 44.0% | 25 | 40.0% | 1.64 | 17.6m | Same collapse continues; grader starts expecting fallback file-reading behavior rather than MCP behavior. |
| 15 | 58.8% | 17 | 57.1% | 0.35 | 7.5m | MCP tools recover, but two hardest golden questions remain unresolved and become blocked. |

### What Actually Happened

#### Runs 7-10: Real Post-Escalation Learning

These runs still exercised the task-manager MCP tools correctly. The failures were mostly legitimate:

- **Ownership / assignee ambiguity**: "Mia's school tasks" was sometimes interpreted as tasks mentioning Mia, not tasks assigned to Mia.
- **Multi-step destructive actions**: delete + create workflows still misidentified the target task or skipped the delete entirely.
- **Relative date handling**: the system oscillated on "next Wednesday" / "next Friday" interpretations.
- **Final-answer truncation**: several answers gathered correct data but failed because the written conclusion cut off mid-sentence.

This is still good evidence for the architecture: the escalator found harder behaviors than the original bug set, and the loop exposed them quickly.

#### Runs 11-12: Near-Stable, But Not Actually Stable

Run 11 looks perfect on the headline metric, but it also reports only **75% action completion**. That means one action-like request was treated as a pass even though no write tool was called. In other words, the harness's own metrics disagree about whether the system really succeeded.

Run 12 remained strong and promoted more replayed questions into the golden set, but the delete+create scenario was still not reliably solved.

#### Runs 13-14: Harness Failure, Not Task-Manager Failure

These are the most important late runs to interpret correctly.

The answerer repeatedly used `LSP` tools and explicitly said the task-manager MCP tools were unavailable. That means the dramatic score drop in runs 13-14 mostly reflects **tool wiring / session availability failure inside the harness environment**, not regression in the task-manager server itself.

This distinction matters. If these runs were read naively, they would suggest the architecture stopped working on harder questions. In reality, the harness lost access to the interface it was supposed to be testing.

#### Run 15: Partial Recovery

Run 15 recovered MCP tool access and moved back into ordinary semantic failures:

- Alex's delete+create flow still created the replacement without deleting the original.
- Sam's batch reprioritization still used broad keyword search instead of precise tag filtering.
- Neighbor's comparative analysis still suffered from final-answer truncation.

This suggests the core loop was still useful once MCP access returned, but the system had already accumulated blocked golden questions by then.

### Updated Golden Set Status

| After Run | Golden Questions | Notes |
|-----------|-----------------|-------|
| 1 | 1 | Grandma counting replay promoted |
| 2 | 2 | Alex write-action replay promoted |
| 5 | 7 | 5 escalation questions promoted |
| 12 | 10 | 3 more replays promoted (Sam overdue, Sam priority batch, Grandma unassigned how-to) |
| 13 | 11 | Deep fix promoted Grandma overdue question |
| 14 | 12 | Replay promoted Alex overdue question |
| 15 | 12 | No new promotions; 2 questions now blocked |

Blocked golden questions after Run 15:

1. **Mia**: reopen completed school tasks and reschedule them
2. **Sam**: lower Mia's school priorities while raising health/family tasks

### Updated Persona Performance (All 15 Runs)

| Persona | Group | Questions | Failures | Late-Run Pattern |
|---------|-------|-----------|----------|------------------|
| Alex | train | 43 | 10 | Strong early, then repeatedly hit by the delete+create workflow ambiguity |
| Sam | train | 41 | 8 | Perfect through Run 12, then collapsed during harness tool-loss and ended with one blocked batch-update question |
| Mia | eval | 31 | 10 | Most sensitive to escalation-date and task-selection ambiguity |
| Grandma Ruth | train | 50 | 9 | Early stuck loop fixed well; later runs alternated between strong performance and harness-caused misses |
| Neighbor Dave | eval | 32 | 9 | Analytical multi-part questions remained the hardest and most truncation-prone |

### Fix Success Rate

Across all 15 runs: **25 total fixes attempted, 21 successful (84%)**. Replay alone resolved most failures; deep-fix handled the remainder. The 4 unsuccessful fixes all involved the same two workflows that eventually became blocked golden questions.

### Revised Lessons From Runs 7-15

1. **Fast convergence is real, but not monotonic.** The mature harness fixed the original bug set quickly, then plateaued on harder workflow questions.
2. **Escalation is productive.** The late failures were not random; they exposed ownership disambiguation, bulk writes, relative dates, and long-form comparative answers.
3. **Harness self-noise is now a first-class problem.** Runs 13-14 show that if MCP tool availability is unstable, the benchmark becomes impossible to interpret.
4. **Prompt / grader consistency matters.** The task-manager instructions defined `"next [weekday]"` one way, while late grading errors judged `"next Friday"` a different way. That creates contradictory optimization pressure.
5. **The score needs a tighter success definition.** A run can currently score 100% success while still missing some action writes, as seen in Run 11's 100% success vs. 75% action completion.
6. **Blocked golden questions are a good idea, but auto-dev is not yet clearing the hardest cases.** By Run 15, the loop had identified the right hard questions, but it had not yet demonstrated reliable autonomous resolution.

### Revised Bottom Line

Round 2 still supports the main claim that a mature harness can improve an MCP server much faster than Round 1 did. But the full 15-run record changes the tone of that claim:

- **Yes**: the architecture converges fast on promptable, fixable MCP issues.
- **Yes**: escalation finds genuinely harder, more realistic workflows.
- **Not yet**: the harness is stable enough to treat every late-run score as trustworthy evidence about the MCP under test.

---

## Round 3 — Fixed Question Sets (25 runs)

Round 3 introduced a fundamentally different architecture: fixed question sets generated at init, with graduation and escalation-on-graduation. All models switched to Sonnet.

### Architecture Changes

1. **Fixed question sets**: `mcp-evolve init` generates N questions, validates all pass, saves as `question-set.json`. Runs replay the same questions — scores are directly comparable.
2. **Train/golden split**: 30% randomly promoted to golden at init. Golden questions act as a regression gate — fixes are rejected if they break golden.
3. **Graduation**: Train questions passing 10 consecutive times graduate to golden. Graduation triggers escalation to generate replacement train questions.
4. **Model-error filtering**: Grading errors classified as model behavior (counting, interpretation) skip the fixer. Only server-category errors dispatch the fixer.
5. **All Sonnet**: Every role (answerer, grader, fixer, escalator) uses Sonnet. Clean runs take ~1 minute.
6. **Parallel everything**: All questions answered simultaneously, not per-persona.

### Run-by-Run Results

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

### Key Findings

#### What Worked

1. **Comparable scores.** Runs 1-7 all tested the same 20 questions. Score changes reflect real server/model behavior, not question variance.
2. **Speed.** Clean runs: ~1 minute (was ~4-10 min with fresh generation). 25 questions answered in parallel.
3. **Golden as regression gate.** 100% golden across runs 16-20, never broken by fixes. One golden question became flaky in runs 21-23 (counting error — model issue, not regression).
4. **Graduation works.** Run 13 graduated 13 questions at once. Runs 17 and 19 triggered graduation-escalation, replacing graduated questions with new ones.
5. **Model-error filter saves time.** Counting/interpretation errors skip the fixer (~5 min saved per run with model errors). Only server bugs get fixer attention.
6. **Fixer makes real improvements.** Run 9's fixer added `isOverdue` field and completed-task warnings — useful even though the specific question wasn't fixed.

#### What Didn't Work

1. **Planted bugs not found.** The 3 planted bugs (title-only search, missing completedAt, silent delete) were never caught across 25 runs. Init validation creates questions that pass the buggy server, so bugs producing plausible-looking wrong answers are invisible.
2. **Escalation generates workflow complexity, not correctness probes.** The escalator found edge cases (task disambiguation, acknowledging no-ops) but never generated questions that cross-check tool outputs against their descriptions.
3. **Counting errors are the dominant failure mode.** The LLM consistently miscounts items in lists. This is a model limitation — the server returns correct data, the LLM just can't count it. The model-error filter correctly avoids wasting fixer time on these.

#### Escalator Prompt Evolution

The escalator prompt went through 3 versions during Round 3:
1. **Original "harder workflows"** — generated complex multi-step questions that tested the LLM more than the server
2. **"Correctness probes"** — instructed to verify tools do what descriptions claim (committed but never tested)
3. **"Diverse natural questions"** (final) — simplified to just be a persona generating random questions with full system context. The theory: volume + diversity + time will find every bug, same as Round 1/2 did with fresh questions per run.

### Round 3 vs Round 1 & 2

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

### Bottom Line

Fixed question sets solve the comparability problem and dramatically improve speed. Graduation-triggered escalation keeps the train set fresh. Golden regression gating works.

But the architecture has a blind spot: **init validation filters out questions that would expose bugs producing plausible wrong answers.** The system needs a mechanism to test tool correctness — not just workflow completion — that doesn't rely on the answerer getting the right result on the first try.

The planted bugs were found in Rounds 1/2 by accident: fresh random questions + volume eventually hit the right patterns. Round 3's fixed-set approach trades that discovery power for comparability and speed. The escalator is meant to recover that discovery power, but needs more runs (or a correctness-probing mode) to match the old approach's coverage.
