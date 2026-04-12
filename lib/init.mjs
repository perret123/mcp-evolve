/**
 * mcp-evolve init — scaffolds config + generates validated prompt set.
 *
 * Two modes:
 *   1. Scaffold only (no config exists) — creates starter files
 *   2. Full init (config exists) — generates personas (if needed), prompts,
 *      validates them, assigns golden set, saves prompt-set.json
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

// --- Full init workflow ---

export async function fullInit(config) {
  log('mcp-evolve init (Spec 2: empty v2 prompt-set)');
  log(`System: ${config.systemDescription}`);

  // Ensure data directory exists
  const dataDir = config.dataDir;
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Spec 2: init no longer generates prompts at scaffold time. Prompts are
  // generated fresh every run. We write an empty v2 prompt-set so the
  // subsequent run loop has a file to read (and so loadPromptSet's v1
  // rejection check does not false-positive on a missing file).
  const empty = {
    version: 2,
    generatedAt: new Date().toISOString(),
    prompts: [],
  };

  const { savePromptSet } = await import('./eval.mjs');
  savePromptSet(empty, config);
  log(`Wrote empty v2 prompt-set to ${config.promptSetPath}`);
  log(`Personas: ${(config.personas || []).length} configured. Prompts will be generated fresh on first run.`);

  return empty;
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
  promptsPerPersona: 3,
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
