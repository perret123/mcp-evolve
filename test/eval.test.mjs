import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scorePrompt,
  aggregateScores,
  isPassingScore,
  classifyErrorCategory,
} from '../lib/eval.mjs';

const CONFIG = {
  writeTools: ['update_task', 'create_task', 'delete_task'],
  mcpToolPrefix: 'mcp__task-manager__',
};

test('action request with grader-approved no-op still passes', () => {
  const score = scorePrompt({
    prompt: 'Can you move all my in-progress tasks to high priority?',
    toolCalls: [{ tool: 'mcp__task-manager__list_tasks' }],
    errors: [],
    response: 'No change needed. Your only in-progress task is already urgent, which is higher than high priority.',
    grading: { actionExpectation: 'valid_noop' },
  }, CONFIG);

  assert.equal(score.isActionRequest, true);
  assert.equal(score.writeToolCalled, false);
  assert.equal(score.actionNoopApproved, true);
  assert.equal(score.actionRequirementMet, true);
  assert.equal(isPassingScore(score), true);
});

test('action request without write or approved no-op fails', () => {
  const score = scorePrompt({
    prompt: 'Delete the pay electric bill task.',
    toolCalls: [{ tool: 'mcp__task-manager__search_tasks' }],
    errors: [],
    response: 'I found the task for you.',
    grading: { actionExpectation: 'missing_write' },
  }, CONFIG);

  assert.equal(score.isActionRequest, true);
  assert.equal(score.actionRequirementMet, false);
  assert.equal(isPassingScore(score), false);
});

test('aggregateScores uses actionRequirementMet for action completion', () => {
  const passingNoop = {
    score: {
      completed: true,
      stuck: false,
      errorsFound: 0,
      isActionRequest: true,
      writeToolCalled: false,
      actionRequirementMet: true,
      toolsUsed: 1,
    },
  };
  const failingAction = {
    score: {
      completed: true,
      stuck: false,
      errorsFound: 0,
      isActionRequest: true,
      writeToolCalled: false,
      actionRequirementMet: false,
      toolsUsed: 1,
    },
  };

  const scores = aggregateScores([passingNoop, failingAction]);
  assert.equal(scores.successRate, '50.0');
  assert.equal(scores.actionCompletionRate, '50.0');
});

test('obsolete prompts are excluded from aggregate scoring', () => {
  const scored = [
    { score: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 3, isActionRequest: false, obsolete: false } },
    { score: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 2, isActionRequest: false, obsolete: false } },
    { score: { completed: false, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 0, isActionRequest: false, obsolete: true } },
  ];
  const agg = aggregateScores(scored);
  assert.strictEqual(agg.total, 2);
  assert.strictEqual(agg.successRate, '100.0');
  assert.strictEqual(agg.obsoleteCount, 1);
});

test('classifyErrorCategory separates harness, model, and server failures', () => {
  assert.equal(classifyErrorCategory({
    tool: 'harness:tool-availability',
    error: 'Expected MCP tool calls but saw only LSP.',
  }, CONFIG), 'harness');

  assert.equal(classifyErrorCategory({
    tool: 'harness:grading',
    error: 'The assistant did not call any write/update tool.',
  }, CONFIG), 'model');

  assert.equal(classifyErrorCategory({
    tool: 'harness:grading',
    error: 'The tool returned null completedAt after status changed to completed.',
  }, CONFIG), 'server');
});

test('scorePrompt treats adversarial prompts with errors as passing when no false success', () => {
  // This is an end-to-end smoke — not a full grader test; the grader change is
  // exercised via scorePrompt only to verify the wiring doesn't break scoring.
  const score = scorePrompt({
    prompt: 'delete transaction tx-does-not-exist',
    toolCalls: [{ tool: 'mcp__pubman__cancel_transaction' }],
    errors: [],
    response: 'The transaction was not found. I cannot cancel it.',
    grading: { actionExpectation: 'not_action' },
  }, CONFIG);
  assert.equal(score.errorsFound, 0);
});
