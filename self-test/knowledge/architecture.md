# Architecture

## System Architecture

```
 100% x 3 --> ESCALATE (reads source) --> golden set (will fail)
                                                |
    .-------------------------------------------'
    v
 PREFETCH --> GENERATE (Sonnet) --> ANSWER (Opus) --> SCORE
 real data    persona questions     uses MCP tools    action/stuck detection
                                                           |
                                  .---- pass <------------+
                                  |                        |
                                  v                  fail -v
                            baseline saved       FIX (Opus edits source)
                                  |                    |
                                  |              REBUILD + REPLAY
                                  |                    |
                                  |             FIXED? -> golden set
                                  |
                            REVIEW (Opus)
                            cross-question improvements
```

## Three Feedback Loops

### Loop 1: Evolve (test → fix tools)
The inner loop. Run personas, fix failures, escalate when passing. This is `/evolve`.

### Loop 2: Refine (evaluate apparatus → improve prompts/scoring)
The middle loop. Reviews whether the testing apparatus itself is effective — are prompts generating good questions? Is scoring accurate? Are personas productive? This is `/refine`.

### Loop 3: Steer (meta-metrics → strategic direction)
The outer loop. Analyzes accumulated metrics to decide where loops 1 and 2 should focus. Detects plateaus, identifies blind spots, recommends actions. This is `/steer`.

### Combined: Improve
`/improve` orchestrates all three: steer → refine (if needed) → evolve → report.

## File Structure

```
your-project/
  evolve.config.mjs        User configuration (personas, MCP config, write tools)
  mcp-evolve.json           MCP server connection config
  .mcp-evolve/
    logs/                   Raw run logs (one JSON per run)
    baselines/              Score snapshots for regression comparison
    golden-set.json         Permanent regression questions
    metrics.json            Accumulated metrics across all runs
```

## Model Roles

- **Haiku**: prefetch (fast, cheap — just fetching entity names)
- **Sonnet**: question generation (creative, diverse)
- **Opus**: answering, fixing, reviewing, escalating (needs full reasoning)

## Data Flow

1. `evolve.config.mjs` defines personas, MCP config, write tools
2. `run.mjs` executes the test loop, calls `updateMetrics()` at the end
3. `eval.mjs` handles scoring, baselines, golden set, regression comparison
4. `metrics.mjs` accumulates stats across runs for `/steer` and `/refine`
5. Prompts in `prompts/` are generic — no server-specific references

## How does date anchoring work?

Each run creates one canonical date context before questions are answered or graded. That context includes the reference clock, timezone, current local date, and any configured relative-date rules.

The harness passes the same date context to question generation, answering, escalation, and grading. If a question contains common relative phrases like "today", "tomorrow", "this Wednesday", or "next Friday", the harness resolves them once into canonical `YYYY-MM-DD` values and includes that mapping in the prompt.

This exists to stop the answerer and grader from inventing different interpretations of the same relative date. For date-only MCP tools, the resolved values stay date-only instead of adding fake times.

## What makes a run invalid?

A run is invalid when the harness itself is not trustworthy. Two important cases:

1. The optional `healthcheck` hook fails before testing starts
2. The answerer loses access to the configured MCP tool surface and starts using unrelated tools instead

Invalid runs are still logged, but they are quarantined from baselines, golden-set updates, metrics, and escalation. This prevents harness failures from being mistaken for MCP regressions.

## How does global golden freeze work?

If any existing golden question is still failing in the latest baseline, mcp-evolve stops generating new questions for all personas and runs in golden-only mode. This prevents the harness from exploring new surface area while known regression checks are still red.

## Action Detection

The harness needs to know if a question asks for a mutation (vs just reading data).

1. **Verb matching**: A regex checks the question for action verbs (add, create, delete, move, etc.)
2. **Write tool detection**: The config lists which tool names are write/mutation tools
3. **Stuck detection**: If the question is an action request AND the LLM called 5+ tools BUT never called a write tool → it's stuck in a read loop

This is important because "stuck in read loop" is the most common failure mode: the LLM can't figure out how to construct the write tool's parameters, so it keeps calling read tools hoping to find more context.

## Fix Cycle

When a question fails:

1. **Surface fix**: The fixer reads the tool source, improves descriptions/schemas (most common: tool description too vague for LLM to construct correct parameters)
2. **Deep fix**: If surface fix + replay still fails, a deeper investigation reads the full chain (tool handler → backend → data layer)
3. **Rebuild**: After code changes, the MCP server is rebuilt
4. **Replay**: The failing question is replayed against the fixed server
5. **Verdict**: FIXED (was failing, now passes), STILL_FAILING, or STILL_OK (was already passing)
6. **Promotion**: FIXED questions go to the golden set
