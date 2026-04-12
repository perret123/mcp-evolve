/**
 * mcp-evolve — Promoter-Agent orchestration.
 *
 * After every run, the Promoter-Agent inspects passing train prompts and
 * nominates 0–3 for graduation to the persistent golden tier. Mirrors the
 * Spec 1 audit pattern: `applyPromoterDecisions` is a pure, synchronous,
 * unit-testable function; `runPromoter` is the async LLM wrapper.
 *
 * Nominated prompts are appended to `prompt-set.json` with:
 *   lifecycle: 'golden'
 *   evaluation: 'fixer'
 *   promoterEvidence: { nominatedInRun, capabilityTag, confidence, reason }
 *   promotedAt: ISO timestamp
 *   consecutivePasses: 1
 *   probe, invariant, probeType, adversarial — copied from the candidate
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { claude, readPrompt } from './claude.mjs';
import { parsePromoterOutput, validatePromoterOutput } from './promoter-protocol.mjs';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

/**
 * Apply promoter decisions to the persisted prompt-set. Pure sync function
 * with three side effects: reads and writes `prompt-set.json`. No LLM or
 * git calls.
 *
 * @param {object} args
 * @param {{nominations: object[], skipped: object[], parseErrors: string[]}} args.reviewerOutput
 * @param {Array<object>} args.candidates — scored prompts eligible for promotion
 * @param {object} args.config
 * @param {string} args.runId — ISO timestamp of the current run, stored in promoterEvidence
 * @returns {{nominated: object[], skipped: object[], unmatched: object[], duplicates: object[]}}
 */
