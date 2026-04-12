import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('loadConfig sets reviewerAuditEnabled default true', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'evolve-config-'));
  writeFileSync(join(tmp, 'evolve.config.mjs'), 'export default { personas: [], writeTools: ["x"], srcDirs: ["./x"] };');
  const cfg = await loadConfig(tmp, join(tmp, 'evolve.config.mjs'));
  assert.equal(cfg.reviewerAuditEnabled, true);
  assert.ok(cfg.reviewerTools.includes('Bash'));
  assert.equal(cfg.adversarialRatio, 0);
  assert.ok(cfg.failingPromptsPath.endsWith('failing-prompts.json'));
  // Spec 2: obsolete fields must be absent from defaults
  assert.equal(cfg.graduationStreak, undefined);
  assert.equal(cfg.goldenBlockThreshold, undefined);
  assert.equal(cfg.maxTrainPerRun, undefined);
  assert.equal(cfg.maxGoldenPerRun, undefined);
  rmSync(tmp, { recursive: true });
});

test('loadConfig sets Spec 2 defaults (holdoutPerPersona, overfittingThreshold, maxPromotionsPerRun, promoterModel)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'evolve-config-'));
  try {
    writeFileSync(join(tmp, 'evolve.config.mjs'),
      'export default { personas: [], writeTools: ["x"], srcDirs: ["./x"] };');
    const cfg = await loadConfig(tmp, join(tmp, 'evolve.config.mjs'));
    assert.equal(cfg.holdoutPerPersona, 1);
    assert.equal(cfg.overfittingThreshold, 0.1);
    assert.equal(cfg.maxPromotionsPerRun, 3);
    assert.equal(cfg.promoterModel, 'sonnet');
    assert.equal(cfg.promoterPromptFile, 'promoter.md');
    assert.equal(typeof cfg.promoterTimeout, 'number');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig throws when holdoutPerPersona >= promptsPerPersona', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'evolve-config-'));
  try {
    writeFileSync(join(tmp, 'evolve.config.mjs'),
      'export default { personas: [], writeTools: ["x"], srcDirs: ["./x"], promptsPerPersona: 3, holdoutPerPersona: 3 };');
    await assert.rejects(
      () => loadConfig(tmp, join(tmp, 'evolve.config.mjs')),
      /holdoutPerPersona.*must be strictly less than promptsPerPersona/
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
