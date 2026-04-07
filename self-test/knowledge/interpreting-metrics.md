# Interpreting Metrics

## What does a healthy system look like?

A healthy mcp-evolve system shows:
- **Success rate trending upward** or stable at 90%+ across runs
- **Fix rate above 60%** — fixes should succeed more often than not
- **No persona stale for 10+ runs** — every persona should occasionally find something
- **Escalation still productive** — at least some escalated questions lead to real fixes
- **Tool coverage broad** — most tools exercised by 2+ personas

## What does the success rate mean?

The success rate is the percentage of questions that passed. A question passes when: `completed=true AND actionRequirementMet=true AND stuck=false AND errorsFound=0`.

| Rate | Interpretation |
|------|----------------|
| **100%** | Everything passed. If this repeats 3+ times, escalation triggers to find harder tests |
| **80-99%** | Healthy — some failures being found and fixed |
| **50-80%** | Active improvement — many failures, fixer working hard |
| **Below 50%** | Something fundamental is broken (auth, config, tool descriptions) |

## What does action completion rate mean?

Action completion rate measures: of questions that asked for a mutation (add, create, delete, etc.), what percentage satisfied the action requirement. That means either:

1. A write tool was called appropriately, or
2. The request was already satisfied and the grader approved the assistant's explicit no-op explanation

| Rate | Interpretation |
|------|----------------|
| **100%** | Every action request was either executed or correctly resolved as a valid no-op |
| **Below 100%** | Some action requests were left incomplete — often stuck in read loop, wrong-tool usage, or missing write calls |
| **N/A** | No action requests were detected in this run |

## What is a good fix rate?

Fix rate = successful fixes / total fix attempts.

| Rate | Interpretation |
|------|----------------|
| **80%+** | Excellent — most failures are surface-level (description/schema issues) |
| **50-80%** | Normal — some failures need deeper fixes |
| **Below 50%** | Fixer is struggling — failures may be architectural, not just description quality |

A declining fix rate over time is a signal that easy wins are exhausted and remaining issues are deeper.

## What does "stale persona" mean?

A persona is stale when it hasn't found a failure in N consecutive runs (default threshold: 3-5 runs). This means either:

1. **The system genuinely handles this persona's use case perfectly** — possible but unlikely for complex systems
2. **The question generator is repetitive** — generating similar questions that all pass
3. **The persona's concerns are too narrow** — needs updated or expanded concerns
4. **The persona needs a harder question style** — concerns are right but questions are too easy

Action: run `/refine personas` or manually update the persona's concerns and question style.

## What does "errors per question" mean?

Average number of MCP tool errors per question. Includes tool call failures, auth errors, and schema validation errors. Excludes harness-internal errors (like stuck detection).

| Rate | Interpretation |
|------|----------------|
| **0.00** | No tool errors — tools are working correctly |
| **0.01-0.10** | Occasional errors — investigate specific tools |
| **Above 0.10** | Systematic issue — likely auth, config, or a broken tool |

## What does "avg tools" mean?

Average number of MCP tool calls per question. This indicates how efficiently the LLM uses the tools.

| Value | Interpretation |
|-------|----------------|
| **1-3** | Efficient — simple queries answered directly |
| **4-8** | Normal — multi-step workflows requiring several tools |
| **Above 10** | May indicate confusion — LLM is searching extensively before acting. Check for stuck-in-read-loop patterns |

## What does "escalation productive" mean?

Of the escalation events triggered (after 3x 100%), how many generated questions that eventually led to real code changes? A productive escalation is one where at least one generated question exposed a genuine gap that got fixed.

| Rate | Interpretation |
|------|----------------|
| **High (>50%)** | Escalator is finding real gaps in the tool surface area |
| **Low (<30%)** | Escalator is generating questions that pass immediately — it's not finding real blind spots. Time to `/refine` the escalator prompt |

## What does plateau mean?

A plateau is detected when: N consecutive runs at 100% AND escalation is not finding productive new gaps. This means the current testing apparatus has mapped its entire surface area.

Actions when plateau detected:
1. Run `/refine` to evolve prompts, scoring, and persona descriptions
2. Add new persona clusters for untested user types
3. Add new MCP tools that haven't been built yet (escalation as feature development)
4. Or accept that the system is genuinely solid for its current scope

## How do I compare two runs?

Use the `get_run_comparison` tool with two run filenames, or from the CLI: `mcp-evolve --regression` replays the previous baseline's questions and compares scores.

Look for:
- **Improved**: questions that failed before and pass now (fixes working)
- **Regressed**: questions that passed before and fail now (something broke)
- **Unchanged**: stability

Regressions in golden set questions are the most critical — they indicate a fix was reverted or a new change broke existing functionality.
