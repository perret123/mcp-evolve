# Obsolete Question Marking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the grader mark questions as obsolete when their preconditions aren't met (e.g., referenced entity no longer exists), permanently skipping them from future runs.

**Architecture:** The grader returns a new `questionStatus` field ("valid" or "obsolete"). Obsolete questions are marked in question-set.json / golden-set.json and filtered out before execution — same pattern as existing `blocked` questions. Aggregate scoring excludes obsolete results.

**Tech Stack:** Node.js ESM, existing mcp-evolve eval/run pipeline

---

### Task 1: Extend grader prompt with question validity criterion

**Files:**
- Modify: `prompts/grader.md`

- [ ] **Step 1: Add question validity criterion to grader prompt**

After the existing criterion 5 (Metamorphic invariant), add criterion 6 in `prompts/grader.md`:

```markdown
6. **Question validity**: If the question references data that doesn't exist, assumes state that isn't true, or can't be meaningfully answered because the underlying data has changed, use `questionStatus: "obsolete"` instead of failing. Obsolete means "this question no longer applies to the current data" — not "the server handled it wrong."
   Examples of obsolete: "delete task-001" but task-001 doesn't exist in the data. "Show Mia's tasks" but Mia has never been mentioned.
   NOT obsolete: "delete task-001" and the server says success but didn't actually delete it — that's a real bug, fail it normally.
   If no validity concern, use `questionStatus: "valid"`.
```

- [ ] **Step 2: Update the JSON output examples**

Change the two example JSON blocks. The passing example becomes:

```json
{"pass": true, "actionExpectation": "not_action", "invariantResult": "held", "questionStatus": "valid"}
```

The failing example becomes:

```json
{"pass": false, "issues": ["specific issue 1", "specific issue 2"], "actionExpectation": "missing_write", "invariantResult": "violated", "questionStatus": "valid"}
```

And add a third example for obsolete:

```json
{"pass": false, "issues": ["Question references task-001 which does not exist in the data"], "questionStatus": "obsolete"}
```

- [ ] **Step 3: Commit**

```bash
git add prompts/grader.md
git commit -m "feat(grader): add questionStatus field for obsolete question detection"
```

---

### Task 2: Extract questionStatus in gradeAnswer()

**Files:**
- Modify: `lib/run.mjs:386-400` (gradeAnswer normalized response)

- [ ] **Step 1: Add questionStatus to the normalized grading result**

In `lib/run.mjs`, inside `gradeAnswer()`, find the `normalized` object (around line 398):

```js
const normalized = {
  pass: !!grade.pass,
  issues: Array.isArray(grade.issues) ? grade.issues : [],
  actionExpectation: grade.actionExpectation || (
    isAction
      ? (writeToolCalled ? 'write_performed' : 'missing_write')
      : 'not_action'
  ),
  invariantResult: grade.invariantResult || 'skipped',
};
```

Add `questionStatus`:

```js
const normalized = {
  pass: !!grade.pass,
  issues: Array.isArray(grade.issues) ? grade.issues : [],
  actionExpectation: grade.actionExpectation || (
    isAction
      ? (writeToolCalled ? 'write_performed' : 'missing_write')
      : 'not_action'
  ),
  invariantResult: grade.invariantResult || 'skipped',
  questionStatus: grade.questionStatus || 'valid',
};
```

- [ ] **Step 2: In answerAndGrade(), skip fixer errors when obsolete**

In `answerAndGrade()` (around line 857), after the grading block that pushes errors from `grading.issues`, add a check: if the question is obsolete, clear all errors so it doesn't enter the fix pipeline:

After:
```js
      if (grading?.issues?.length > 0) {
        for (const issue of grading.issues) {
          result.errors.push({
            tool: isOutputTruncationIssue(issue) ? 'harness:output-truncation' : 'harness:grading',
            input: { question: qText },
            error: issue,
          });
        }
      }
```

Add:
```js
      // Obsolete questions don't trigger the fixer
      if (grading?.questionStatus === 'obsolete') {
        result.errors = [];
        result.obsolete = true;
        result.obsoleteReason = grading.issues?.[0] || 'question no longer valid for current data';
      }
```

- [ ] **Step 3: Commit**

```bash
git add lib/run.mjs
git commit -m "feat(run): extract questionStatus from grader, skip fixer for obsolete"
```

---

### Task 3: Handle obsolete in scoreQuestion and aggregateScores

**Files:**
- Modify: `lib/eval.mjs:130-181`
- Modify: `test/eval.test.mjs`

- [ ] **Step 1: Add test for obsolete scoring**

Add to `test/eval.test.mjs`:

```js
test('obsolete questions are excluded from aggregate scoring', () => {
  const scored = [
    { score: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 3, isActionRequest: false, obsolete: false } },
    { score: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 2, isActionRequest: false, obsolete: false } },
    { score: { completed: false, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 0, isActionRequest: false, obsolete: true } },
  ];
  const agg = aggregateScores(scored);
  assert.strictEqual(agg.total, 2); // obsolete excluded
  assert.strictEqual(agg.successRate, '100.0');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/eval.test.mjs
```

Expected: FAIL — `aggregateScores` currently counts all 3 questions.

- [ ] **Step 3: Update scoreQuestion to carry obsolete flag**

In `lib/eval.mjs`, `scoreQuestion()` (line 130), add `obsolete` to the return. After line 143 (`const completed = ...`), the return object gets a new field:

```js
return {
  completed,
  errorsFound: mcpErrors.length,
  debugLogErrors: debugLogErrors.length,
  stuck,
  toolsUsed: toolNames.length,
  isActionRequest: isAction,
  writeToolCalled,
  actionNoopApproved,
  actionRequirementMet,
  timedOut,
  obsolete: !!questionResult.obsolete,
};
```

