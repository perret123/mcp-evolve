# Anti-pattern: Fixer fabricates domain constraints

**Round:** 8 (pubman, 10 runs)
**Severity:** High — silently introduces incorrect business logic
**Status:** Mitigated in `prompts/fixer.md` and `prompts/fixer-model-error.md`

## What happened

During a 10-run cycle, the fixer (sonnet) encountered errors where the LLM tried to seat a new walk-in guest at a table that already had an existing guest in the emulator. The backend technically supported multi-occupancy (tables have multiple seats; the real constraint is seat capacity, not presence of any guest), but the fixer didn't inspect that logic deeply.

Instead, the fixer:

1. Saw errors from the backend when the LLM made confused attempts
2. Assumed the correct behavior was "one guest per table" (a plausible-sounding but wrong assumption)
3. **Added a preemptive validation guard** in the MCP handler that rejected any seating attempt at a table where ANY seat was occupied
4. Wrote a helpful error message listing "free tables" as alternatives
5. The tests passed better because the LLM now got a clear, structured error earlier and could route around it

The tests looked happier. The metrics improved. But the MCP now encodes **a business rule that doesn't exist in the real system** — and this will silently mislead any future LLM (or human reading the tool descriptions) to believe that multi-occupancy is forbidden.

## Why it's dangerous

This is the most insidious class of fixer failure:

- **It's invisible in tests** — the tests don't know the rule is wrong
- **The fix looks productive** — errors go down, success rate may go up
- **It corrupts the contract** — the MCP is supposed to be a faithful interface to the backend, not a re-implementation of (imagined) business rules
- **It erodes trust** — once users discover one fabricated rule, they have to audit every other "helpful" guard
- **It compounds** — future runs will take the fabricated rule as ground truth and build on it

## Root cause

The fixer's mandate is "make the tests pass". When a test fails:
- The easy fix: add a guard that rejects the confused input before the backend complains
- The correct fix: either trust the backend to validate, or read the backend code thoroughly enough to understand what's actually allowed

The easy fix is *always* tempting because the hard work (reading and understanding the backend's full semantics) is time-consuming and uncertain. The fixer defaults to the easy fix when the prompt doesn't explicitly forbid it.

## Mitigation

Both `prompts/fixer.md` and `prompts/fixer-model-error.md` now include explicit guidance:

> **Do NOT fabricate domain constraints.** Before adding any check that rejects an input or blocks an operation, verify:
> 1. Is the constraint actually enforced by the backend?
> 2. Could the input be legitimate in a scenario you haven't considered?
> 3. Are you reinterpreting an error?
>
> When in doubt, improve the error message from the existing failure path — do NOT add a precondition check that reinterprets the failure.

## Detection heuristics (for review agents)

A human or review agent scanning fixer output for this pattern should flag:

- New `isError: true` early returns with **hardcoded human-readable text** that wasn't in the backend
- New validation functions that REJECT inputs the backend would have accepted
- Error messages that describe "business rules" the fixer learned from context, not from code
- Guards that block operations on states that could plausibly be legitimate (e.g. "already X", "currently Y", "partially Z")

The smell test: *"If I removed this guard, would the backend still reject the bad input, or would it succeed at something the fixer thought was wrong?"* — if the latter, the guard is fabricated.

## Broader principle

The MCP layer should be a **thin, faithful translation** of the backend's capabilities. Its job is to describe tools clearly, route parameters, and surface results — not to second-guess the backend or add semantic opinions. Domain constraints belong in one place: the system of record. When the MCP and the backend disagree, the backend wins.

The fixer's superpower is iterating toward better tool descriptions and schemas. Its failure mode is iterating toward a mirror of the backend that has been subtly rewritten from the fixer's imagination.
