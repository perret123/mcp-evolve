# Troubleshooting

## What does "stuck in read loop" mean?

The most common failure mode. It means: the question asked for an action (add, create, delete, etc.) but the LLM called 5+ read tools without ever calling a write tool. The LLM couldn't figure out how to construct the write tool's parameters.

**Root causes (most common first):**
1. **Tool description too vague** — the write tool's description doesn't explain what parameters are needed or their format
2. **Missing examples** — the LLM doesn't know what a valid `productList` or `guestId` looks like
3. **Schema mismatch** — the inputSchema says one thing but the handler expects another
4. **Entity not found** — the LLM searched for an entity (by name) but couldn't find it, so it kept searching

**Fixes:**
- Add concrete examples to the write tool's description (e.g., "productList should be [{productId: '...', quantity: 2}]")
- Improve parameter descriptions in the inputSchema
- If the LLM can't find entities: add a prefetch function that provides real names

## What does "timed out" mean?

The question hit the 180-second timeout without completing. This usually means the LLM got into an infinite loop of tool calls or the MCP server is slow.

**Root causes:**
1. **Too many search attempts** — the LLM keeps calling search tools with different terms
2. **Slow MCP server** — each tool call takes too long
3. **Circular reasoning** — the LLM calls tools that tell it to call other tools

**Fix:** The answerer prompt already limits search calls to 3. If the MCP server is slow, check the server's performance. For circular reasoning, improve tool descriptions to clarify the workflow.

## Why are questions using fake entity names?

The question generator (Sonnet) will hallucinate plausible-but-wrong entity names if not given real data. For example, generating "Add 2 Hefeweizen" when the actual product is "Appenzeller Weissbier".

**Fix:** Implement the `prefetch` function in your `evolve.config.mjs`. This calls your MCP server (via Haiku, for speed) to fetch real entity names, which are then fed to the question generator.

## Why are relative-date grades inconsistent?

This usually means the answerer and grader are interpreting phrases like "next Friday" differently. The fix is to use the run-level date anchoring settings in `evolve.config.mjs`: `timeZone`, `referenceNow`, `nextWeekdayMode`, and `relativeDateRules`.

mcp-evolve now computes one shared date context per run and passes the same resolved dates to both the answerer and the grader. If your MCP tool only accepts dates, keep the canonical values in `YYYY-MM-DD` form. Do not switch to timestamps unless the MCP schema actually requires time-of-day precision.

## Why is action completion N/A?

The action completion rate shows N/A when no questions in the run were detected as action requests. This happens when:
- All questions were read-only (informational queries)
- The ACTION_PATTERN regex didn't match the verbs used in questions
- The persona's question style doesn't include action commands

This is normal for analytical personas (accountant, viewer). It's a concern for operational personas (waiter, admin) — they should be generating action requests.

## Why does the fixer keep failing?

If the fix rate is low, check:
1. **srcDirs in config** — does the fixer know where your source code is?
2. **Tool access** — the fixer uses `Read,Edit,Grep,Glob,Bash` by default. Make sure these aren't restricted.
3. **Build command** — if `buildCommand` is wrong, the replay after fix will use the old (broken) code
4. **Error is deeper than descriptions** — the surface fixer only edits tool descriptions/schemas. If the bug is in the backend handler, the fixer might not find it. The deep fix (`deepFix` in run.mjs) goes further but needs more context.

## Why are eval personas failing but train personas pass?

This is the train/eval split working correctly. It means the fixer's improvements on train personas haven't fully generalized to the eval hold-out set. This is expected early on — generalization improves as tool descriptions become more comprehensive.

If eval consistently fails where train passes, it might mean the fixer is overfitting to the specific question patterns of train personas rather than making broad improvements.

## What if the MCP server connection fails?

Check:
1. `mcp-evolve.json` — is the server command and args correct?
2. Is the server running? (If it needs a separate process, start it first)
3. Environment variables — does the server need auth tokens, API keys, or emulator config?
4. Try running the server command manually to see errors

If your setup needs a stronger readiness check than "the process starts", add a `healthcheck` hook in `evolve.config.mjs`. That lets you verify real prerequisites before the run is allowed to affect baselines or metrics.

## What does "invalid run" mean?

An invalid run means the harness itself was not in a trustworthy state. Common causes:

1. **Healthcheck failed** — the project wasn't ready after `seed()`
2. **Configured MCP tools disappeared** — the answerer started using unrelated tools like LSP instead of the server under test

Invalid runs are quarantined. They still produce a log file, but they do not update baselines, golden-set health, metrics, or escalation state.

## What if no questions are generated?

Check:
1. **Claude CLI** — is `claude` accessible in your PATH?
2. **API key** — is your Anthropic API key valid?
3. **Persona descriptions** — are they detailed enough for Sonnet to generate questions?
4. **Rate limits** — you might be hitting API rate limits

Try `mcp-evolve --dry-run --persona <id> --limit 1 -v` for verbose output.