- [ ] **Step 4: Update aggregateScores to exclude obsolete**

In `lib/eval.mjs`, `aggregateScores()` (line 163), filter out obsolete before counting:

```js
export function aggregateScores(scoredQuestions) {
  const active = scoredQuestions.filter(q => !q.score.obsolete);
  const total = active.length;
  if (total === 0) return { total: 0, successRate: 0, actionCompletionRate: 0, errorRate: 0, avgTools: 0, obsoleteCount: scoredQuestions.length - active.length };

  const successes = active.filter(q => isPassingScore(q.score));
  const actionRequests = active.filter(q => q.score.isActionRequest);
  const actionsCompleted = actionRequests.filter(q => q.score.actionRequirementMet);
  const totalErrors = active.reduce((s, q) => s + q.score.errorsFound, 0);
  const totalTools = active.reduce((s, q) => s + q.score.toolsUsed, 0);

  return {
    total,
    successRate: (successes.length / total * 100).toFixed(1),
    actionCompletionRate: actionRequests.length > 0
      ? (actionsCompleted.length / actionRequests.length * 100).toFixed(1)
      : 'N/A',
    errorRate: (totalErrors / total).toFixed(2),
    avgTools: (totalTools / total).toFixed(1),
    obsoleteCount: scoredQuestions.length - active.length,
  };
}
```

- [ ] **Step 5: Run tests**

```bash
node --test test/eval.test.mjs
```

Expected: All tests pass including the new one.

- [ ] **Step 6: Commit**

```bash
git add lib/eval.mjs test/eval.test.mjs
git commit -m "feat(eval): exclude obsolete questions from aggregate scoring"
```

---

### Task 4: Mark obsolete questions in question set and golden set

**Files:**
- Modify: `lib/eval.mjs:515-545` (updateQuestionSetAfterRun)
- Modify: `lib/eval.mjs:439-471` (updateGoldenHealth)

- [ ] **Step 1: Mark obsolete in updateQuestionSetAfterRun**

In `lib/eval.mjs`, `updateQuestionSetAfterRun()` (line 515), inside the loop that checks each question result, after the `if (passed)` / `else` block, add obsolete handling:

```js
    if (passed) {
      q.consecutivePasses = (q.consecutivePasses || 0) + 1;
      if (q.group === 'train' && q.consecutivePasses >= (config.graduationStreak || 10)) {
        q.group = 'golden';
        q.graduatedAt = new Date().toISOString();
        graduated.push(q);
      }
    } else {
      q.consecutivePasses = 0;
    }

    // Mark obsolete if grader flagged it
    if (match && match.obsolete && !q.obsolete) {
      q.obsolete = true;
      q.obsoleteAt = new Date().toISOString();
      q.obsoleteReason = match.obsoleteReason || 'question no longer valid';
    }
```

Where `match` is the question result found earlier in the loop. The variable already exists — it's the `const match = r.questions.find(...)` at line 521.

- [ ] **Step 2: Mark obsolete in updateGoldenHealth**

In `lib/eval.mjs`, `updateGoldenHealth()` (line 439), inside the loop over golden questions, after the `if (passed) { ... } else { ... }` block, add:

```js
    // Mark obsolete if grader flagged it
    if (qResult && qResult.obsolete && !gq.obsolete) {
      gq.obsolete = true;
      gq.obsoleteAt = new Date().toISOString();
      gq.obsoleteReason = qResult.obsoleteReason || 'question no longer valid';
    }
```

- [ ] **Step 3: Commit**

```bash
git add lib/eval.mjs
git commit -m "feat(eval): mark obsolete questions in question set and golden set"
```

---

### Task 5: Filter out obsolete questions before execution

**Files:**
- Modify: `lib/run.mjs` (fixed-sets mode ~line 924, legacy mode ~line 960)

- [ ] **Step 1: Filter obsolete in fixed-sets mode**

In `lib/run.mjs`, the fixed-sets question filter (around line 924):

```js
const questionsToRun = questionSet.questions.filter(q => selectedIds.has(q.persona));
```

Change to:

```js
const questionsToRun = questionSet.questions.filter(q => selectedIds.has(q.persona) && !q.obsolete);
```

- [ ] **Step 2: Filter obsolete in legacy mode golden questions**

In `lib/run.mjs`, the golden set filter (around line 960):

```js
const goldenForPersona = goldenSet.questions.filter(q => q.persona === persona.id && !q.blocked);
```

Change to:

```js
const goldenForPersona = goldenSet.questions.filter(q => q.persona === persona.id && !q.blocked && !q.obsolete);
```

- [ ] **Step 3: Filter obsolete in golden health check**

In `lib/run.mjs`, the active golden filter (around line 830):

```js
const activeGolden = goldenSet.questions.filter(q => !q.blocked);
```

Change to:

```js
const activeGolden = goldenSet.questions.filter(q => !q.blocked && !q.obsolete);
```

- [ ] **Step 4: Log obsolete count**

After the scoring summary (around line 1307), add a log line when there are obsolete questions:

```js
if (allScores.obsoleteCount > 0) {
  log(`  Obsolete: ${allScores.obsoleteCount} question(s) marked obsolete (excluded from scoring)`);
}
```

- [ ] **Step 5: Run all tests**

```bash
node --test test/*.mjs
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/run.mjs
git commit -m "feat(run): filter obsolete questions from execution and scoring"
```

---

### Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add obsolete marking to Key Design Decisions**

Add to the Key Design Decisions section:

```markdown
- **Grader can mark questions obsolete** — when preconditions aren't met (entity deleted, data drifted), question is permanently skipped
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add obsolete question marking to design decisions"
```
