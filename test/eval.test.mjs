import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scorePrompt,
  aggregateScores,
  isPassingScore,
  classifyErrorCategory,
  overfittingDetection,
  saveBaseline,
  loadBaseline,
} from '../lib/eval.mjs';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('aggregateScores reads scorePre when scoreField = "scorePre"', () => {
  const scored = [
    {
      scorePre:  { completed: true,  errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 2, isActionRequest: false, obsolete: false },
      scorePost: { completed: true,  errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 3, isActionRequest: false, obsolete: false },
      score:     { completed: true,  errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 3, isActionRequest: false, obsolete: false },
    },
    {
      scorePre:  { completed: false, errorsFound: 2, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false },
      scorePost: { completed: true,  errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 4, isActionRequest: false, obsolete: false },
      score:     { completed: true,  errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 4, isActionRequest: false, obsolete: false },
    },
  ];
  const pre = aggregateScores(scored, 'scorePre');
  const post = aggregateScores(scored, 'scorePost');
  assert.equal(pre.successRate, '50.0');
  assert.equal(post.successRate, '100.0');
});

test('aggregateScores falls back to q.score when the chosen field is missing', () => {
  const scored = [
    {
      score: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 2, isActionRequest: false, obsolete: false },
      // no scorePost
    },
  ];
  const agg = aggregateScores(scored, 'scorePost');
  assert.equal(agg.total, 1);
  assert.equal(agg.successRate, '100.0');
});

test('overfittingDetection flags when train improves and holdout decays by more than threshold', () => {
  const result = overfittingDetection({
    trainPre:  { total: 6, successRate: '50.0' },
    trainPost: { total: 6, successRate: '80.0' },
    holdoutPre:  { total: 3, successRate: '66.6' },
    holdoutPost: { total: 3, successRate: '33.3' },
    threshold: 0.1,
  });
  assert.equal(result.detected, true);
  assert.ok(result.trainDelta > 0.1);
  assert.ok(result.holdoutDelta < -0.1);
});

test('overfittingDetection does NOT flag when both train and holdout improve', () => {
  const result = overfittingDetection({
    trainPre:  { total: 6, successRate: '50.0' },
    trainPost: { total: 6, successRate: '80.0' },
    holdoutPre:  { total: 3, successRate: '66.6' },
    holdoutPost: { total: 3, successRate: '100.0' },
    threshold: 0.1,
  });
  assert.equal(result.detected, false);
});

test('overfittingDetection surfaces per-persona divergences when holdout regresses and train improves', () => {
  const goodPre = { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false };
  const badPre = { completed: true, errorsFound: 2, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false };
  const perPromptPairs = [
    { persona: 'waiter', prompt: 'seat at Tisch 5', evaluation: 'holdout', scorePre: goodPre, scorePost: badPre },
    { persona: 'waiter', prompt: 'seat at Tisch 3', evaluation: 'fixer',   scorePre: badPre,  scorePost: goodPre },
  ];
  const result = overfittingDetection({
    trainPre:  { total: 3, successRate: '33.3' },
    trainPost: { total: 3, successRate: '66.6' },
    holdoutPre:  { total: 1, successRate: '100.0' },
    holdoutPost: { total: 1, successRate: '0.0' },
    perPromptPairs,
    threshold: 0.1,
  });
  assert.equal(result.detected, true);
  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].persona, 'waiter');
  assert.equal(result.divergences[0].holdoutRegressed.length, 1);
  assert.equal(result.divergences[0].trainImproved.length, 1);
});

test('saveBaseline writes version: 2 with scorePre and scorePost per prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-'));
  try {
    const config = { baselinesDir: dir };
    const pre = { completed: false, errorsFound: 2, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false };
    const post = { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 2, isActionRequest: false, obsolete: false };
    const results = [{
      persona: { id: 'p1' },
      prompts: [{
        prompt: 'seat at Tisch 5',
        promptObj: { lifecycle: 'train', evaluation: 'fixer', probe: 'x', invariant: 'y' },
        scorePre: pre,
        scorePost: post,
        score: post,
      }],
    }];
    const path = saveBaseline(results, 'sonnet', config);
    const loaded = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(loaded.version, 2);
    assert.equal(loaded.prompts.length, 1);
    assert.equal(loaded.prompts[0].lifecycle, 'train');
    assert.equal(loaded.prompts[0].evaluation, 'fixer');
    assert.deepEqual(loaded.prompts[0].scorePre, pre);
    assert.deepEqual(loaded.prompts[0].scorePost, post);
    // `score` alias stays for legacy consumers
    assert.deepEqual(loaded.prompts[0].score, post);
    // `group` field must be gone
    assert.equal('group' in loaded.prompts[0], false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadBaseline normalizes v1 baselines (score only) into scorePost form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-v1-'));
  try {
    const v1 = {
      timestamp: '2026-04-01T00:00:00Z',
      answererModel: 'sonnet',
      prompts: [{
        persona: 'p1',
        group: 'train',
        prompt: 'old prompt',
        score: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false },
      }],
    };
    const file = join(dir, 'baseline-2026-04-01-00-00-00.json');
    writeFileSync(file, JSON.stringify(v1));
    const cfg = { baselinesDir: dir };
    const loaded = loadBaseline(file, cfg);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.prompts[0].scorePost.completed, true);
    assert.equal(loaded.prompts[0].scorePre, null);
    // lifecycle is synthesized from the legacy `group` field during normalization
    assert.equal(loaded.prompts[0].lifecycle, 'train');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
