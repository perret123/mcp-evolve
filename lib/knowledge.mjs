/**
 * mcp-evolve — Knowledge base.
 *
 * Grows only when feature competitions produce winning features.
 * Each entry documents what was built and why — an evolution log.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load all knowledge entries from the knowledge directory.
 * Returns concatenated text for use as context in proposals.
 */
export function loadKnowledge(config) {
  const dir = config.knowledgeDir || join(config.dataDir, 'knowledge');
  if (!existsSync(dir)) return '';

  const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  if (files.length === 0) return '';

  const entries = files.map(f => {
    const content = readFileSync(join(dir, f), 'utf-8');
    return content.trim();
  });

  return entries.join('\n\n---\n\n');
}

/**
 * Write a knowledge entry for a winning feature.
 *
 * @param {object} feature - { name, description, why, testQuestions }
 * @param {object} competition - { groups, proposals, votes, winner }
 * @param {object} config
 */
export function writeFeatureKnowledge(feature, competition, config) {
  const dir = config.knowledgeDir || join(config.dataDir, 'knowledge');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const slug = feature.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);

  const timestamp = new Date().toISOString();

  const content = [
    `# ${feature.name}`,
    '',
    `_Added: ${timestamp}_`,
    '',
    `## What is it?`,
    '',
    feature.description,
    '',
    `## Why was it added?`,
    '',
    feature.why,
    '',
    `## How it was decided`,
    '',
    `Three persona groups proposed features and voted. This feature won with ${competition.votes.filter(v => v.vote === competition.winner).length}/3 group votes.`,
    '',
    `**Proposed by:** ${competition.proposals[competition.winner]?.groupName || competition.winner}`,
    `**Voted for by:** ${competition.votes.filter(v => v.vote === competition.winner).map(v => v.groupName).join(', ')}`,
    '',
    `## Test questions`,
    '',
    ...(feature.testQuestions || []).map(q => `- ${q}`),
    '',
  ].join('\n');

  const filePath = join(dir, `${slug}.md`);
  writeFileSync(filePath, content + '\n');

  return filePath;
}
