/**
 * mcp-evolve — Configuration loader.
 *
 * Loads evolve.config.mjs from the user's project root and merges with defaults.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULTS = {
  /** MCP config JSON file for the server under test */
  mcpConfig: './mcp-evolve.json',

  /** MCP tool name prefix (used to strip for clean metric names) */
  mcpToolPrefix: '',

  /** Glob/pattern for allowed tools passed to the answerer */
  answererTools: 'mcp__*',

  /** Tools the fixer can use */
  fixerTools: 'Read,Edit,Grep,Glob,Bash',

  /** Tools the reviewer can use */
  reviewerTools: 'Read,Edit,Grep,Glob',

  /** Tool names (or patterns) that are write/mutation tools — used for action detection */
  writeTools: [],

  /** Default questions per persona */
  questionsPerPersona: 3,

  /** Source directories the fixer/reviewer can edit */
  srcDirs: [],

  /** Knowledge directory (optional) */
  knowledgeDir: null,

  /** Debug log files to monitor during tests (optional) */
  debugLogFiles: [],

  /** Personas — user provides these */
  personas: [],

  /**
   * Optional async prefetch function — runs before question generation
   * to get real entity names from the MCP server.
   * Receives (claude) helper function, should return a string of context.
   */
  prefetch: null,

  /** System/domain description — used in prompts to describe the server */
  systemDescription: 'an MCP server',

  /** Language hint for question generation */
  language: 'English',

  /** Data directory for logs, baselines, golden set, metrics */
  dataDir: '.mcp-evolve',
};

/**
 * Load user config from evolve.config.mjs and merge with defaults.
 */
export async function loadConfig(projectRoot) {
  const root = resolve(projectRoot || '.');
  const configPath = join(root, 'evolve.config.mjs');

  let userConfig = {};
  if (existsSync(configPath)) {
    const module = await import(pathToFileURL(configPath).href);
    userConfig = module.default || module;
  }

  const merged = { ...DEFAULTS, ...userConfig };

  // Resolve paths relative to project root
  merged.projectRoot = root;
  merged.mcpConfig = resolve(root, merged.mcpConfig);
  merged.dataDir = resolve(root, merged.dataDir);
  merged.logsDir = join(merged.dataDir, 'logs');
  merged.baselinesDir = join(merged.dataDir, 'baselines');
  merged.goldenSetPath = join(merged.dataDir, 'golden-set.json');
  merged.metricsPath = join(merged.dataDir, 'metrics.json');

  if (merged.knowledgeDir) {
    merged.knowledgeDir = resolve(root, merged.knowledgeDir);
  }

  merged.srcDirs = merged.srcDirs.map(d => resolve(root, d));

  // Resolve prompts dir (bundled with mcp-evolve)
  merged.promptsDir = new URL('../prompts', import.meta.url).pathname;

  return merged;
}

/**
 * Validate config and return errors.
 */
export function validateConfig(config) {
  const errors = [];

  if (!config.personas || config.personas.length === 0) {
    errors.push('No personas defined. Add at least one persona to evolve.config.mjs');
  }

  if (!config.writeTools || config.writeTools.length === 0) {
    errors.push('No writeTools defined. mcp-evolve needs to know which tools are write/mutation tools for action detection.');
  }

  if (config.srcDirs.length === 0) {
    errors.push('No srcDirs defined. The fixer needs to know where your MCP server source code is.');
  }

  for (const p of config.personas || []) {
    if (!p.id) errors.push(`Persona missing "id" field`);
    if (!p.description) errors.push(`Persona "${p.id}" missing "description"`);
    if (!p.concerns || p.concerns.length === 0) errors.push(`Persona "${p.id}" missing "concerns"`);
  }

  return errors;
}
