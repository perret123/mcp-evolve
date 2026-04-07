import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreQuestion,
  aggregateScores,
  isPassingScore,
  classifyErrorCategory,
} from '../lib/eval.mjs';

const CONFIG = {
  writeTools: ['update_task', 'create_task', 'delete_task'],
  mcpToolPrefix: 'mcp__task-manager__',
};

test('action request with grader-approved no-op still passes', () => {
  const score = scoreQuestion({
    question: 'Can you move all my in-progress tasks to high priority?',
    toolCalls: [{ tool: 'mcp__task-manager__list_tasks' }],
    errors: [],
    answer: 'No change needed. Your only in-progress task is already urgent, which is higher than high priority.',
    grading: { actionExpectation: 'valid_noop' },
  }, CONFIG);

  assert.equal(score.isActionRequest, true);
  assert.equal(score.writeToolCalled, false);
  assert.equal(score.actionNoopApproved, true);
  assert.equal(score.actionRequirementMet, true);
  assert.equal(isPassingScore(score), true);
});

test('action request without write or approved no-op fails', () => {
  const score = scoreQuestion({
    question: 'Delete the pay electric bill task.',
    toolCalls: [{ tool: 'mcp__task-manager__search_tasks' }],
    errors: [],
    answer: 'I found the task for you.',
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
