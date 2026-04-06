/**
 * mcp-evolve — Feature Competition.
 *
 * After sustained 100% runs post-escalation, personas compete
 * to propose new features. Three groups propose independently,
 * then cross-vote. A feature wins only if the OTHER groups prefer it.
 *
 * Flow: select 9 personas → split 3 groups → 3 proposals (parallel)
 *       → 3 votes (parallel) → winner or no-winner → knowledge entry
 */

import { claude, readPrompt } from './claude.mjs';
import { getClusters } from './personas.mjs';
import { promoteToGoldenSet } from './eval.mjs';
import { loadKnowledge, writeFeatureKnowledge } from './knowledge.mjs';
import { recordCompetition } from './metrics.mjs';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// --- Persona Selection ---

/**
 * Pick personas for competition, maximizing cluster diversity.
 * Returns 3 groups of ~equal size.
 */
export function selectCompetitionPersonas(personas) {
  const shuffled = [...personas].sort(() => Math.random() - 0.5);
  const selected = [];
  const usedClusters = new Set();

  // First pass: one per cluster for diversity
  for (const p of shuffled) {
    if (!usedClusters.has(p.cluster) && selected.length < 9) {
      selected.push(p);
      usedClusters.add(p.cluster);
    }
  }

  // Fill remaining
  for (const p of shuffled) {
    if (selected.length >= 9) break;
    if (!selected.includes(p)) selected.push(p);
  }

  // Split into 3 groups as evenly as possible
  const groupSize = Math.ceil(selected.length / 3);
  return {
    A: selected.slice(0, groupSize),
    B: selected.slice(groupSize, groupSize * 2),
    C: selected.slice(groupSize * 2),
  };
}

// --- Proposal ---

function formatPersonas(group) {
  return group.map(p =>
    `- **${p.name}** (${p.mbti || '?'}, ${p.cluster || '?'}): ${p.description.slice(0, 200)}\n  Concerns: ${(p.concerns || []).join(', ')}`
  ).join('\n');
}

async function proposeFeature(groupName, group, context, config) {
  const promptTemplate = readPrompt(config.promptsDir, 'proposer.md');

  const prompt = promptTemplate
    .replace('{{PERSONAS}}', formatPersonas(group))
    .replace('{{SYSTEM_DESCRIPTION}}', config.systemDescription || '')
    .replace('{{KNOWLEDGE}}', context.knowledge || '(no features built yet)')
    .replace('{{PASSING_QUESTIONS}}', context.passingQuestions || '(none)');

  const output = await claude(prompt, {
    model: 'opus',
    timeout: 120_000,
  });

  try {
    const match = output.match(/\{[\s\S]*\}/);
    if (match) {
      const proposal = JSON.parse(match[0]);
      proposal.groupName = groupName;
      proposal.personas = group.map(p => p.id);
      return proposal;
    }
  } catch { /* parse failed */ }

  return null;
}

// --- Voting ---

async function voteOnProposals(groupName, group, proposals, config) {
  const promptTemplate = readPrompt(config.promptsDir, 'voter.md');

  const proposalText = Object.entries(proposals)
    .map(([key, p]) => `**Group ${key}: "${p.name}"**\n${p.description}\nWhy: ${p.why}\nExample test: ${p.testQuestion}`)
    .join('\n\n');

  const prompt = promptTemplate
    .replace('{{PERSONAS}}', formatPersonas(group))
    .replace('{{PROPOSALS}}', proposalText)
    .replace('{{OWN_GROUP}}', groupName)
    .replaceAll('{{OWN_GROUP}}', groupName);

  const output = await claude(prompt, {
    model: 'opus',
    timeout: 60_000,
  });

  try {
    const match = output.match(/\{[\s\S]*\}/);
    if (match) {
      const vote = JSON.parse(match[0]);
      vote.groupName = groupName;

      return vote;
    }
  } catch { /* parse failed */ }

  return null;
}

// --- Competition ---

/**
 * Run a feature competition.
 *
 * @param {object} context - { passingQuestions, fullContext }
 * @param {object} config
 * @returns {object} { winner, proposals, votes, feature } or null
 */
