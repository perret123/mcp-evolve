import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPromoterDecisions } from '../lib/promoter.mjs';

function makeCfg() {
  const dir = mkdtempSync(join(tmpdir(), 'promoter-'));
  return {
    promptSetPath: join(dir, 'prompt-set.json'),
    failingPromptsPath: join(dir, 'failing-prompts.json'),
    maxPromotionsPerRun: 3,
    _dir: dir,
  };
}

test('applyPromoterDecisions appends nominated candidates to prompt-set as golden', () => {
  const cfg = makeCfg();
  try {
    writeFileSync(cfg.promptSetPath, JSON.stringify({ version: 2, prompts: [] }));

    const candidates = [
      {
        persona: 'waiter',
        prompt: 'seat a walk-in at Tisch 3',
        promptObj: {
          prompt: 'seat a walk-in at Tisch 3',
          probe: 'list guests at table 3',
          invariant: 'multi-occupancy supported',
          probeType: 'action',
          adversarial: false,
          lifecycle: 'train',
          evaluation: 'fixer',
        },
        scorePost: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 2, isActionRequest: true, obsolete: false },
      },
    ];

    const promoterOutput = {
      nominations: [{
        promptId: 'waiter::seat a walk-in at Tisch 3',
        capabilityTag: 'walk-in-seating',
        confidence: 'high',
        reason: 'Tests multi-occupancy walk-in path; no existing golden covers this',
      }],
      skipped: [],
      parseErrors: [],
    };

    const result = applyPromoterDecisions({
      promoterOutput, candidates, config: cfg, runId: '2026-04-11T20:00:00Z',
    });

    assert.equal(result.nominated.length, 1);
    assert.equal(result.skipped.length, 0);

    const ps = JSON.parse(readFileSync(cfg.promptSetPath, 'utf-8'));
    assert.equal(ps.prompts.length, 1);
    const g = ps.prompts[0];
    assert.equal(g.lifecycle, 'golden');
    assert.equal(g.evaluation, 'fixer');
    assert.equal(g.consecutivePasses, 1);
    assert.ok(g.promotedAt);
    assert.equal(g.promoterEvidence.capabilityTag, 'walk-in-seating');
    assert.equal(g.promoterEvidence.confidence, 'high');
    assert.equal(g.promoterEvidence.nominatedInRun, '2026-04-11T20:00:00Z');
    // probe/invariant/adversarial copied from the candidate's promptObj
    assert.equal(g.promptObj.probe, 'list guests at table 3');
    assert.equal(g.promptObj.invariant, 'multi-occupancy supported');
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('applyPromoterDecisions caps nominations at maxPromotionsPerRun', () => {
  const cfg = makeCfg();
  cfg.maxPromotionsPerRun = 2;
  try {
    writeFileSync(cfg.promptSetPath, JSON.stringify({ version: 2, prompts: [] }));
    const mk = (i) => ({
      persona: 'p',
      prompt: `candidate-${i}`,
      promptObj: { prompt: `candidate-${i}`, probe: 'p', invariant: 'i', probeType: 'read', adversarial: false, lifecycle: 'train', evaluation: 'fixer' },
      scorePost: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false },
    });
    const candidates = [mk(1), mk(2), mk(3), mk(4)];
    const promoterOutput = {
      nominations: candidates.map((c, i) => ({
        promptId: `p::candidate-${i + 1}`,
        capabilityTag: `tag-${i}`,
        confidence: 'high',
        reason: 'test',
      })),
      skipped: [],
      parseErrors: [],
    };
    const result = applyPromoterDecisions({ promoterOutput, candidates, config: cfg, runId: 'r' });
    assert.equal(result.nominated.length, 2);
    const ps = JSON.parse(readFileSync(cfg.promptSetPath, 'utf-8'));
    assert.equal(ps.prompts.length, 2);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('applyPromoterDecisions with maxPromotionsPerRun=0 nominates zero', () => {
  const cfg = makeCfg();
  cfg.maxPromotionsPerRun = 0;
  try {
    writeFileSync(cfg.promptSetPath, JSON.stringify({ version: 2, prompts: [] }));
    const candidates = [{
      persona: 'p',
      prompt: 'candidate-1',
      promptObj: { prompt: 'candidate-1', probe: 'p', invariant: 'i', probeType: 'read', adversarial: false, lifecycle: 'train', evaluation: 'fixer' },
      scorePost: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false },
    }];
    const promoterOutput = {
      nominations: [{ promptId: 'p::candidate-1', capabilityTag: 't', confidence: 'high', reason: 'r' }],
      skipped: [], parseErrors: [],
    };
    const result = applyPromoterDecisions({ promoterOutput, candidates, config: cfg, runId: 'r' });
    assert.equal(result.nominated.length, 0);
    const ps = JSON.parse(readFileSync(cfg.promptSetPath, 'utf-8'));
    assert.equal(ps.prompts.length, 0);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('applyPromoterDecisions skips candidates not present in the input list', () => {
  const cfg = makeCfg();
  try {
    writeFileSync(cfg.promptSetPath, JSON.stringify({ version: 2, prompts: [] }));
    const promoterOutput = {
      nominations: [{
        promptId: 'ghost::nonexistent prompt',
        capabilityTag: 'tag', confidence: 'high', reason: 'r',
      }],
      skipped: [],
      parseErrors: [],
    };
    const result = applyPromoterDecisions({
      promoterOutput, candidates: [], config: cfg, runId: 'r',
    });
    assert.equal(result.nominated.length, 0);
    assert.equal(result.unmatched.length, 1);
    const ps = JSON.parse(readFileSync(cfg.promptSetPath, 'utf-8'));
    assert.equal(ps.prompts.length, 0);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('applyPromoterDecisions does not duplicate an already-golden prompt', () => {
  const cfg = makeCfg();
  try {
    writeFileSync(cfg.promptSetPath, JSON.stringify({
      version: 2,
      prompts: [{
        persona: 'p',
        prompt: 'existing prompt',
        lifecycle: 'golden', evaluation: 'fixer',
        consecutivePasses: 3,
        promptObj: { prompt: 'existing prompt', probe: 'x', invariant: 'y', adversarial: false, lifecycle: 'golden', evaluation: 'fixer' },
      }],
    }));
    const candidates = [{
      persona: 'p', prompt: 'existing prompt',
      promptObj: { prompt: 'existing prompt', probe: 'x', invariant: 'y', adversarial: false, lifecycle: 'train', evaluation: 'fixer' },
      scorePost: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false },
    }];
    const promoterOutput = {
      nominations: [{ promptId: 'p::existing prompt', capabilityTag: 't', confidence: 'high', reason: 'r' }],
      skipped: [], parseErrors: [],
    };
    const result = applyPromoterDecisions({ promoterOutput, candidates, config: cfg, runId: 'r' });
    assert.equal(result.nominated.length, 0);
    assert.equal(result.duplicates.length, 1);
    const ps = JSON.parse(readFileSync(cfg.promptSetPath, 'utf-8'));
    // Still exactly 1 golden — no duplication.
    assert.equal(ps.prompts.length, 1);
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});

test('applyPromoterDecisions creates prompt-set file when missing', () => {
  const cfg = makeCfg();
  try {
    // Do NOT write prompt-set.json — simulates first run after init
    assert.equal(existsSync(cfg.promptSetPath), false);
    const candidates = [{
      persona: 'p', prompt: 'new golden',
      promptObj: { prompt: 'new golden', probe: 'p', invariant: 'i', probeType: 'read', adversarial: false, lifecycle: 'train', evaluation: 'fixer' },
      scorePost: { completed: true, errorsFound: 0, stuck: false, actionRequirementMet: true, toolsUsed: 1, isActionRequest: false, obsolete: false },
    }];
    const promoterOutput = {
      nominations: [{ promptId: 'p::new golden', capabilityTag: 't', confidence: 'high', reason: 'r' }],
      skipped: [], parseErrors: [],
    };
    applyPromoterDecisions({ promoterOutput, candidates, config: cfg, runId: 'r' });
    const ps = JSON.parse(readFileSync(cfg.promptSetPath, 'utf-8'));
    assert.equal(ps.version, 2);
    assert.equal(ps.prompts.length, 1);
    assert.equal(ps.prompts[0].lifecycle, 'golden');
  } finally {
    rmSync(cfg._dir, { recursive: true, force: true });
  }
});
