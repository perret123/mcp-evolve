# Golden Set Curation

## When should I add a question to the golden set?

Add a question when it tests something important that should never break:

1. **A question that found a real bug** — after the fixer resolved it, promote it so it never regresses
2. **A critical workflow** — core user journeys that must always work (e.g., "create a record", "process a payment")
3. **An edge case that was hard to find** — if it took the escalator or manual investigation to discover, it's worth preserving
4. **A cross-tool chain** — multi-step workflows that exercise tool interplay

Questions are automatically promoted when: a question fails → fixer edits code → rebuild → replay passes → promoted.

## When should I remove a question from the golden set?

Remove a question when:

1. **The feature was removed** — the tool or workflow no longer exists
2. **The question is redundant** — another golden question tests the same code path
3. **The question uses stale data** — references entities that no longer exist in the test environment
4. **It's been passing for 10+ consecutive runs** without any code changes in its area — it may be testing something that's inherently stable

Be conservative — the cost of keeping a question (a few seconds of test time) is much lower than the cost of missing a regression.

## What makes a good golden set question?

A good golden question:
- **Tests a specific code path** — not vague, targets a concrete tool/parameter/workflow
- **Requires 2+ tool calls** — exercises chaining, not just a single read
- **Uses real entity names** — from the prefetch, not hallucinated
- **Is written in persona voice** — "Add 2 Espresso to table 5" not "Test the create_guest_products tool"
- **Has a clear pass/fail signal** — you can tell from the score whether it worked

A bad golden question:
- "Does the system work?" — too vague
- "Call get_menu_data with search=Beer" — too technical, not persona-voiced
- References entities that might not exist in the test environment

## How big should the golden set be?

Default max is 50 questions. In practice:

| Size | Status |
|------|--------|
| **0-5** | Just starting — running the loop will naturally grow it |
| **5-20** | Healthy development phase — good coverage growing |
| **20-40** | Mature — broad coverage across personas and tools |
| **40-50** | Near capacity — consider retiring stale questions |
| **50** | At max — oldest questions rotate out when new ones are added |

The golden set should cover all clusters (persona groups) and both read and write tools. Check coverage with `get_tool_coverage`.

## How do I validate a new persona before adding it?

Use the `validate_new_persona` tool or the `validateNewPersona()` function:

1. **Check cluster** — does a similar persona already exist?
   - New cluster → always valid
   - Same cluster → MBTI must differ from existing personas
2. **Check MBTI** — is the type unique within the cluster?
3. **Start as train** — so the fixer can learn from the persona's failures
4. **Run a few cycles** — see if the persona generates productive failures
5. **Move to eval** — once the system handles the persona well, switch to eval for hold-out measurement

## What's the difference between a stale golden question and a stale persona?

- **Stale golden question**: A specific question that has passed 10+ consecutive runs without code changes in its area. It might be testing something inherently stable — consider retiring it to make room.
- **Stale persona**: A persona that hasn't found ANY failure across multiple runs. The persona itself needs refreshing — updated concerns, harder question style, or new topics.

Both are detected by `/steer` and the metrics store.
