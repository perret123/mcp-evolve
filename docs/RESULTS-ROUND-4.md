# Task Manager — Round 4 Results (Local Models)

First evaluation using fully local LLMs (zero Claude API cost for the main loop). Tests metamorphic testing, obsolete question marking, and local model provider support — all new features built in this session.

## Setup

- **Server:** Original buggy state — all 3 planted bugs intact (title-only search, missing completedAt, silent delete)
- **Models:** Ollama on Apple Silicon (MLX where available)
- **Fixer:** Claude Sonnet (only role using the API — needs Edit/Read tools)
- **New features tested:** metamorphic probes, obsolete question marking, question sampling, multi-provider support

## Model Configurations Tested

### Config A: Gemma 4 e4b (4.5B) — everything
- **Result:** Failed. `tools=0.0` across all runs. Model too small for MCP tool calling.
- **Init:** 7/20 questions validated (35%)

### Config B: Gemma 4 26b MoE answerer + e4b everything else
- **Result:** Tool calling works (1.6-2.8 tools/q). Bug found: local models use unprefixed tool names (`list_tasks` not `mcp__task-manager__list_tasks`). Fixed in `lib/llm.mjs` and `lib/run.mjs`.
- **Init:** 20/20 validated after fix

### Config C: Gemma 4 26b answerer + 26b grader + e4b rest
- **Result:** Stricter grading, fixer engages. Best balance for Gemma 4.

### Config D: Qwen 3.5 35B-A3B MLX — everything
- **Result:** Smarter (found bugs that triggered deep fix), tool calling works, but slower per call due to thinking tokens. With `num_predict=4096` and `num_ctx=100000`, speed is acceptable (~5s per call). `OLLAMA_NUM_PARALLEL=10` enables 10-way parallel inference.

## Run Results

### Phase 1: Gemma 4, no fixer (Runs 1-5)

Config B, `--skip-fixer --skip-reviewer`. Pure local evaluation.

| Run | All | Train | Golden | Tools/q | Duration |
|-----|-----|-------|--------|---------|----------|
| 1 | **100%** | 100% | 100% | 2.1 | 311s |
| 2 | **100%** | 100% | 100% | 1.8 | 300s |
| 3 | 90% | 100% | 66.7% | 1.9 | 310s |
| 4 | 85% | 100% | 50% | 1.6 | 311s |
| 5 | **100%** | 100% | 100% | 1.8 | 288s |

**Average: 95%. Train: 100% across all 5. Golden variance from harder questions.**

### Phase 2: Gemma 4 + Claude fixer (Runs 1-15)

Config B, fixer enabled. Fresh init.

| Run | Qs | All | Train | Golden | Fixer | Notes |
|-----|-----|-----|-------|--------|-------|-------|
| 1 | 20 | **100%** | 100% | 100% | - | |
| 2 | 20 | 90% | 92.9% | 83.3% | - | |
| 3 | 20 | **100%** | 100% | 100% | - | |
| 4 | 20 | **100%** | 100% | 100% | - | |
| 5 | 20 | 70% | 78.6% | 50% | - | Bad run |
| 6 | 20 | 60% | 50% | 83.3% | - | Worst run |
| 7 | 20 | **100%** | 100% | 100% | - | |
| 8 | 20 | **100%** | 100% | 100% | - | |
| 9 | 20 | 90% | 92.9% | 83.3% | - | |
| 10 | 20 | **100%** | 100% | 100% | - | **7 graduated, escalation** |
| 11 | 25 | **100%** | 100% | 100% | - | Qs grew to 25 |
| 12 | 25 | 96% | 91.7% | 100% | - | |
| 13 | 25 | **100%** | 100% | 100% | - | |
| 14 | 25 | 96% | 91.7% | 100% | - | |
| 15 | 25 | **100%** | 100% | 100% | - | |

**Average: 93.5%. Fixer never triggered — Gemma 4 e4b grader too lenient to catch planted bugs.**
**Question set grew 20 → 25 via graduation + escalation.**

### Phase 3: Gemma 4 + stricter 26b grader (Runs 16-25)

Config C (26b grader). Continuation from Phase 2 state.

| Run | Qs | All | Train | Golden | Fixer | Notes |
|-----|-----|-----|-------|--------|-------|-------|
| 16 | 25 | **100%** | 100% | 100% | - | 5 graduated, escalation |
| 17 | 30 | 86.7% | 91.7% | 83.3% | - | Escalated Qs harder |
| 18 | 30 | 24.2% | 40% | 11.1% | 3 FIXED | **26b grader kicks in — much stricter** |
| 19 | 30 | 87.5% | 100% | 77.8% | 2 FIXED | Recovering |
| 20 | 30 | 90% | 100% | 83.3% | - | 2 graduated, escalation |
| 21 | 35 | 80.6% | 87.5% | 75% | 1 FIXED | |
| 22 | 35 | 91.9% | 100% | 85% | 2 FIXED | 1 graduated, escalation |
| 23 | 40 | 94.9% | 100% | 90% | - | |
| 24 | 40 | 79.5% | 84.2% | 75% | - | |
| 25 | 40 | 82.9% | 81% | 85% | 2 FIXED | |

**Average: 81.8%. Fixer ran 10 times (all replayed as FIXED). Question set grew 25 → 40.**
**The 26b grader caught issues the e4b grader missed entirely.**

