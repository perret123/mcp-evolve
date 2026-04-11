/**
 * mcp-evolve — Audit orchestration.
 *
 * Given a set of fixer branches, calls the reviewer LLM to audit and apply
 * diffs, then translates the reviewer's structured decisions into:
 *   - which branches were merged / rejected (for worktree cleanup)
 *   - which prompts were dropped (marked invalid, added to failing store)
 *   - pattern-level failing entries for rejected model-error fixer outputs
 *
 * Pure-function `applyAuditDecisions` is separated from the LLM-invoking
 * `runAuditAndMerge` so the decision-application logic can be unit-tested
 * without a live Claude CLI.
 */

import { execSync } from 'node:child_process';
import { claude, readPrompt } from './claude.mjs';
import { parseReviewerOutput, validateReviewerOutput } from './reviewer-protocol.mjs';
import { addFailingEntry, normalizeErrorText } from './failing-prompts.mjs';
import { loadPromptSet, savePromptSet } from './eval.mjs';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

/**
 * Build the reviewer prompt payload from branches + scoredPrompts.
 * Each branch gets its diff, its triggering error, and the per-prompt context.
 */
function buildReviewerPayload(branches, config) {
  const sections = branches.map((b, idx) => {
    let diff = '';
    try {
      diff = execSync(`git diff HEAD..."${b.branchName}"`, {
        cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000,
      }).trim();
    } catch (err) {
      diff = `(could not read diff: ${err.message || err})`;
    }

    const fe = b.fixableError;
    const errorSummary = (fe.errors || []).map(e =>
      `  - tool: ${e.tool}\n    error: ${typeof e.error === 'string' ? e.error.slice(0, 500) : JSON.stringify(e.error).slice(0, 500)}`
    ).join('\n');

    return [
      `### Branch ${idx + 1}: ${b.branchName}`,
      `Worktree path: ${b.worktreePath}`,
      `Persona: ${fe.persona?.id || 'unknown'}`,
      `Prompt: ${fe.prompt}`,
      fe.probe ? `Probe: ${fe.probe}` : '',
      fe.invariant ? `Invariant: ${fe.invariant}` : '',
      fe.probeType ? `Probe type: ${fe.probeType}` : '',
      fe.lifecycle ? `Lifecycle: ${fe.lifecycle}` : '',
      `Errors:`,
      errorSummary || '  (none)',
      `\nDiff:\n\`\`\`diff\n${diff.slice(0, 6000)}\n\`\`\``,
    ].filter(Boolean).join('\n');
  });

  const header = [
    `${branches.length} fixer branches need audit and merge.`,
    `MCP source directories: ${(config.srcDirs || []).join(', ')}`,
    `Project root: ${config.projectRoot}`,
    ``,
    `Run the audit checklist per your system prompt. Apply approved diffs via Edit. Emit <AUDIT> and <PROMPT_REVIEW> JSON blocks at the end.`,
    ``,
  ].join('\n');

  return header + sections.join('\n\n');
}

/**
 * Apply reviewer decisions to the run state. Deterministic and synchronous —
 * no LLM calls, no git operations, no direct fs writes beyond the injected
 * helpers.
 *
 * Side effects:
 *   - Mutates entries in `scoredPrompts` to set `invalid: true` / `invalidReason`
 *     when the reviewer drops them
 *   - Appends entries to `failing-prompts.json` via `addFailingEntry`
 *   - Rewrites `prompt-set.json` via `savePromptSet` when a dropped prompt was
 *     in the persisted set as `group: golden`
 *
 * Returns a summary for the run log: `{merged, rejected, droppedPrompts}`.
 *
 * @param {object} args
 * @param {{audits: object[], promptReviews: object[], parseErrors: string[]}} args.reviewerOutput
 * @param {Array<{branchName: string, worktreePath: string, slug: string, kind?: string, fixableError: object}>} args.branches
 * @param {Array<object>} args.scoredPrompts
 * @param {string} args.runId
 * @param {object} args.config
 * @returns {{merged: object[], rejected: object[], droppedPrompts: object[]}}
 */