export async function runCompetition(context, config) {
  log('');
  log('='.repeat(60));
  log('FEATURE COMPETITION — personas propose and vote');
  log('='.repeat(60));

  // 1. Select personas and form groups
  const groups = selectCompetitionPersonas(config.personas);
  const groupNames = Object.keys(groups);

  for (const [name, group] of Object.entries(groups)) {
    log(`  Group ${name}: ${group.map(p => p.id).join(', ')}`);
  }

  // Load knowledge for context
  const knowledge = loadKnowledge(config);

  const proposalContext = {
    knowledge,
    passingQuestions: context.passingQuestions || '',
  };

  // 2. Generate proposals IN PARALLEL (3 Opus calls)
  log('');
  log('  Generating proposals...');
  const proposalPromises = groupNames.map(name =>
    proposeFeature(name, groups[name], proposalContext, config)
  );
  const proposalResults = await Promise.all(proposalPromises);

  const proposals = {};
  for (let i = 0; i < groupNames.length; i++) {
    if (proposalResults[i]) {
      proposals[groupNames[i]] = proposalResults[i];
      log(`  Group ${groupNames[i]}: "${proposalResults[i].name}" — ${proposalResults[i].description}`);
    } else {
      log(`  Group ${groupNames[i]}: failed to generate proposal`);
    }
  }

  const validProposals = Object.keys(proposals);
  if (validProposals.length < 2) {
    log('  Not enough valid proposals for competition');
    return null;
  }

  // 3. Vote IN PARALLEL (3 Opus calls)
  log('');
  log('  Voting...');
  const votePromises = groupNames.map(name =>
    groups[name].length > 0 ? voteOnProposals(name, groups[name], proposals, config) : null
  );
  const voteResults = (await Promise.all(votePromises)).filter(Boolean);

  log('');
  for (const v of voteResults) {
    log(`  Group ${v.groupName} votes: ${v.vote} — ${v.reason}`);
  }

  // 4. Count votes
  const voteCounts = {};
  for (const v of voteResults) {
    voteCounts[v.vote] = (voteCounts[v.vote] || 0) + 1;
  }

  // Find winner (needs 2+ votes)
  let winner = null;
  for (const [key, count] of Object.entries(voteCounts)) {
    if (count >= 2) winner = key;
  }

  if (!winner) {
    log('');
    log('  NO WINNER — votes split, no feature was compelling enough');
    log(`  Vote counts: ${JSON.stringify(voteCounts)}`);
    recordCompetition({ winner: null, featureName: null, voteCounts }, config);
    return { winner: null, proposals, votes: voteResults };
  }

  const winningProposal = proposals[winner];
  log('');
  log(`  WINNER: Group ${winner} — "${winningProposal.name}"`);
  log(`  ${winningProposal.description}`);

  // 5. Generate test questions and promote to golden set
  const testQuestions = [winningProposal.testQuestion];

  // Generate 2 more test questions from the winning feature
  try {
    const moreQuestionsOutput = await claude(
      `Generate 2 more test questions for this new MCP server feature:\n\nFeature: ${winningProposal.name}\nDescription: ${winningProposal.description}\n\nReply with JSON: {"questions": [{"persona": "persona-id", "question": "..."}]}\n\nUse personas from: ${config.personas.map(p => p.id).join(', ')}`,
      { model: 'sonnet', timeout: 30_000 },
    );
    const match = moreQuestionsOutput.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.questions) {
        for (const q of parsed.questions) testQuestions.push(q.question || q);
      }
    }
  } catch { /* extra questions optional */ }

  // Promote to golden set
  let promoted = 0;
  for (const q of testQuestions) {
    const questionText = typeof q === 'string' ? q : q.question;
    const personaId = typeof q === 'object' ? q.persona : config.personas[0]?.id;
    const persona = config.personas.find(p => p.id === personaId) || config.personas[0];
    if (persona && questionText) {
      if (promoteToGoldenSet(persona, questionText, {
        timestamp: new Date().toISOString(),
        source: 'competition',
        feature: winningProposal.name,
        reason: winningProposal.description,
      }, config)) promoted++;
    }
  }

  log(`  Promoted ${promoted} test questions to golden set`);

  // 6. Write knowledge entry
  const feature = {
    name: winningProposal.name,
    description: winningProposal.description,
    why: winningProposal.why,
    testQuestions: testQuestions.map(q => typeof q === 'string' ? q : q.question),
  };

  const knowledgePath = writeFeatureKnowledge(feature, {
    groups,
    proposals,
    votes: voteResults,
    winner,
  }, config);

  log(`  Knowledge written to ${knowledgePath}`);

  recordCompetition({ winner, featureName: feature.name, voteCounts }, config);

  return { winner, proposals, votes: voteResults, feature };
}
