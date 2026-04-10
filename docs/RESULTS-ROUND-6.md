# Task Manager — Round 6 Results (API Layer + Model-Error Fixer)

Round 6 introduces the API/MCP separation, model-error pattern detection, adversarial prompts, and the question→prompt rename. Tests whether the fixer can evolve a sloppy MCP wrapper into a well-documented, tool-rich interface by discovering patterns in model failures.

## Setup

- **Architecture:** New `task-api.mjs` (full backend) + `server.mjs` (thin MCP wrapper)
- **API capabilities:** CRUD, full-text search (title+description+tags), stats, assignee workload, overdue summary, tag summary, bulk update, history
- **MCP wrapper (start):** 7 tools, sloppy one-line descriptions, 3 planted bugs
- **Models:** Qwen 3.5 35B-A3B MLX, fixer/reviewer on Claude Sonnet
- **New features:** model-error fixer, adversarial prompts (10%), constraint verification, prompt/response terminology

### Planted Bugs (in MCP wrapper, not API)

1. `search_tasks` — title-only search (API searches title+description+tags)
2. `update_task` — bypasses API's completedAt lifecycle (manual field copy)
3. `delete_task` — ignores API's `found: false`, always returns `{success: true}`

### New mcp-evolve Features Tested

- **Model-error fixer:** When 3+ model-category errors accumulate in a run, bundle them and analyze for MCP improvement patterns
- **Adversarial prompts:** 10% chance per persona of generating prompts with wrong names, nonexistent IDs, or contradictions
- **Constraint verification:** Grader checks that tool input params match user's constraints (dropped filters = fail)
- **Fixer taxonomy:** Fixer must state whether bug is in description vs handler before editing

## Run Results — 50 Runs

### Phase 1: Baseline + Model-Error Discovery (Runs 1-9)

| Run | All | Train | Golden | Model-Error Fixer | Notes |
|-----|-----|-------|--------|-------------------|-------|
| 1 | 72.7% | 72.7% | — | — | First run on new server |
| 2 | 72.7% | 72.7% | — | fired (3) | |
| 3 | 80.0% | 80.0% | — | | |
| 4 | 72.7% | 72.7% | — | fired (3) | |
| 5 | **100%** | 100% | — | | Perfect! |
| 6 | 90.0% | 90.0% | — | | |
| 7 | 90.0% | 90.0% | — | | |
| 8 | 90.0% | 90.0% | — | | |
| 9 | 90.0% | 90.0% | — | | Stable plateau |

**Model-error fixer fired twice early (Runs 2, 4) and success jumped from 72% to 100% by Run 5.**

### Phase 2: Post-Escalation (Runs 10-25)

| Run | All | Train | Golden | Model-Error Fixer | Notes |
|-----|-----|-------|--------|-------------------|-------|
| 10 | 90.9% | 90.9% | — | | Escalation 1 |
| 11 | 75.0% | 66.7% | 100% | fired (3) | 4 golden prompts |
| 12 | **93.3%** | 90.9% | 100% | | |
| 14 | 81.3% | 75.0% | 100% | | Escalation 2 |
| 15 | 81.3% | 70.0% | 100% | fired (3) | action=100% |
| 16 | 70.0% | 57.1% | 100% | fired (5) | 20 prompts, toughest run |
| 19 | 64.7% | 45.5% | 100% | fired (5) | Worst run |
| 21 | 82.4% | 72.7% | 100% | | Recovery |

### Phase 3: Maturity (Runs 26-50)

| Run | All | Train | Golden | Notes |
|-----|-----|-------|--------|-------|
| 29 | **100%** | 100% | 100% | Perfect — all 16 prompts including actions |
| 31 | 93.8% | 90.0% | 100% | |
| 42 | **94.1%** | 88.9% | 100% | action=100% |
| 46 | **94.4%** | 90.0% | 100% | |
| 48 | 88.9% | **100%** | 75.0% | Train perfect |
| 49 | 94.4% | 90.0% | 100% | |
| 50 | **94.7%** | 90.9% | 100% | Final run — best overall |

## Aggregate Statistics