export function applyAuditDecisions({ reviewerOutput, branches, scoredPrompts, runId, config }) {
  const merged = [];
  const rejected = [];
  const droppedPrompts = [];

  // 1. Build a branch → decision map. Missing branches default to reject.
  const auditByBranch = new Map();
  for (const a of reviewerOutput.audits || []) {
    auditByBranch.set(a.branch, a);
  }

  for (const b of branches) {
    const audit = auditByBranch.get(b.branchName);
    if (!audit) {
      rejected.push({
        branchName: b.branchName,
        worktreePath: b.worktreePath,
        fixType: 'other',
        reason: 'missing from AUDIT output — defaulting to reject for safety',
        evidence: null,
      });
      continue;
    }
    if (audit.decision === 'merge') {
      merged.push({ branchName: b.branchName, worktreePath: b.worktreePath, audit });
    } else {
      rejected.push({
        branchName: b.branchName,
        worktreePath: b.worktreePath,
        fixType: audit.fixType,
        reason: audit.reason,
        evidence: audit.backendCheck,
      });

      // Pattern-level failing entries: when the rejected branch was a
      // model-error fixer attempt, persist a pattern that future model-error
      // fixer runs will filter out.
      if (b.kind === 'model-error') {
        const errorKey = normalizeErrorText(
          (b.fixableError?.errors || []).map(e => e.error).join(' ')
        );
        if (errorKey) {
          addFailingEntry(config, {
            kind: 'pattern',
            reason: 'fabrication_trigger',
            triggeringError: {
              tool: b.fixableError?.errors?.[0]?.tool || 'model-error',
              errorTextKey: errorKey,
              fullError: (b.fixableError?.errors || []).map(e => e.error).join('\n').slice(0, 500),
            },
            patternRegex: escapeRegex(errorKey.slice(0, 200)),
            rejectedInRun: runId,
          });
        }
      }
    }
  }

  // 2. Apply PROMPT_REVIEW drops: mark invalid, persist to failing-prompts, remove golden from prompt-set.
  const promptSet = loadPromptSet(config);
  let promptSetChanged = false;

  for (const pr of reviewerOutput.promptReviews || []) {
    if (pr.decision !== 'drop') continue;

    // Parse "persona::prompt" promptId
    const [persona, ...promptParts] = pr.promptId.split('::');
    const promptText = promptParts.join('::');

    // Mark the scored prompt invalid
    const scored = scoredPrompts.find(q =>
      (q.persona === persona || q.persona?.id === persona) && q.prompt === promptText
    );
    if (scored) {
      scored.invalid = true;
      scored.invalidReason = pr.reason;
    }

    // Persist to failing-prompts store
    const failingReason =
      pr.invariantStatus === 'contaminated' ? 'contaminated_invariant' :
      pr.invariantStatus === 'adversarial_expected' ? 'adversarial_misfired' :
      'reviewer_discretion';

    addFailingEntry(config, {
      kind: 'prompt',
      reason: failingReason,
      persona,
      prompt: promptText,
      contextInvariant: scored?.probeData?.invariant || null,
      rejectedInRun: runId,
    });

    droppedPrompts.push({
      persona, prompt: promptText,
      reason: pr.reason,
      invariantStatus: pr.invariantStatus,
      wasGolden: scored?.group === 'golden',
    });

    // If the dropped prompt is in the persisted prompt-set as golden, remove it.
    if (promptSet && Array.isArray(promptSet.prompts)) {
      const before = promptSet.prompts.length;
      promptSet.prompts = promptSet.prompts.filter(p =>
        !(p.persona === persona && p.prompt === promptText && p.group === 'golden')
      );
      if (promptSet.prompts.length !== before) {
        promptSetChanged = true;
      }
    }
  }

  if (promptSetChanged && promptSet) {
    savePromptSet(promptSet, config);
  }

  return { merged, rejected, droppedPrompts };
}

/**
 * Run the reviewer LLM on the given branches and apply its decisions.
 * Returns a summary plus the parsed reviewer output.
 *
 * @param {object} args
 * @param {Array<object>} args.branches
 * @param {Array<object>} args.scoredPrompts
 * @param {string} args.runId
 * @param {object} args.config
 * @returns {Promise<{merged: object[], rejected: object[], droppedPrompts: object[], reviewerOutput: object|null, parseErrors: string[]}>}
 */
export async function runAuditAndMerge({ branches, scoredPrompts, runId, config }) {
  if (branches.length === 0) {
    return { merged: [], rejected: [], droppedPrompts: [], reviewerOutput: null, parseErrors: [] };
  }

  if (config.reviewerAuditEnabled === false) {
    log(`  [audit] reviewerAuditEnabled=false — skipping audit, approving all branches`);
    const approvedAll = {
      audits: branches.map(b => ({
        branch: b.branchName,
        fixType: 'other',
        backendCheck: { performed: false, method: 'grep', evidence: [], conclusion: 'inconclusive' },
        decision: 'merge',
        reason: 'audit disabled via config',
      })),
      promptReviews: [],
      parseErrors: [],
    };
    const summary = applyAuditDecisions({ reviewerOutput: approvedAll, branches, scoredPrompts, runId, config });
    return { ...summary, reviewerOutput: approvedAll, parseErrors: [] };
  }

  const payload = buildReviewerPayload(branches, config);

  log(`  [audit] calling reviewer for ${branches.length} branch(es)...`);
  const output = await claude(payload, {
    systemPrompt: readPrompt(config.promptsDir, 'reviewer.md'),
    allowedTools: config.reviewerTools || 'Read,Edit,Grep,Glob,Bash',
    model: config.reviewerModel,
    timeout: config.reviewerTimeout || 300_000,
    cwd: config.projectRoot,
  });

  const parsed = parseReviewerOutput(output);
  const validationErrors = validateReviewerOutput(parsed);
  const parseErrors = [...(parsed.parseErrors || []), ...validationErrors];

  if (parseErrors.length > 0) {
    log(`  [audit] WARNING: reviewer output has ${parseErrors.length} validation issue(s):`);
    for (const err of parseErrors) log(`    - ${err}`);
    log(`  [audit] Any branch with invalid or missing AUDIT will default to reject.`);
  }

  const summary = applyAuditDecisions({ reviewerOutput: parsed, branches, scoredPrompts, runId, config });

  log(`  [audit] merged=${summary.merged.length} rejected=${summary.rejected.length} dropped=${summary.droppedPrompts.length}`);
  return { ...summary, reviewerOutput: parsed, parseErrors };
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
