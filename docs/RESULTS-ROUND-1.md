# Task Manager — Round 1 Results

35 runs of mcp-evolve against a family task manager MCP server with 120 seeded tasks, 7 tools (3 planted bugs, 4 sloppy descriptions), and 5 personas. During this round, mcp-evolve itself was also being improved (grading, parallel fixers, worktrees, etc.).

## Run-by-Run Results

| Run | Success | Errors/q | Duration | Key Event |
|-----|---------|----------|----------|-----------|
| 1 | 70% | 0.90 | 19.5m | First graded run — normalizeStatus, overdue param added |
| 2 | 60% | 0.90 | 19.0m | Grader truncation caused false positives |
| 3 | 80% | 0.60 | 10.3m | Removed truncation — excludeStatus added |
| 4 | **100%** | 0.00 | 4.5m | First perfect run — polished descriptions |
| 5 | 70% | 0.50 | 7.2m | Hint system for cross-assignee task discovery |
| 6 | 80% | 0.70 | 7.7m | Category queries use tag filter, action detection |
| 7 | 70% | 0.70 | 15.3m | Last sequential fixer run |
| 8 | 80% | 0.40 | 6.0m | First parallel fixers |
| 9 | **100%** | 0.00 | 3.7m | Cleanest run — worktree fixers deployed |
| 10 | **100%** | 0.00 | 4.2m | Second consecutive 100% |
| 11 | 90% | 0.20 | 4.3m | Counting error in school tasks |
| 12 | **100%** | 0.00 | 4.5m | Streak reset, clean again |
| 13 | **100%** | 0.00 | 4.2m | Streak = 2 |
| 14 | 90% | 0.10 | 4.1m | Mia identity assumption flagged |
| 15 | 90% | 0.30 | 4.9m | Same identity issue |
| 16 | 80% | 0.20 | 7.7m | First run without persona context — realistic MCP simulation |
| 17 | 70% | 0.70 | 7.2m | Fixer invented get_current_user tool (!), name-only grader adjustment |
| 18 | **100%** | 0.00 | 4.2m | Name fix eliminated identity false positives |
| 19 | **100%** | 0.00 | ~4m | Clean |
| 20 | 90% | 0.33 | ~9m | Minor fix committed |
| 21 | **100%** | 0.00 | ~4m | Streak = 1 |
| 22 | **100%** | 0.00 | ~4m | Streak = 2 |
| 23 | **100%** | 0.00 | ~9m | **Streak = 3 → ESCALATION triggered!** (0 questions generated) |
| 24 | 90% | 0.50 | ~10m | Streak broken |
| 25 | 90% | 0.17 | ~10m | |
| 26 | 90% | 0.33 | ~8m | Significant fix (39 lines) |
| 27 | 90% | 0.50 | ~9m | Major rework |
| 28 | 80% | 0.67 | ~9m | Fix committed |
| 29 | 90% | 0.50 | ~9m | Large improvement |
| 30 | **100%** | 0.00 | ~4m | Clean finish |
| 31 | 85.7% | 0.14 | ~11m | Golden set active (2→4), 2 PROMOTED |
| 32 | 90.9% | 0.27 | ~8m | 1 fixed + replayed |
| 33 | **100%** | 0.00 | ~5m | 12 questions including 4 golden — all pass |
| 34 | 82.4% | 0.29 | ~12m | 17 questions, 3 fixed, 1 PROMOTED |
| 35 | 81.8% | 0.18 | ~10m | Golden set = 5, 2 fixed |

## What mcp-evolve Fixed in the Task Manager

### Tool Description Improvements (auto-generated)
- **list_tasks**: "Get tasks." → comprehensive description with filter documentation, overdue guidance, excludeStatus parameter, pagination, priority sorting
- **search_tasks**: "Search all fields." → clarified substring matching, synonym encouragement, tag vs search guidance
- **get_stats**: "Get statistics." → listed available stats, when to use vs list_tasks
- **create_task**: Undocumented priority → documented low/medium/high/urgent values
- **get_task**: null on missing → (still returns null, but descriptions improved)

### Code Improvements (auto-generated)
- Added `normalizeStatus()` — handles "pending"→todo, "done"→completed, "active"→in_progress
- Added `overdue` parameter to list_tasks — correct overdue filtering excluding completed tasks
- Added `excludeStatus` parameter — "all active tasks" in one call
- Added `tag` filter to list_tasks — direct tag filtering without search
- Added priority sorting (urgent→low, then by due date)
- Added pagination (limit/offset with hasMore)
- Added hint system — when assignee+filter returns 0, suggests broader searches
- Expanded server instructions from 1 line to comprehensive usage guide

### Planted Bugs Status
| Bug | Found? | Fixed? | How |
|-----|--------|--------|-----|
| search_tasks only searches title | Partially | No | Grading caught empty results but fixer focused on descriptions |
| update_task doesn't set completedAt | Yes | No | Grader flagged null completedAt, fixer didn't fix implementation |
| delete_task returns success for missing ID | No | No | Never triggered in test questions |

Note: The planted bugs were subtle behavioral issues. The fixer excelled at description/schema improvements but was less effective at finding logic bugs deep in handlers — this is expected behavior and an area for improvement.

## mcp-evolve Bugs Found and Fixed

| # | Bug | Impact | Fix |
|---|-----|--------|-----|
| 1 | Undefined `prefetchData` in generateQuestions | Crash on startup | Renamed to `fullContext` |
| 2 | Shared data dir caused premature escalation | False 7-run streak | Added dedicated dataDir per example |
| 3 | Tool results not parsed from stream-json | Grader saw "(no result)" for everything | Parse user events with nested tool_result |
| 4 | Grader truncation → false positives | 60% of grading errors were wrong | Removed truncation, full results to grader |
| 5 | Fixer retry loop (no cap) | Runs took 15+ minutes | Added configurable max retries (default 1) |
| 6 | Persona identity leaked to answerer | Unrealistic — MCP servers don't know persona | Removed, then added name-only (like auth) |

## mcp-evolve Features Built During This Session

| Feature | Description |
|---------|-------------|
| **LLM-based answer grading** | Sonnet verifies semantic correctness after each answer |
| **Parallel fixers in git worktrees** | Each error gets isolated worktree, all fix in parallel |
| **Claude-driven merge** | Multiple fix branches merged intelligently by Claude |
| **Feature competition system** | 3 persona groups propose features, cross-vote, winner gets built |
| **Knowledge base** | Evolution log — grows only when features ship |
| **Full model configurability** | Every stage (answerer, grader, fixer, proposer, voter) configurable |
| **Competition configurability** | Groups, group size, streak multiplier all configurable |

## Key Insights

1. **Description improvements > code fixes.** The fixer is excellent at improving tool descriptions, schemas, and instructions. It's weaker at finding logic bugs in handlers.

2. **The grader is the real innovation.** Without semantic grading, all runs passed 100% from the start — tools "worked" but answers were wrong. The grader catches silent bugs.

3. **Truncation kills grading accuracy.** Full tool results to the grader are worth the tokens. Truncation caused more false positives than it saved in cost.

4. **Never optimize for fewer tool calls.** The fixer kept adding "ONE call only" language that actively harmed search quality. Tool calls are cheap, wrong answers are expensive.

5. **Persona identity matters.** Passing full persona context to the answerer is unrealistic. Name-only (like auth) is the right middle ground.

6. **Parallel fixers with worktree isolation work.** No race conditions, reviewer handles reconciliation naturally.

7. **The system oscillates around 80-100%.** New question types surface new issues, fixer improves, next run passes, escalation generates harder questions, cycle continues.
