# Core Concepts

## What is mcp-evolve?

mcp-evolve is a self-improving test harness for MCP (Model Context Protocol) servers. It simulates diverse user personas against your MCP tools, detects failures, fixes tool descriptions and code automatically, escalates difficulty when everything passes, and grows a golden regression set.

The key insight: **fix the tool, not the model**. Instead of fine-tuning LLMs to work around bad tools, mcp-evolve makes the tools better so every LLM benefits.

## The Test Loop

Each run follows this cycle:

1. **Prefetch** — Optionally fetch real data from the MCP server (entity names, IDs) so generated questions use real data instead of hallucinated names
2. **Generate** — Each persona generates questions based on their role, concerns, and communication style (uses Sonnet)
3. **Answer** — An LLM uses the MCP tools to answer each question (uses Opus)
4. **Score** — Results are scored for: completion, action detection (did a write tool get called for action requests?), stuck detection (too many reads, no write), error counting
5. **Fix** — For failures, the fixer reads the tool source code and edits descriptions/schemas/handlers (uses Opus)
6. **Replay** — After a fix, the question is replayed to verify the fix worked
7. **Promote** — Fixed questions are promoted to the golden set for permanent regression testing
8. **Review** — A reviewer analyzes all results and makes cross-cutting improvements to tool descriptions
9. **Escalate** — After 3 consecutive 100% runs, the escalator reads source code to find untested capabilities and generates harder questions

## Persona

A persona simulates a specific type of user. Each persona has:

- **ID**: unique identifier (e.g. "admin", "waiter-orders")
- **Name**: human-readable name (e.g. "Restaurant Owner")
- **Role**: access level or job function (e.g. "Admin", "Service")
- **MBTI type**: cognitive style that affects question patterns (e.g. INTJ = strategic analyst, ESFP = hands-on operator)
- **Cluster**: group of related personas (e.g. "service" cluster has waiter-orders, waiter-payments, waiter-management)
- **Group**: "train" (fixer can fix failures) or "eval" (hold-out, no fixes — measures generalization)
- **Concerns**: list of topics the persona cares about
- **Question style**: how the persona communicates (direct commands vs analytical queries)

### Train vs Eval Split

- **Train personas**: When their questions fail, the fixer edits tool code to fix it. This is where the system learns.
- **Eval personas**: No fixes applied. Pure measurement of whether improvements generalize to unseen users.

## MBTI Types

Each persona gets an MBTI type representing their cognitive style. Rule: no two personas in the same cluster may share the same MBTI type. This ensures cognitive diversity — an ISTP waiter and an ENFJ waiter ask fundamentally different questions about the same system.

The 16 types produce different question patterns:
- **Thinking types (T)**: focus on logic, edge cases, correctness
- **Feeling types (F)**: focus on user experience, clarity, impact
- **Sensing types (S)**: focus on concrete details, what actually happens
- **Intuitive types (N)**: focus on patterns, future implications, what could go wrong

## Cluster

A cluster groups personas with similar roles. Within a cluster, each persona must have a unique MBTI type. This prevents "similar people asking similar questions" while allowing multiple perspectives on the same domain.

Example: the "service" cluster might have:
- waiter-orders (ISTP) — hands-on, direct commands
- waiter-payments (ISFJ) — careful, methodical with money
- waiter-management (ENFJ) — people-focused, moves guests around

## Golden Set

The golden set is a collection of permanent regression questions. Questions enter the golden set when:

1. A question fails during a test run
2. The fixer edits tool code to make it pass
3. The replay confirms the fix worked
4. The question is automatically promoted to the golden set

Golden set questions run on every future test run, ensuring that fixes don't regress. The set has a configurable max size (default 50) — when full, the oldest questions are rotated out.

Questions can also enter the golden set via escalation — when the system generates harder questions from source code analysis.

## Baseline

A baseline is a snapshot of scores from a single run. It records which questions were asked, which persona asked them, and how they scored. Baselines enable:

- **Regression comparison**: replay baseline questions and compare old vs new scores
- **Streak detection**: count consecutive 100% baselines to trigger escalation
- **Diversity checking**: compare new questions against baseline to avoid repetition

## Scoring

Each question is scored on:

- **completed**: did the LLM produce a substantial answer (>50 chars, not an error)?
- **isActionRequest**: does the question ask for a mutation (detected by verb pattern matching)?
- **writeToolCalled**: for action requests, did the LLM actually call a write tool?
- **actionRequirementMet**: for action requests, did the assistant either call a write tool or correctly explain a valid no-op?
- **stuck**: action request + no write tool + 5+ read tools = stuck in read loop
- **timedOut**: hit the timeout without completing
- **errorsFound**: MCP tool errors (excluding harness-internal errors)

A question **passes** if: completed=true AND actionRequirementMet=true AND stuck=false AND errorsFound=0.

## Escalation

When the test harness passes 100% for N consecutive runs (default 3), escalation triggers:

1. The escalator receives all passing questions and available personas
2. It reads the MCP tool source code to find ALL capabilities
3. It identifies gaps — untested workflows, parameters, edge cases
4. It generates one harder question per persona targeting these gaps
5. Questions are added to the golden set (they'll likely fail until fixed)

This creates the development loop: escalation generates "feature requests" as failing tests, the fixer implements them, and the golden set tracks the releases.

## Metrics

The metrics store accumulates data across runs:

- **Per-persona**: total questions, failures, fixes, staleness (runs since last failure), success rate history
- **Per-tool**: call counts, error rates, which personas exercise each tool, call history
- **Fixes**: total attempts, success rate, history with verdicts
- **Escalations**: total, how many were productive (led to real fixes)
- **Apparatus**: tracking of prompt/scoring changes from /refine

Metrics are stored in metrics.json and capped at 50 entries per array to prevent unbounded growth.

## Staleness

A persona is "stale" when it hasn't generated a failure in many consecutive runs. This could mean:
- The system is genuinely perfect for that persona's use case (unlikely)
- The persona's concerns are too narrow
- The question generator is producing repetitive questions
- The persona needs refreshed concerns or a harder question style

The /steer skill uses staleness to recommend which personas need attention.
