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
  rmSync(tmp, { recursive: true });
});
