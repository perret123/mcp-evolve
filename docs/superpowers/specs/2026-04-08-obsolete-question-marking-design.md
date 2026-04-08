# Obsolete Question Marking

## Context

In reset-free continuous running, data evolves naturally. Questions that reference deleted entities, assume stale state, or have unmet preconditions become unanswerable. Currently these show up as failures, wasting fixer time on problems that aren't server bugs.

With metamorphic testing (before/after probes), the grader already sees the data state. It can distinguish "the server is broken" from "the question no longer makes sense."

## Design

### Grader returns `questionStatus`

The grader already returns `{pass, issues, actionExpectation, invariantResult}`. Add:

```js
questionStatus: "valid" | "obsolete"
```

- `"valid"` — question's preconditions were met, grade normally (default)
- `"obsolete"` — question's preconditions weren't met. The data has drifted: referenced entity doesn't exist, assumed state is wrong, invariant can't be evaluated.

The grader prompt gets a new section:

```markdown
6. **Question validity**: If the question references data that doesn't exist, assumes state
   that isn't true, or can't be meaningfully answered because the underlying data has changed,
   use `questionStatus: "obsolete"` instead of failing. Obsolete means "this question no longer
   applies to the current data" — not "the server handled it wrong."
   Examples of obsolete: "delete task-001" but task-001 doesn't exist. "Show Mia's tasks" but
   Mia has no tasks and was never mentioned in the data.
   NOT obsolete: "delete task-001" and the server says success but didn't actually delete it
   — that's a real bug, fail it normally.
```

Grader JSON output adds `questionStatus`:

```json
{"pass": true, "actionExpectation": "not_action", "invariantResult": "held", "questionStatus": "valid"}
{"pass": false, "issues": ["..."], "questionStatus": "obsolete"}
```

### Downstream handling

When `questionStatus === "obsolete"`:

1. **`scoreQuestion`** — treat as skipped, not failed. New field: `obsolete: true`.
2. **`isPassingScore`** — obsolete questions return `false` but are excluded from aggregate scoring.
3. **Question set / golden set** — mark the entry: `{ obsolete: true, obsoleteAt: timestamp, obsoleteReason: issues[0] }`.
4. **Never run again** — obsolete questions are filtered out before execution, same as `blocked` questions today.
5. **No fixer** — obsolete questions never enter the fix pipeline.
6. **No streak impact** — obsolete questions are excluded from success rate calculations. A run with 10 questions, 2 obsolete, 8 passing = 100%.
7. **No replacement** — the existing escalation/graduation flow naturally fills gaps over time.

### Files changed

- `prompts/grader.md` — add question validity criterion + `questionStatus` to JSON output
- `lib/run.mjs` `gradeAnswer()` — extract `questionStatus` from grader response
- `lib/run.mjs` `answerAndGrade()` — when grading returns `obsolete`, attach to result
- `lib/eval.mjs` `scoreQuestion()` — set `obsolete: true` on score when grading says so
- `lib/eval.mjs` `isPassingScore()` — no change (obsolete returns false, but callers filter)
- `lib/eval.mjs` `aggregateScores()` — exclude obsolete from success rate
- `lib/eval.mjs` `updateQuestionSetAfterRun()` — mark obsolete entries, reset consecutive passes
- `lib/eval.mjs` `updateGoldenHealth()` — mark obsolete golden questions
- `lib/run.mjs` fixed-sets mode — filter out `q.obsolete` before running
- `lib/run.mjs` legacy mode — filter out obsolete golden questions

### Verification

1. Manually craft a question referencing a nonexistent entity in the task-manager
2. Run it — grader should return `questionStatus: "obsolete"`
3. Verify it's marked obsolete in question-set.json
4. Run again — verify the obsolete question is skipped entirely
5. Verify success rate excludes the obsolete question