| Metric | Round 5 | Round 6 |
|--------|---------|---------|
| Runs | 75 | 50 |
| **Avg success** | 76.4% | **85.1%** |
| **Last 10 avg** | 85.1% | **90.4%** |
| Best run | 100% | 100% |
| Perfect runs | 1 | 2 |
| Escalations | 3 | 4 |
| Model-error fixer | — | **16 firings** |
| Golden set | 3 | **8** |
| Prompt set growth | 10→20 | 10→30 |
| Bugs found | 2/3 | 2/3 |
| **New tools created** | 0 | **4** |

## What the Fixer Built

Starting from a 7-tool wrapper with one-line descriptions, the fixer evolved the MCP server into a 12-tool interface with rich, context-aware descriptions. The API layer (`task-api.mjs`) was never modified — all improvements were in the MCP wrapper.

### New Tools Created (wrapping existing API)

| Tool | API Method | Why Created |
|------|-----------|-------------|
| `get_overdue_tasks` | `api.getOverdueSummary()` | Model confused "overdue" (late) vs "urgent" (priority). Dedicated tool prevents mix-up. |
| `get_current_date` | Pure computation | Model couldn't compute relative dates ("next week", "last month"). Returns pre-computed `nextWeekStart`, `thisMonthEnd`, etc. |
| `list_tags` | `api.getTagSummary()` | Model guessed tag names. Discovery tool lets it check available tags first. |
| `find_and_update_task` | `api.searchTasks()` + `api.updateTask()` | Model took 3-4 calls to search→find→update. Combined tool with fallback logic for partial matches and multi-result disambiguation. |

### Description Evolution

**Server instructions** — from one line to a paragraph:
- Before: `"A family task manager for Alex's household. Manage to-do items for the whole family."`
- After: Documents family members by role, directs to `find_and_update_task` for mutations, requires `get_current_date` before relative dates, instructs not to stop for confirmation after date lookup

**`list_tasks`** — from `"Get tasks."` (2 words) to a detailed guide:
- Added `completedAfter`/`completedBefore` params for date-range queries on finished tasks
- Added `tag` param wrapping API's tag filter
- Status description clarifies: `"overdue"` is a due-date filter, not a completion filter
- Assignee description distinguishes "show me" (display request) from "my" (ownership)
- Priority description: `"urgent"` ≠ overdue, `"today"` doesn't mean due-date filter
- Empty results include active filters and explicit instruction not to retry with relaxed filters

**`search_tasks`** — bug fixed plus behavioral guardrails:
- Before: title-only search via manual filter (Bug 1)
- After: delegates to `api.searchTasks()` (title+description+tags), adds not-found message with "stop searching" instruction, adds idempotency check ("already done? say so, don't update another task")

**`update_task`** — bug fixed plus action guidance:
- Before: manual field copy, no completedAt handling (Bug 2)
- After: delegates to `api.updateTask()` with proper completedAt lifecycle, adds reassignment workflow ("call get_stats → pick fewest tasks → update"), valid status values documented

**`create_task`** — intent disambiguation:
- Added: "add a reminder for [event]" = reminder for current user about event, not event is assignee
- Added: only create when explicitly asked, never create when user asks to modify existing

**`delete_task`** — unchanged (Bug 3 not triggered):
- Still returns `{success: true}` regardless

### Parameter Additions

| Tool | New Params | Purpose |
|------|-----------|---------|
| `list_tasks` | `completedAfter`, `completedBefore` | "What did I finish last month?" queries |
| `list_tasks` | `tag` | Category filtering by tag |
| `find_and_update_task` | `taskId` | Skip search when ID known from prior call |
| `find_and_update_task` | `searchDueAfter`, `searchDueBefore` | "Transfer the car task due this week" — narrow by date |

### Handler Improvements

- `list_tasks`: Empty results now include which filters were active, preventing the model from silently broadening the query
- `list_tasks`: Non-empty results include `_note` reminding model to use exact task IDs from response
- `search_tasks`: Not-found response explicitly says search is exhaustive — "stop searching"
- `find_and_update_task`: Three-tier fallback (date-filtered → unfiltered → per-token partial match) with suggestions
- `find_and_update_task`: Multi-match returns all candidates, requires `taskId` in follow-up call

## Bugs Found

