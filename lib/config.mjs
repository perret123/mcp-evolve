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
   * Optional async seed function — runs at the START of each run.
   * Prepares the test environment (e.g. restart emulator with snapshot,
   * import test data, start services). Receives (config).
   */
  seed: null,

  /**
   * Optional async reset function — runs at the END of each run.
   * Cleans up the test environment. Receives (config).
   */
  reset: null,

  /**
   * Optional function that returns a text description of the test dataset.
   * Fed to the question generator so it knows what data exists and can
   * generate questions that are answerable. Should describe: what entities
   * exist, their state, what's NOT there, and any constraints.
   * Receives (config), returns a string.
   */
  describeState: null,

  /**
   * Optional async prefetch function — runs before question generation
   * to fetch real entity names/IDs from the live system.
   * Receives (claude, config), should return a string of context.
   * Complements describeState: describeState is static knowledge about
   * the dataset, prefetch is live data (IDs, names, current state).
   */
  prefetch: null,

  /**
   * Optional async healthcheck hook — runs after seed and before testing.
   * Receives ({ config, runDateContext }) and can return:
   * - nothing / truthy: healthy
   * - string: healthy with details
   * - { ok: false, error, details }: unhealthy, run will be quarantined
   * Throwing also marks the run unhealthy.
   */
  healthcheck: null,

  /** System/domain description — used in prompts to describe the server */
  systemDescription: 'an MCP server',

  /** Language hint for question generation */
  language: 'English',

  /** Optional timezone used to anchor relative dates across the whole run */
  timeZone: null,

  /** Optional fixed clock for deterministic runs/tests */
  referenceNow: null,

  /** How to interpret "next Friday" style phrases */
  nextWeekdayMode: 'nearest-upcoming',

  /** Extra natural-language rules for date interpretation */
  relativeDateRules: '',

  /** Data directory for logs, baselines, golden set, metrics */
  dataDir: '.mcp-evolve',

  // --- Model configuration (all default to sonnet) ---

  /** Model for answering questions */
  answererModel: 'sonnet',

  /** Model for grading answers */
  graderModel: 'sonnet',

  /** Model for fixing errors */
  fixerModel: 'sonnet',

  /** Model for reviewing descriptions */
  reviewerModel: 'sonnet',

  /** Model for generating questions */
  questionModel: 'sonnet',

  /** Model for escalation */
  escalatorModel: 'sonnet',

  /** Model for feature proposals in competition */
  proposalModel: 'sonnet',

  /** Model for voting in competition */
  voterModel: 'sonnet',

  // --- Escalation configuration ---

  /** Consecutive 100% runs before escalation triggers */
  streakThreshold: 3,

  /** Consecutive 100% runs before feature competition triggers (multiplier of streakThreshold) */
  competitionStreakMultiplier: 2,

  // --- Competition configuration ---

  /** Number of persona groups in feature competition */
  competitionGroups: 3,

  /** Number of personas per group (null = auto-divide available personas) */
  competitionGroupSize: null,

  /** Total personas to pick for competition (null = groups * groupSize or all available) */
  competitionPersonaCount: null,

  /** Number of test questions to generate for winning feature */
  competitionTestQuestions: 3,
};

/**
 * Load user config from evolve.config.mjs and merge with defaults.
 * @param {string} projectRoot - Project root directory
 * @param {string} [customConfigPath] - Optional path to a custom config file
 */
export async function loadConfig(projectRoot, customConfigPath) {
  const root = resolve(projectRoot || '.');
  const configPath = customConfigPath ? resolve(root, customConfigPath) : join(root, 'evolve.config.mjs');

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

  if (!['nearest-upcoming', 'following-week'].includes(config.nextWeekdayMode)) {
    errors.push('Invalid nextWeekdayMode. Use "nearest-upcoming" or "following-week".');
  }

  return errors;
}