export function applyPromoterDecisions({ reviewerOutput, candidates, config, runId }) {
  const nominated = [];
  const skipped = [...(reviewerOutput.skipped || [])];
  const unmatched = [];
  const duplicates = [];

  // Load existing prompt-set (create empty v2 shell if missing)
  let ps;
  if (existsSync(config.promptSetPath)) {
    try { ps = JSON.parse(readFileSync(config.promptSetPath, 'utf-8')); }
    catch { ps = { version: 2, prompts: [] }; }
  } else {
    ps = { version: 2, prompts: [] };
  }
  if (!ps.prompts || !Array.isArray(ps.prompts)) ps.prompts = [];

  const existingGoldenKeys = new Set(
    ps.prompts
      .filter(p => p.lifecycle === 'golden')
      .map(p => `${p.persona}::${p.prompt}`)
  );

  const candidateByKey = new Map();
  for (const c of candidates) {
    const key = `${c.persona}::${c.prompt}`;
    candidateByKey.set(key, c);
  }

  const cap = Math.max(0, Number(config.maxPromotionsPerRun) || 3);

  for (const n of reviewerOutput.nominations || []) {
    if (nominated.length >= cap) {
      skipped.push({ promptId: n.promptId, reason: `cap reached (maxPromotionsPerRun=${cap})` });
      continue;
    }
    const key = n.promptId;
    const candidate = candidateByKey.get(key);
    if (!candidate) {
      unmatched.push({ promptId: key, reason: 'no matching candidate in this run' });
      continue;
    }
    if (existingGoldenKeys.has(key)) {
      duplicates.push({ promptId: key, reason: 'already present as golden' });
      continue;
    }

    const promptObj = candidate.promptObj || { prompt: candidate.prompt };
    const entry = {
      persona: candidate.persona,
      prompt: candidate.prompt,
      lifecycle: 'golden',
      evaluation: 'fixer',
      consecutivePasses: 1,
      promotedAt: new Date().toISOString(),
      promoterEvidence: {
        nominatedInRun: runId,
        capabilityTag: n.capabilityTag,
        confidence: n.confidence,
        reason: n.reason,
      },
      promptObj: {
        prompt: candidate.prompt,
        probe: promptObj.probe || null,
        invariant: promptObj.invariant || null,
        probeType: promptObj.probeType || null,
        adversarial: promptObj.adversarial === true,
        lifecycle: 'golden',
        evaluation: 'fixer',
      },
    };
    ps.prompts.push(entry);
    existingGoldenKeys.add(key);
    nominated.push(entry);
  }

  // Write back (ensure directory exists)
  const dir = dirname(config.promptSetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(config.promptSetPath, JSON.stringify(ps, null, 2) + '\n');

  return { nominated, skipped, unmatched, duplicates };
}

/**
 * Build the promoter LLM payload: list existing golden capabilities + the
 * candidate prompts from this run + an anti-examples section from the
 * failing-prompts store (so the promoter doesn't nominate prompts that
 * were already rejected in a previous run).
 */
function buildPromoterPayload({ candidates, currentGolden, failingEntries, config }) {
  const goldenList = currentGolden.length === 0
    ? '(none — first run after migration)'
    : currentGolden.map(g => {
        const tag = g.promoterEvidence?.capabilityTag || '(untagged)';
        return `- [${g.persona}] capability: ${tag}\n    Prompt: "${(g.prompt || '').slice(0, 160)}"`;
      }).join('\n');

  const candidateList = candidates.map(c => {
    const toolsUsed = (c.toolCalls || c.scorePost?.toolsUsedList || []).slice(0, 10);
    const invariant = c.promptObj?.invariant || '(none)';
    return [
      `- promptId: ${c.persona}::${c.prompt}`,
      `  Persona: ${c.persona}`,
      `  Prompt: "${c.prompt}"`,
      `  Probe invariant: ${invariant}`,
      `  Tools used (${toolsUsed.length}): ${toolsUsed.join(', ') || '(n/a)'}`,
    ].join('\n');
  }).join('\n\n');

  const antiExamples = (failingEntries || [])
    .filter(e => e.kind === 'prompt')
    .slice(0, 20)
    .map(e => `- [${e.persona || '(any)'}] "${(e.prompt || '').slice(0, 160)}" — ${e.reason}`)
    .join('\n');

  const header = [
    `# Promoter-Agent input`,
    `Max nominations this run: ${config.maxPromotionsPerRun ?? 3}`,
    '',
    `## Existing golden capabilities`,
    goldenList,
    '',
    `## Passing train candidates this run`,
    candidateList || '(none)',
    '',
    antiExamples ? `## Anti-examples — DO NOT nominate these or near-duplicates\n${antiExamples}\n` : '',
    `Emit <NOMINATIONS> and <SKIPPED> JSON blocks per your system prompt.`,
  ].filter(Boolean).join('\n');

  return header;
}

/**
 * Invoke the Promoter-Agent LLM and apply its decisions.
 *
 * @param {object} args
 * @param {Array<object>} args.candidates
 * @param {Array<object>} args.currentGolden
 * @param {Array<object>} args.failingEntries
 * @param {object} args.config
 * @param {string} args.runId
 * @returns {Promise<{nominated: object[], skipped: object[], unmatched: object[], duplicates: object[], parseErrors: string[], reviewerOutput: object|null}>}
 */
export async function runPromoter({ candidates, currentGolden, failingEntries, config, runId }) {
  if (!candidates || candidates.length === 0) {
    log('  [promoter] no passing train candidates — skipping');
    return { nominated: [], skipped: [], unmatched: [], duplicates: [], parseErrors: [], reviewerOutput: null };
  }

  const payload = buildPromoterPayload({ candidates, currentGolden, failingEntries, config });
  log(`  [promoter] evaluating ${candidates.length} candidate(s)...`);

  let output = '';
  try {
    output = await claude(payload, {
      systemPrompt: readPrompt(config.promptsDir, config.promoterPromptFile || 'promoter.md'),
      model: config.promoterModel || 'sonnet',
      timeout: config.promoterTimeout || 180_000,
      cwd: config.projectRoot,
    });
  } catch (err) {
    log(`  [promoter] LLM call failed: ${err.message || err}`);
    return { nominated: [], skipped: [], unmatched: [], duplicates: [], parseErrors: [`LLM call failed: ${err.message || err}`], reviewerOutput: null };
  }

  const parsed = parsePromoterOutput(output);
  const validationErrors = validatePromoterOutput(parsed);
  const parseErrors = [...(parsed.parseErrors || []), ...validationErrors];

  if (parseErrors.length > 0) {
    log(`  [promoter] WARNING: ${parseErrors.length} validation issue(s):`);
    for (const e of parseErrors) log(`    - ${e}`);
  }

  const summary = applyPromoterDecisions({ reviewerOutput: parsed, candidates, config, runId });
  log(`  [promoter] nominated=${summary.nominated.length} skipped=${summary.skipped.length} unmatched=${summary.unmatched.length} duplicates=${summary.duplicates.length}`);
  return { ...summary, parseErrors, reviewerOutput: parsed };
}
