# Task Manager — Round 5 Results (Blind Bug Finding with Local Models)

Round 5 tests whether mcp-evolve can discover planted bugs organically — no hint comments, no questions crafted to target bugs. All questions were either hand-written or escalation-generated, with none designed to expose the 3 planted bugs.

## Setup

- **Server:** Original buggy state — all 3 planted bugs intact, NO `// PLANTED BUG` comments (removed after Round 4)
- **Seed data:** 180 tasks (expanded from 120) — dates spanning Jun 2025 to Dec 2027
- **Models:** Qwen 3.5 35B-A3B MLX (`ollama:qwen3.5:35b-a3b-coding-nvfp4`) for all local roles
- **Fixer/Reviewer:** Claude Sonnet (needs Edit/Read tools)
- **Init:** Hand-crafted 10 questions (2 per persona), no validation — Run 1 handles answer+grade
- **Ollama:** `NUM_PARALLEL=1` (higher parallelism caused memory crashes with KV cache pressure)
- **Context:** 64K window, 16K max predict (thinking tokens share the predict budget)

### Configuration Changes from Round 4

| Parameter | Round 4 | Round 5 | Why |
|-----------|---------|---------|-----|
| `localContextWindow` | 100,000 | 64,000 | Memory pressure with parallel requests |
| `localMaxPredict` | 4,096 | 16,384 | Qwen 3.5 thinking tokens consumed entire output budget at 4K |
| `OLLAMA_NUM_PARALLEL` | 10 | 1 | Parallel KV cache allocation crashed Ollama at higher values |
| `initQuestions` | 20 | 10 | Faster init, 2 per persona |
| Init validation | Full answer+grade | None | Redundant with Run 1 — also filtered out bug-exposing questions |
| Init golden assignment | 30% golden | 0% | Golden promotion happens naturally during runs |
| Default LLM timeout | 180s | 600s | Local model inference much slower than API |
| Tool-call per-iteration timeout | 60s | 120s | Thinking tokens need more time per call |

### Planted Bugs (unchanged)