### Bug 1: `search_tasks` title-only search — FIXED
- **Before:** `tasks.tasks.filter(t => t.title.toLowerCase().includes(q))`
- **After:** `api.searchTasks(query)` — searches title, description, and tags
- **How found:** Prompts about task categories ("home tasks", "errands") returned no results when the keyword was in tags/description but not the title

### Bug 2: `update_task` missing completedAt — FIXED
- **Before:** Manual field copy, no completedAt handling
- **After:** `api.updateTask(id, changes)` — API handles completedAt lifecycle
- **How found:** Grader's metamorphic probes detected tasks marked "completed" but missing timestamps

### Bug 3: `delete_task` silent success — NOT FIXED
- Still ignores API's `{found: false}` return
- No prompt organically triggered a delete of a nonexistent task
- This is a low-impact bug — real users search before deleting

## Model-Error Fixer Impact

The model-error fixer fired **16 times** across 50 runs, making it the most active new component. Its contributions:

1. **Runs 2+4:** Early firings led to `get_overdue_tasks` and improved `list_tasks` descriptions — success jumped from 72% to 100% by Run 5
2. **Runs 11-20:** After escalation added harder prompts, it created `get_current_date` and `find_and_update_task` to help the model with relative dates and search+update workflows
3. **Runs 25-44:** Continued refining descriptions — added the "show me" vs "my" distinction, status value documentation, reassignment workflow

The pattern: model errors → fixer identifies that the MCP interface is ambiguous or missing a convenience tool → creates or improves tools → model succeeds on retry.

## Prompt Set Evolution

Started with 10 hand-crafted prompts, grew to 30 via 4 escalations:

- **Golden (8):** overdue check, priority change, Mia's tasks, donation bag reassignment, smoke detector reminder, completed count, home tasks count, car maintenance transfer
- **Train (22):** includes date-range queries, tag filtering, status changes, multi-step updates, "what did I finish", task creation, relative date rescheduling

Prompt diversity improved over Round 5 — escalated prompts now include compound queries ("transfer the car task due this week to Sam"), state verification ("what did we finish last week"), and category-based filtering ("school tasks still todo").

## Key Findings

### API/MCP Separation Works

The fixer correctly stayed within the MCP layer — `task-api.mjs` was never modified. All improvements were tool descriptions, handler logic, and new wrapper tools. This validates the architecture: the MCP layer is the right place for LLM-facing improvements, while the API layer provides the stable foundation.

### Model-Error Fixer is the Key Innovation

Without the model-error fixer, Rounds 1-5 relied on the regular fixer which only activates for server-category errors. Many model failures were actually MCP description problems that the regular fixer wouldn't touch. The model-error fixer bridges this gap — it sees patterns in model failures and makes MCP improvements that help the model succeed.

### Description Quality Compounds

Each description improvement makes future prompts more likely to succeed, which reduces model errors, which means less fixer work. The system converges toward stable, well-documented tools. The final `list_tasks` description is 500+ words — far more detailed than any human would write initially, but each addition was driven by a real model failure.

### Adversarial Prompts Don't Destabilize

The 10% adversarial rate added prompts with wrong names and nonexistent IDs without crashing the success rate. The fixer's response was to add better not-found messages and stop-searching instructions — making the server more robust for real edge cases too.

## What Changed in This Session

### mcp-evolve Changes
1. **Terminology:** question→prompt, answer→response across 24 files
2. **Model-error fixer:** New role analyzing 3+ model errors for MCP patterns
3. **Reviewer repurposed:** Now merges parallel fixer branches (was independent description pass)
4. **Answerer stripped:** One-line system prompt — let the LLM figure it out
5. **Escalator improved:** Explicit interaction pattern diversity, no task-manager examples
6. **Fixer taxonomy:** Must state description vs handler bug before editing
7. **Adversarial prompts:** `adversarialRate` config, generates wrong-name/nonexistent-ID prompts
8. **Constraint verification:** Grader checks tool params against user constraints

### Task Manager Changes
1. **API layer:** `task-api.mjs` with full capabilities (search, analytics, bulk ops, history)
2. **MCP wrapper:** Thin `server.mjs` importing from API, deliberately incomplete
3. **Seed data:** 180 tasks (Jun 2025 – Dec 2027)
