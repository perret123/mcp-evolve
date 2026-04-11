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

  /** Tools the reviewer can use. Includes Bash for git log checks in the audit checklist. */
  reviewerTools: 'Read,Edit,Grep,Glob,Bash',

  /** Kill-switch for the reviewer audit upgrade. Default true (audit enabled). Set false to revert to pre-Spec-1 merge-only behavior. */
  reviewerAuditEnabled: true,

  /** Tool names (or patterns) that are write/mutation tools — used for action detection */
  writeTools: [],

  /** Default prompts per persona */
  promptsPerPersona: 3,

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
   * Fed to the prompt generator so it knows what data exists and can
   * generate prompts that are answerable. Should describe: what entities
   * exist, their state, what's NOT there, and any constraints.
   * Receives (config), returns a string.
   */
  describeState: null,

  /**
   * Optional async prefetch function — runs before prompt generation
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

  /**
   * Optional seed data source configuration for --init-seed.
   * Used to auto-generate a describeState block by scanning a live MCP server.
   * Shape: { discoveryPrompt: string, discoveryModel?: string }
   * - discoveryPrompt: MCP tool calls to explore what data exists
   * - discoveryModel: model for discovery (default: answererModel or 'haiku')
   */
  seedDataSource: null,

  /** System/domain description — used in prompts to describe the server */
  systemDescription: 'an MCP server',

  /** Language hint for prompt generation */
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

  /** Model for running prompts (answerer) */
  answererModel: 'sonnet',

  /** Model for grading responses */
  graderModel: 'sonnet',

  /** Model for fixing errors */
  fixerModel: 'sonnet',

  /** Model for reviewing descriptions */
  reviewerModel: 'sonnet',

  /** Model for generating prompts */
  promptModel: 'sonnet',

  /** Model for escalation */
  escalatorModel: 'sonnet',

  /** Model for feature proposals in competition */
  proposalModel: 'sonnet',

  /** Model for voting in competition */
  voterModel: 'sonnet',

  /** Model for extra test prompt generation in competition */
  competitionModel: 'sonnet',

  /** Model for metamorphic probes (cheap before/after reads) */
  probeModel: 'haiku',

  /** Model for prefetch live-state discovery */
  prefetchModel: 'sonnet',

  /** Timeout (ms) for prefetch LLM call */
  prefetchTimeout: 60_000,

  // --- Timeouts (ms) per role ---
  /** Timeout for prompt generation */
  promptTimeout: 600_000,
  /** Timeout for answerer (running prompts against MCP tools) */
  answererTimeout: 180_000,
  /** Timeout for grading responses */
  graderTimeout: 60_000,
  /** Timeout for fixer */
  fixerTimeout: 300_000,
  /** Timeout for reviewer */
  reviewerTimeout: 300_000,
  /** Timeout for escalation prompt generation */
  escalatorTimeout: 300_000,
  /** Timeout for metamorphic probes */
  probeTimeout: 60_000,
  /** Timeout for build command */
  buildTimeout: 30_000,

  // --- Init & prompt set configuration ---

  /** Total prompts to generate during init */
  initPrompts: 20,

  /** Percentage of init prompts randomly promoted to golden/eval */
  initGoldenPercent: 30,

  /** Minimum model errors in a run before model-error fixer fires */
  modelErrorThreshold: 3,

  /** Holdout prompts per persona (K). Must be strictly less than promptsPerPersona. */
  holdoutPerPersona: 1,

  /** Overfitting threshold — `train_post - train_pre > X` AND `holdout_post - holdout_pre < -X` → overfittingDetected. */
  overfittingThreshold: 0.1,

  /** Max promoter nominations per run. */
  maxPromotionsPerRun: 3,

  /** Model for the Promoter-Agent */
  promoterModel: 'sonnet',

  /** File name in `prompts/` that holds the promoter system prompt */
  promoterPromptFile: 'promoter.md',

  /** Timeout (ms) for the promoter LLM call */
  promoterTimeout: 180_000,

  /** Context window for local models (null = model default, e.g. 262144) */
  localContextWindow: null,

  /** Max output tokens for local models (thinking + response, null = model default) */
  localMaxPredict: null,

  /** Max concurrent requests to local models (matches OLLAMA_NUM_PARALLEL) */
  localConcurrency: 1,

  /** Per-iteration timeout (ms) for local model tool-call loops */
  localIterationTimeout: 180_000,

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

  /** Number of test prompts to generate for winning feature */
  competitionTestPrompts: 3,

  // --- Distribution guards ---

  /** JSD threshold for escalation drift (0-1, higher = more permissive) */
  driftThreshold: 0.4,

  /** Action on high drift: 'warn', 'reject', 'regenerate' */
  driftAction: 'warn',

  /** Rate of adversarial prompts (0-1, per persona generation call). V1 defaults to 0 — the generator does not produce adversarial prompts automatically. Manually-added prompts with `adversarial: true` are still honored. */
  adversarialRatio: 0,

  /** Minimum persona entropy ratio (0-1, below triggers warning) */
  personaEntropyFloor: 0.7,

  /** Minimum tool entropy ratio (0-1, below triggers warning) */
  toolEntropyFloor: 0.5,
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
  merged.promptSetPath = join(merged.dataDir, 'prompt-set.json');
  merged.metricsPath = join(merged.dataDir, 'metrics.json');
  merged.failingPromptsPath = join(merged.dataDir, 'failing-prompts.json');

  if (merged.knowledgeDir) {
    merged.knowledgeDir = resolve(root, merged.knowledgeDir);
  }

  merged.srcDirs = merged.srcDirs.map(d => resolve(root, d));

  // Resolve prompts dir (bundled with mcp-evolve)
  merged.promptsDir = new URL('../prompts', import.meta.url).pathname;

  // Sanity check — holdoutPerPersona must be strictly less than promptsPerPersona
  if (merged.holdoutPerPersona >= merged.promptsPerPersona) {
    throw new Error(
      `Invalid config: holdoutPerPersona (${merged.holdoutPerPersona}) must be strictly less than promptsPerPersona (${merged.promptsPerPersona}).`
    );
  }

  // Warn if any persona still declares a `group` field (removed in Spec 2).
  for (const p of merged.personas || []) {
    if (p && typeof p === 'object' && 'group' in p) {
      console.warn(`[config] Persona "${p.id}" has a "group" field — this field is ignored in Spec 2. Remove it from evolve.config.mjs.`);
    }
  }

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
