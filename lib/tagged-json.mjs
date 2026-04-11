/**
 * mcp-evolve — Shared tagged-JSON extraction helper.
 *
 * Used by both `reviewer-protocol.mjs` (Spec 1) and `promoter-protocol.mjs`
 * (Spec 2) to pull JSON blocks out of LLM responses wrapped in arbitrary
 * tags like `<AUDIT>`, `<PROMPT_REVIEW>`, `<NOMINATIONS>`, `<SKIPPED>`.
 *
 * Case-insensitive on the tag name. Content is trimmed. Never throws.
 */

/**
 * Extract the content between `<tag>` and `</tag>` (case-insensitive).
 * Returns the trimmed inner string, or null if the tag is not found
 * or the input is not a string.
 *
 * @param {string} text
 * @param {string} tag
 * @returns {string | null}
 */
export function extractTagged(text, tag) {
  if (typeof text !== 'string') return null;
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
  const match = text.match(re);
  return match ? match[1].trim() : null;
}
