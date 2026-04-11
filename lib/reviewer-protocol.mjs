/**
 * mcp-evolve — Reviewer output protocol.
 *
 * The reviewer emits JSON inside <AUDIT> and <PROMPT_REVIEW> tags at the
 * end of its response. This module extracts and validates those blocks.
 *
 * Expected reviewer output shape:
 *
 *   <AUDIT>
 *   [ { branch, fixType, backendCheck: { performed, method, evidence, conclusion }, decision, reason }, ... ]
 *   </AUDIT>
 *
 *   <PROMPT_REVIEW>
 *   [ { promptId, persona, invariantStatus, decision, reason }, ... ]
 *   </PROMPT_REVIEW>
 */

const VALID_FIX_TYPES = new Set([
  'rejection_path', 'tool_description', 'handler_logic',
  'helper_function', 'schema', 'other',
]);
const VALID_DECISIONS = new Set(['merge', 'reject']);
const VALID_METHODS = new Set(['grep', 'read', 'git_log']);
const VALID_CONCLUSIONS = new Set(['fabrication', 'legitimate', 'inconclusive']);
const VALID_INVARIANT_STATUS = new Set(['correct', 'contaminated', 'adversarial_expected']);
const VALID_PROMPT_DECISIONS = new Set(['keep', 'drop']);

function extractTagged(text, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const match = text.match(re);
  return match ? match[1].trim() : null;
}

/**
 * Parse the reviewer's raw text output. Extracts the <AUDIT> and
 * <PROMPT_REVIEW> tagged JSON blocks. Never throws — malformed JSON or
 * missing tags are reported as structured errors.
 *
 * @param {string} text - raw reviewer stdout
 * @returns {{audits: object[], promptReviews: object[], parseErrors: string[]}}
 */
export function parseReviewerOutput(text) {
  const result = { audits: [], promptReviews: [], parseErrors: [] };
  if (typeof text !== 'string') return result;

  const auditRaw = extractTagged(text, 'AUDIT');
  if (auditRaw) {
    try {
      const parsed = JSON.parse(auditRaw);
      if (Array.isArray(parsed)) result.audits = parsed;
      else result.parseErrors.push('AUDIT block is not a JSON array');
    } catch (err) {
      result.parseErrors.push(`AUDIT parse failed: ${err.message}`);
    }
  }

  const promptRaw = extractTagged(text, 'PROMPT_REVIEW');
  if (promptRaw) {
    try {
      const parsed = JSON.parse(promptRaw);
      if (Array.isArray(parsed)) result.promptReviews = parsed;
      else result.parseErrors.push('PROMPT_REVIEW block is not a JSON array');
    } catch (err) {
      result.parseErrors.push(`PROMPT_REVIEW parse failed: ${err.message}`);
    }
  }

  return result;
}

/**
 * Validate a parsed reviewer output for structural and semantic correctness.
 * Returns an array of human-readable error strings; empty means valid.
 *
 * Semantic constraints (fabrication safety):
 *   1. fixType='rejection_path' requires backendCheck.performed=true — the
 *      reviewer must have actually run the grep/read/git_log checklist for
 *      any diff that adds a rejection path.
 *   2. decision='merge' combined with conclusion='fabrication' is forbidden
 *      as a logical contradiction.
 *
 * @param {{audits: object[], promptReviews: object[]}} parsed
 * @returns {string[]}
 */
export function validateReviewerOutput(parsed) {
  const errors = [];

  for (const a of parsed.audits || []) {
    if (!a.branch || typeof a.branch !== 'string') errors.push(`audit missing branch: ${JSON.stringify(a)}`);
    if (!VALID_FIX_TYPES.has(a.fixType)) errors.push(`audit.fixType invalid: ${a.fixType}`);
    if (!VALID_DECISIONS.has(a.decision)) errors.push(`audit.decision invalid: ${a.decision}`);
    if (!a.reason || typeof a.reason !== 'string') errors.push(`audit.reason missing for ${a.branch}`);

    const bc = a.backendCheck || {};
    if (typeof bc.performed !== 'boolean') errors.push(`audit.backendCheck.performed missing for ${a.branch}`);
    if (bc.performed && !VALID_METHODS.has(bc.method)) errors.push(`audit.backendCheck.method invalid for ${a.branch}: ${bc.method}`);
    if (!VALID_CONCLUSIONS.has(bc.conclusion)) errors.push(`audit.backendCheck.conclusion invalid for ${a.branch}: ${bc.conclusion}`);

    // Semantic constraint: rejection_path diffs MUST have performed a real backend check
    if (a.fixType === 'rejection_path' && bc.performed !== true) {
      errors.push(`audit fixType=rejection_path requires backendCheck.performed=true for ${a.branch}`);
    }

    // Semantic constraint: decision=merge is incompatible with conclusion=fabrication
    if (a.decision === 'merge' && bc.conclusion === 'fabrication') {
      errors.push(`audit ${a.branch} marks conclusion=fabrication but decision=merge — inconsistent`);
    }
  }

  for (const pr of parsed.promptReviews || []) {
    if (!pr.promptId || typeof pr.promptId !== 'string') errors.push(`prompt review missing promptId: ${JSON.stringify(pr)}`);
    if (!pr.persona || typeof pr.persona !== 'string') errors.push(`prompt review missing persona: ${pr.promptId}`);
    if (!VALID_INVARIANT_STATUS.has(pr.invariantStatus)) errors.push(`prompt review invariantStatus invalid: ${pr.invariantStatus}`);
    if (!VALID_PROMPT_DECISIONS.has(pr.decision)) errors.push(`prompt review decision invalid: ${pr.decision}`);
  }

  return errors;
}
