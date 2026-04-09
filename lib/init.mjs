/**
 * mcp-evolve init — scaffolds config + generates validated question set.
 *
 * Two modes:
 *   1. Scaffold only (no config exists) — creates starter files
 *   2. Full init (config exists) — generates personas (if needed), questions,
 *      validates them, assigns golden set, saves question-set.json
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { llm } from './llm.mjs';
import { createQuestionSet, saveQuestionSet } from './eval.mjs';
import {
  generateQuestions,
  runSeed, runReset, getStateDescription, runPrefetch,
} from './run.mjs';
import { buildRunDateContext } from './dates.mjs';

function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

// --- Persona auto-generation ---

async function generatePersonas(config) {
  log('Auto-generating personas from system description...');

  const prompt = [
    `You are designing test personas for an MCP server.`,
    ``,
    `System: ${config.systemDescription}`,
    ``,
    `Generate 5 diverse personas that would use this system. Each persona should have:`,
    `- Different MBTI types and interaction clusters`,
    `- Varied technical skill levels`,
    `- Different concerns and question styles`,
    `- A mix of power users, casual users, and edge-case users`,
    ``,
    `Reply with ONLY a JSON object:`,
    `{"personas": [`,
    `  {`,
    `    "id": "short-id",`,
    `    "name": "Display Name",`,
    `    "mbti": "XXXX",`,
    `    "cluster": "category",`,
    `    "description": "You are ...",`,
    `    "concerns": ["concern1", "concern2", "concern3"],`,
    `    "questionStyle": "How they ask questions"`,
    `  }`,
    `]}`,
  ].join('\n');

  const output = await llm(prompt, {
    model: config.questionModel || 'sonnet',
    timeout: 60_000,
  });

  try {
    const match = output.match(/\{[\s\S]*"personas"[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return parsed.personas || [];
    }
  } catch { /* fall through */ }

  log('  Failed to parse personas');
  return [];
}

// --- Full init workflow ---

export async function fullInit(config) {
  log('mcp-evolve full init');
  log(`System: ${config.systemDescription}`);

  // Ensure data directory exists
  const dataDir = config.dataDir;
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Step 1: Auto-generate personas if none defined
  if (!config.personas || config.personas.length === 0) {
    const personas = await generatePersonas(config);
    if (personas.length === 0) {
      log('ERROR: Could not generate personas. Define them manually in evolve.config.mjs');
      return null;
    }
    config.personas = personas;
    log(`  Generated ${personas.length} personas: ${personas.map(p => p.name).join(', ')}`);
  } else {
    log(`  Using ${config.personas.length} existing personas: ${config.personas.map(p => p.name).join(', ')}`);
  }

  // Step 2: Seed environment
  if (config.seed) {
    await runSeed(config);
  }

  // Step 3: Gather context
  const stateDesc = getStateDescription(config);
  let prefetchData = null;
  if (config.prefetch) {
    prefetchData = await runPrefetch(config);
  }
  const fullContext = [stateDesc, prefetchData].filter(Boolean).join('\n\n');
  const runDateContext = buildRunDateContext(config);

  // Step 4: Generate questions — all personas in parallel
  const targetTotal = config.initQuestions || 20;
  const perPersona = Math.ceil(targetTotal / config.personas.length);

  log(`Generating ${targetTotal} questions (${perPersona} per persona)...`);

  // Temporarily override questionsPerPersona for generation
  const origQpp = config.questionsPerPersona;
  config.questionsPerPersona = perPersona;

  const generated = await Promise.all(
    config.personas.map(async (persona) => {
      const questions = await generateQuestions(persona, config, fullContext, runDateContext);
      return questions.map(q => ({
        persona: persona.id,
        question: typeof q === 'object' ? q.question : q,
        questionObj: typeof q === 'object' ? q : null,
      }));
    })
  );

  config.questionsPerPersona = origQpp;

  // Flatten and trim to target count
  const allQuestions = generated.flat().slice(0, targetTotal);
  log(`  Generated ${allQuestions.length} questions`);

  // Step 5: Create question set — all train, golden promotion happens during runs
  const qs = createQuestionSet(allQuestions, 0);

  const goldenCount = qs.questions.filter(q => q.group === 'golden').length;
  const trainCount = qs.questions.filter(q => q.group === 'train').length;

  log(`\nQuestion set created: ${qs.questions.length} total (${trainCount} train, ${goldenCount} golden)`);

  // Step 7: Save
  saveQuestionSet(qs, config);
  log(`Saved to ${config.questionSetPath}`);

  // Reset environment
  if (config.reset) await runReset(config);

  return qs;
}

// --- Scaffold-only init (original behavior) ---

const STARTER_CONFIG = `/**
 * mcp-evolve configuration.
 * See: https://github.com/perret123/mcp-evolve
 */
export default {
  mcpConfig: './mcp-evolve.json',
  mcpToolPrefix: 'mcp__my-server__',
  answererTools: 'mcp__my-server__*',
  systemDescription: 'a project management platform',
  srcDirs: ['./src'],
  writeTools: ['create_*', 'update_*', 'delete_*'],
  personas: [],
  questionsPerPersona: 3,
  language: 'English',
};
`;

const STARTER_MCP_CONFIG = `{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {}
    }
  }
}
`;

export function scaffoldInit(projectRoot) {
  const configPath = join(projectRoot, 'evolve.config.mjs');
  const mcpConfigPath = join(projectRoot, 'mcp-evolve.json');
  const dataDir = join(projectRoot, '.mcp-evolve');

  const created = [];

  if (existsSync(configPath)) {
    console.log(`  evolve.config.mjs already exists — skipping`);
  } else {
    writeFileSync(configPath, STARTER_CONFIG);
    created.push('evolve.config.mjs');
  }

  if (existsSync(mcpConfigPath)) {
    console.log(`  mcp-evolve.json already exists — skipping`);
  } else {
    writeFileSync(mcpConfigPath, STARTER_MCP_CONFIG);
    created.push('mcp-evolve.json');
  }

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    created.push('.mcp-evolve/');
  }

  return created;
}