1. `search_tasks` — title-only search (doesn't search description or tags)
2. `update_task` — missing `completedAt` timestamp when status set to "completed"
3. `delete_task` — returns `{success: true}` even when task doesn't exist

## Run Results — 75 Runs

### Phase 1: Baseline (Runs 1-9)

Initial 10 hand-crafted questions, no escalation yet.

| Run | Qs | All | Train | Golden | Errors/q | Duration |
|-----|-----|-----|-------|--------|----------|----------|
| 1 | 11 | 63.6% | 63.6% | — | 0.64 | 664s |
| 2 | 10 | 70.0% | 70.0% | — | 0.60 | 397s |
| 3 | 10 | 60.0% | 60.0% | — | 0.80 | 383s |
| 4 | 12 | 66.7% | 66.7% | — | 0.75 | 657s |
| 5 | 10 | 80.0% | 80.0% | — | 0.20 | 396s |
| 6 | 11 | **90.9%** | 90.9% | — | 0.27 | 620s |
| 7 | 11 | 72.7% | 72.7% | — | 0.36 | 688s |
| 8 | 10 | 70.0% | 70.0% | — | 0.50 | 276s |
| 9 | 11 | 63.6% | 63.6% | — | 0.55 | 540s |

**Average: 68.5%. First golden question graduated at Run 10.**

### Phase 2: Post-Escalation 1 (Runs 10-25)

Escalation at Run 10 — harder questions generated. 1 question promoted to golden.

| Run | Qs | All | Train | Golden | Errors/q | Notes |
|-----|-----|-----|-------|--------|----------|-------|
| 10 | 10 | 50.0% | 50.0% | — | 1.00 | **Escalation triggered** |
| 11 | 13 | 69.2% | 66.7% | 100% | 0.85 | 1st golden question |
| 15 | 11 | 45.5% | 40.0% | 100% | 0.64 | Worst in phase |
| 17 | 12 | 83.3% | 81.8% | 100% | 0.33 | |
| 20 | 12 | 83.3% | 81.8% | 100% | 0.25 | |
| 24 | 11 | **90.9%** | 90.0% | 100% | 0.09 | Best in phase |

**Average: 66.3%. Golden: 100% across all 16 runs.**

### Phase 3: Post-Escalation 2 (Runs 26-46)

Escalation at Run 26. 2nd golden question promoted.

| Run | Qs | All | Train | Golden | Errors/q | Notes |
|-----|-----|-----|-------|--------|----------|-------|
| 26 | 11 | 36.4% | 30.0% | 100% | 1.27 | **Escalation triggered** |
| 28 | 12 | **91.7%** | 90.0% | 100% | 0.17 | Fast recovery |
| 42 | 12 | **91.7%** | 90.0% | 100% | 0.08 | |
| 43 | 12 | **91.7%** | 90.0% | 100% | 0.08 | |
| 45 | 12 | **91.7%** | 90.0% | 100% | 0.08 | |

**Average: 78.8%. Strong 90%+ streaks before escalation.**

### Phase 4: Post-Escalation 3 (Runs 47-75)

Escalation at Run 47. 3rd golden question promoted. Question set grew to 20.

| Run | Qs | All | Train | Golden | Errors/q | Notes |
|-----|-----|-----|-------|--------|----------|-------|
| 47 | 12 | 75.0% | 70.0% | 100% | 0.58 | **Escalation triggered** |
| 60 | 13 | 84.6% | 80.0% | 100% | 0.31 | |
| 66 | 13 | 92.3% | 90.0% | 100% | 0.08 | |
| 67 | 14 | 92.9% | **100%** | 66.7% | 0.07 | **Train 100% (first ever!)** |
| 70 | 13 | **100%** | **100%** | 100% | 0.00 | **Perfect run!** |
| 75 | 13 | 76.9% | 70.0% | 100% | 0.38 | Final run |

**Average: 77.9%. Run 70 achieved the first perfect 100% across all questions.**

## Aggregate Statistics

| Metric | Value |
|--------|-------|
| Total runs | 75 |
| Average success (all) | **76.4%** |
| Average success (final 10) | **85.1%** |
| Peak run | **100%** (Run 70) |
| Escalations triggered | 3 (Runs 10, 26, 47) |
| Feature competitions | 0 (never hit 6 consecutive 100%) |
| Golden questions promoted | 3 |
| Golden accuracy | **100% in 72/75 runs** (96%) |
| Question set growth | 10 → 20 (via escalation) |
| Total duration | ~9.5 hours |
| Avg run duration | ~460s (~7.7 min) |

## Server Changes (Fixer Output)

The fixer (Claude Sonnet) made significant improvements to the server across 75 runs, producing a 104-line diff to `server.mjs`. Notably, **2 of 3 planted bugs were fixed** — despite no questions being designed to target them.

### Bug 1: `search_tasks` — title-only search (FIXED)
- **Before:** `tasks.filter(t => t.title.toLowerCase().includes(q))`
- **After:** Searches title AND tags, supports multi-word queries (all tokens must match), optional query parameter
- **How found:** Escalated questions about task categories (e.g. "finance tasks", "home tasks") triggered search by tag, exposing that tag search didn't work

### Bug 2: `update_task` — missing completedAt (FIXED)
- **Before:** Generic field loop that never set `completedAt` when status → "completed"
- **After:** Explicitly sets `completedAt` on completion, clears it when status changes away from completed

### Bug 3: `delete_task` — silent success (NOT FIXED)
- No question organically triggered a delete of a non-existent task
- This bug requires a specific scenario (delete with bad ID) that didn't arise naturally

### Beyond Bug Fixes

The fixer made substantial quality improvements:

1. **`list_tasks` enhanced:**
   - Added `overdue` filter parameter
   - Comma-separated status values (`"todo,in_progress"`)
   - Case-insensitive assignee matching
   - Response includes `today` date, `count`, and empty-result message
   - Detailed tool descriptions with usage guidance

2. **`search_tasks` rewritten:**
   - Added status, assignee, priority, dueAfter, dueBefore filters alongside keyword search
   - Multi-word query support (all tokens must match)
   - Includes `isOverdue` field and `today` date in response

3. **`get_stats` description improved:**
   - Clear guidance on when to use `get_stats` vs `search_tasks` for category-specific queries

4. **Server instructions expanded:**
   - Family member names documented
   - "This week" / "next week" date calculation rules
   - Guidance for "the kids" queries (call per child, combine results)
   - Distinction between "today" as date vs "today" as "currently outstanding"

## Key Findings

### Blind Bug Discovery Works — Partially

2 of 3 planted bugs were found organically without hint comments or targeted questions. The fixer discovered them through escalated questions that naturally exercised the buggy code paths. The delete bug (silent success on missing ID) requires a specific failure scenario that never arose — suggests mcp-evolve needs more adversarial question generation for error-path coverage.

### Tool-Calling Timeouts are the Dominant Failure Mode

The majority of failures across 75 runs were `ERROR: This operation was aborted` — the Qwen 3.5 thinking tokens consumed too much time before making tool calls. This is a model inference issue, not a server bug. The fixer correctly identified these as non-fixable and made no changes for timeout-related failures.

### Thinking Tokens: Quality vs Speed Tradeoff

Qwen 3.5's `<think>` phase significantly improves answer quality but creates challenges:
- Thinking tokens share the `num_predict` budget — 4K predict caused empty responses
- 16K predict works well (~4-8K thinking + response)
- Ollama has no `max_thinking_tokens` parameter to cap thinking independently
- `think: false` disables thinking but reduces quality

### Parallel Inference Challenges on Apple Silicon

| Config | Result |
|--------|--------|
| `NUM_PARALLEL=10`, 100K ctx | Ollama crashes (27GB peak memory, KV cache overflow) |
| `NUM_PARALLEL=5`, 100K ctx | Still crashes |
| `NUM_PARALLEL=5`, 32K ctx | Intermittent `fetch failed` errors |
| `NUM_PARALLEL=4`, 64K ctx | 500 errors after 5 min |
| `NUM_PARALLEL=1`, 64K ctx | Stable, all requests succeed |

The relationship is `parallel_slots × context_window = total_KV_cache`. Qwen 3.5 35B on Apple Silicon with 256GB RAM needs `NUM_PARALLEL=1` at 64K context for stability.

### Init Simplification

Round 5 validated two init improvements:
1. **No validation during init** — Run 1 handles answer+grade naturally, avoiding redundant work and preventing bug-exposing questions from being filtered out
2. **No golden assignment at init** — golden promotion happens organically through consecutive passes

These changes reduced init time from ~7.5 minutes to ~2 minutes (question generation only).

## What Changed in This Session

### mcp-evolve Changes
1. **Init simplified** — removed validation loop and golden pre-assignment
2. **Default LLM timeouts increased** — 180s → 600s for local model compatibility
3. **Per-iteration timeout increased** — 60s → 120s for thinking models
4. **Question gen timeout increased** — 120s → 600s

### Seed Data Expanded
- 120 → 180 tasks
- Added 16 older completed tasks (summer 2025)
- Added 14 future tasks (late 2026)
- Added 30 far-future tasks (2027)
- Date range: Jun 2025 → Dec 2027

### Config Changes
- `initQuestions: 10` (was default 20)
- `localContextWindow: 64000` (was 100000)
- `localMaxPredict: 16384` (was 8192)

## Comparison with Round 4

| Metric | Round 4 | Round 5 |
|--------|---------|---------|
| Runs | 26 | 75 |
| Avg success | 81.8% (Config C) | 76.4% |
| Bugs found | 3/3 | 2/3 |
| Hint comments | Yes (`// PLANTED BUG`) | No |
| Questions targeting bugs | Some (naturally generated) | None (hand-crafted neutral) |
| Escalations | 4 | 3 |
| Feature competitions | 0 | 0 |
| Perfect runs | Multiple | 1 (Run 70) |

Round 4 had higher success rates partly because hint comments made bugs easier to find and fix early. Round 5's lower average reflects the harder challenge of blind discovery, plus tool-calling timeout noise from the thinking model.