### Phase 4: Qwen 3.5 MLX + question sampling (Run 26)

Config D with `maxTrainPerRun=10, maxGoldenPerRun=10`, `localContextWindow=100000`, `localMaxPredict=4096`. 

| Run | Qs | All | Train | Golden | Fixer | Notes |
|-----|-----|-----|-------|--------|-------|-------|
| 26 | 23 | 34.8% | 50% | 11.1% | 4 FIXED | 1 obsolete, 2 branches merged |

**Qwen 3.5 grader is the strictest — 34.8% success on first pass. Found issues that triggered 4 parallel fixers in worktrees. All 4 replayed as FIXED after code changes. First obsolete question detected.**

## Key Learnings

### Model Selection Matters Enormously

| Model | Role Fit | Tool Calling | Grading | Speed |
|-------|----------|-------------|---------|-------|
| Gemma 4 e4b (4.5B) | Question gen, probes | No | Too lenient | Fast (~0.5s) |
| Gemma 4 26b MoE (3.8B active) | Answerer, grader | Yes | Good | Fast (~1-2s) |
| Qwen 3.5 35B-A3B MLX (3B active) | All roles | Yes | Strict, catches real bugs | Medium (~5s) |

- **Small models can't do tool calling** — Gemma 4 e4b (4.5B) never called MCP tools
- **Grader quality is the bottleneck** — e4b grader missed all planted bugs; 26b started finding them; Qwen 3.5 found the most
- **MoE models punch above their weight** — both Gemma 26b (3.8B active) and Qwen 35B (3B active) are practical for local inference

### Local Model Integration

- **Tool name mismatch:** MCP SDK returns unprefixed names (`list_tasks`), but mcp-evolve expected `mcp__server__list_tasks`. Fixed by skipping prefix validation for local models.
- **Ollama native API (`/api/chat`)** supports `num_ctx` and `num_predict` via `options`; the OpenAI-compatible endpoint does not.
- **`OLLAMA_NUM_PARALLEL=10`** enables concurrent inference, ~10x throughput.
- **MLX on Apple Silicon** uses GPU/Neural Engine, not CPU — system appears idle even under load.
- **Thinking tokens (Qwen 3.5)** consume output budget. `num_predict=4096` is necessary; 1024 causes empty responses as thinking consumes all tokens.

### Metamorphic Testing

- Probes run before and after every question (`[probe:before]`, `[probe:after]` visible in logs)
- Grading issues reference invariant violations when detected
- The system correctly identified 1 obsolete question in run 26 (question preconditions no longer met)
- The planted bugs are **silent failures** — they require the grader to compare before/after state, which smaller models struggle with

### Question Sampling

- `maxTrainPerRun` and `maxGoldenPerRun` work correctly — run 26 sampled 23 from 40 total
- Keeps run times manageable as the question set grows
- Random sampling ensures different questions get tested each run

### Architecture Validation

The full loop works end-to-end with local models:
```
GENERATE (local) → PROBE (local) → ANSWER (local + MCP tools) → PROBE (local)
  → GRADE (local) → FIX (Claude API) → REPLAY (local) → GRADUATE → ESCALATE (local)
```

Only the fixer uses Claude API (needs Edit/Read tools). Everything else runs at zero API cost.

## All 3 Planted Bugs Fixed

The fixer (Claude Sonnet) found and fixed **all 3 planted bugs** plus the sloppiness issue, producing a 222-line diff to `server.mjs`. The fixes were applied incrementally across runs 18-26 via worktree branches that were merged after successful replay.

### 1. `search_tasks` — title-only search (FIXED)
- **Before:** `tasks.filter(t => t.title.toLowerCase().includes(q))`
- **After:** Searches title, description, AND tags

### 2. `update_task` — missing completedAt (FIXED)
- **Before:** Generic field loop that never set `completedAt` when status → "completed"
- **After:** Explicitly sets `completedAt` timestamp on completion

### 3. `delete_task` — silent success (FIXED)
- **Before:** Always returned `{success: true}` even when task didn't exist
- **After:** Checks task exists, returns error if not found

### 4. `get_task` — null return (FIXED)
- **Before:** Returned `null` for missing tasks
- **After:** Returns proper error message

### Beyond bug fixes
The fixer also massively expanded `list_tasks` with new filter parameters: `unassigned`, `excludeAssignee`, `tag` (array support), `excludeTag`, `overdue`, `completedAfter`, `completedBefore`, `excludePriority`. All tool descriptions were rewritten with detailed usage guidance. All `PLANTED BUG` comments were removed.

**Note:** The server still had `// PLANTED BUG` comments that made fixes easier to find. Future rounds should remove these hints.

## What Changed in This Session

### New Features
1. **Metamorphic testing** — every question gets before/after probes
2. **Ollama/LM Studio provider support** — `ollama:model` and `lmstudio:model` prefixes
3. **MCP client** (`lib/mcp-client.mjs`) — local models connect to MCP servers directly
4. **Obsolete question marking** — grader can retire stale questions
5. **Question sampling** — `maxTrainPerRun`/`maxGoldenPerRun` for large test suites
6. **Model tuning** — `localContextWindow` and `localMaxPredict` config options

### Bug Fixes
- Local models use unprefixed MCP tool names
- Tool availability check skipped for local models
- `matchesWriteTools` already handled unprefixed names (no fix needed)
