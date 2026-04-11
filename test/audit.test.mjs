import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAuditDecisions } from '../lib/audit.mjs';

function makeCfg() {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  return {
    failingPromptsPath: join(dir, 'failing-prompts.json'),
    promptSetPath: join(dir, 'prompt-set.json'),
    _dir: dir,
  };
}

test('applyAuditDecisions marks prompts invalid and persists failing entries', () => {
  const cfg = makeCfg();
  try {
    writeFileSync(cfg.promptSetPath, JSON.stringify({ version: 1, prompts: [] }));

    const scoredPrompts = [
      { prompt: 'seat a walk-in at Tisch 5', persona: 'waiter-orders', group: 'train', score: { errorsFound: 2 } },
      { prompt: 'list orders', persona: 'waiter-orders', group: 'train', score: { errorsFound: 0 } },
    ];

    const reviewerOutput = {
      audits: [{
        branch: 'fix/waiter-orders-0-123',
        fixType: 'rejection_path',
        backendCheck: { performed: true, method: 'grep', evidence: ['fabricated'], conclusion: 'fabrication' },
        decision: 'reject',
        reason: 'fabrication',
      }],
      promptReviews: [{
        promptId: 'waiter-orders::seat a walk-in at Tisch 5',
        persona: 'waiter-orders',
        invariantStatus: 'contaminated',
        decision: 'drop',
        reason: 'invariant contradicts backend',
      }],
      parseErrors: [],
    };

    const branches = [{
      branchName: 'fix/waiter-orders-0-123',
      worktreePath: '/tmp/wt',
      slug: 'waiter-orders-0-123',
      fixableError: {
        persona: { id: 'waiter-orders' },
        prompt: 'seat a walk-in at Tisch 5',
        errors: [{ tool: 'mcp__x__seat', error: 'already occupied', category: 'server' }],
      },
    }];

    const result = applyAuditDecisions({
      reviewerOutput,
      branches,
      scoredPrompts,
      runId: '2026-04-11T18:00:00Z',
      config: cfg,
    });

    assert.equal(result.merged.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.droppedPrompts.length, 1);
    assert.equal(scoredPrompts[0].invalid, true);
    assert.equal(scoredPrompts[0].invalidReason, 'invariant contradicts backend');
    assert.equal(scoredPrompts[1].invalid, undefined);

    const failing = JSON.parse(readFileSync(cfg.failingPromptsPath, 'utf-8'));
    assert.equal(failing.entries.length, 1);
    assert.equal(failing.entries[0].persona, 'waiter-orders');
    assert.equal(failing.entries[0].reason, 'contaminated_invariant');
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('applyAuditDecisions removes golden prompt from prompt-set.json when dropped', () => {
  const cfg = makeCfg();
  try {
    writeFileSync(cfg.promptSetPath, JSON.stringify({
      version: 1,
      prompts: [
        { persona: 'waiter-orders', prompt: 'seat a walk-in at Tisch 5', group: 'golden', consecutivePasses: 5 },
        { persona: 'waiter-orders', prompt: 'list orders', group: 'golden', consecutivePasses: 3 },
      ],
    }));

    const scoredPrompts = [
      { prompt: 'seat a walk-in at Tisch 5', persona: 'waiter-orders', group: 'golden', score: { errorsFound: 1 } },
    ];

    const reviewerOutput = {
      audits: [],
      promptReviews: [{
        promptId: 'waiter-orders::seat a walk-in at Tisch 5',
        persona: 'waiter-orders',
        invariantStatus: 'contaminated',
        decision: 'drop',
        reason: 'invariant fabricated during Round 9',
      }],
      parseErrors: [],
    };

    applyAuditDecisions({
      reviewerOutput,
      branches: [],
      scoredPrompts,
      runId: '2026-04-11T18:00:00Z',
      config: cfg,
    });

    const ps = JSON.parse(readFileSync(cfg.promptSetPath, 'utf-8'));
    assert.equal(ps.prompts.length, 1);
    assert.equal(ps.prompts[0].prompt, 'list orders');
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('applyAuditDecisions counts merged and rejected branches', () => {
  const cfg = makeCfg();
  try {
    writeFileSync(cfg.promptSetPath, JSON.stringify({ version: 1, prompts: [] }));

    const reviewerOutput = {
      audits: [
        { branch: 'a', fixType: 'tool_description', backendCheck: { performed: false, method: 'grep', evidence: [], conclusion: 'legitimate' }, decision: 'merge', reason: 'ok' },
        { branch: 'b', fixType: 'rejection_path', backendCheck: { performed: true, method: 'read', evidence: ['x'], conclusion: 'fabrication' }, decision: 'reject', reason: 'bad' },
      ],
      promptReviews: [],
      parseErrors: [],
    };

    const branches = [
      { branchName: 'a', worktreePath: '/tmp/a', slug: 'a', fixableError: { persona: { id: 'p1' }, prompt: 'x', errors: [] } },
      { branchName: 'b', worktreePath: '/tmp/b', slug: 'b', fixableError: { persona: { id: 'p2' }, prompt: 'y', errors: [] } },
    ];

    const result = applyAuditDecisions({
      reviewerOutput, branches, scoredPrompts: [], runId: 'r', config: cfg,
    });

    assert.equal(result.merged.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.merged[0].branchName, 'a');
    assert.equal(result.rejected[0].branchName, 'b');
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('applyAuditDecisions defaults to reject when branch missing from AUDIT output', () => {
  const cfg = makeCfg();
  try {
    writeFileSync(cfg.promptSetPath, JSON.stringify({ version: 1, prompts: [] }));

    const branches = [
      { branchName: 'missing-from-audit', worktreePath: '/tmp/x', slug: 'x', fixableError: { persona: { id: 'p' }, prompt: 'p', errors: [] } },
    ];

    const result = applyAuditDecisions({
      reviewerOutput: { audits: [], promptReviews: [], parseErrors: [] },
      branches,
      scoredPrompts: [],
      runId: 'r',
      config: cfg,
    });

    assert.equal(result.merged.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0].reason, /missing from AUDIT/);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});
