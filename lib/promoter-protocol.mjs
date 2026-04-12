/**
 * mcp-evolve — Promoter output protocol.
 *
 * The Promoter-Agent emits two tagged-JSON blocks at the end of its response:
 *
 *   <NOMINATIONS>
 *   [ { promptId, capabilityTag, confidence, reason }, ... ]
 *   </NOMINATIONS>
 *
 *   <SKIPPED>
 *   [ { promptId, reason }, ... ]
 *   </SKIPPED>
 *
 * This module parses + validates those blocks. Mirrors the structure of
 * `reviewer-protocol.mjs`.
 */

import { extractTagged } from './tagged-json.mjs';

const VALID_CONFIDENCE = new Set(['high', 'medium']);

/**
 * Parse raw promoter stdout. Extracts `<NOMINATIONS>` and `<SKIPPED>` JSON
 * blocks. Never throws; parse errors are reported structurally.
 *
 * @param {string} text
 * @returns {{nominations: object[], skipped: object[], parseErrors: string[]}}
 */
export function parsePromoterOutput(text) {
  const result = { nominations: [], skipped: [], parseErrors: [] };
  if (typeof text !== 'string') return result;

  const nomRaw = extractTagged(text, 'NOMINATIONS');
  if (nomRaw) {
    try {
      const parsed = JSON.parse(nomRaw);
      if (Array.isArray(parsed)) result.nominations = parsed;
      else result.parseErrors.push('NOMINATIONS block is not a JSON array');
    } catch (err) {
      result.parseErrors.push(`NOMINATIONS parse failed: ${err.message}`);
    }
  }

  const skipRaw = extractTagged(text, 'SKIPPED');
  if (skipRaw) {
    try {
      const parsed = JSON.parse(skipRaw);
      if (Array.isArray(parsed)) result.skipped = parsed;
      else result.parseErrors.push('SKIPPED block is not a JSON array');
    } catch (err) {
      result.parseErrors.push(`SKIPPED parse failed: ${err.message}`);
    }
  }

  return result;
}

/**
 * Validate a parsed promoter output for structural and semantic correctness.
 * Returns an array of human-readable error strings; empty means valid.
 */
export function validatePromoterOutput(parsed) {
  const errors = [];

  if (!parsed || typeof parsed !== 'object') {
    return ['validatePromoterOutput: parsed input is not an object'];
  }

  for (const n of parsed.nominations || []) {
    if (!n || typeof n !== 'object') {
      errors.push(`nomination entry is not an object: ${JSON.stringify(n)}`);
      continue;
    }
    if (!n.promptId || typeof n.promptId !== 'string') {
      errors.push(`nomination missing promptId: ${JSON.stringify(n)}`);
    }
    if (!n.capabilityTag || typeof n.capabilityTag !== 'string') {
      errors.push(`nomination missing capabilityTag for ${n.promptId || '(unknown)'}`);
    }
    if (!VALID_CONFIDENCE.has(n.confidence)) {
      errors.push(`nomination confidence invalid for ${n.promptId || '(unknown)'}: ${n.confidence}`);
    }
    if (!n.reason || typeof n.reason !== 'string') {
      errors.push(`nomination reason missing for ${n.promptId || '(unknown)'}`);
    }
  }

  for (const s of parsed.skipped || []) {
    if (!s || typeof s !== 'object') {
      errors.push(`skipped entry is not an object: ${JSON.stringify(s)}`);
      continue;
    }
    if (!s.promptId || typeof s.promptId !== 'string') {
      errors.push(`skipped missing promptId: ${JSON.stringify(s)}`);
    }
    if (!s.reason || typeof s.reason !== 'string') {
      errors.push(`skipped reason missing for ${s.promptId || '(unknown)'}`);
    }
  }

  return errors;
}
