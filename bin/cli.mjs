#!/usr/bin/env node

/**
 * mcp-evolve CLI
 *
 * Usage:
 *   mcp-evolve                       # Full run, all personas
 *   mcp-evolve init                  # Scaffold starter config
 *   mcp-evolve status                # Show metrics, personas, golden set
 *   mcp-evolve --persona admin       # Single persona
 *   mcp-evolve --limit 2             # 2 questions per persona
 *   mcp-evolve --dry-run             # Generate questions only
 *   mcp-evolve --skip-fixer          # Skip fixer step
 *   mcp-evolve --train               # Train personas only
 *   mcp-evolve --eval                # Eval personas only (hold-out)
 *   mcp-evolve --escalate            # Force escalation
 *   mcp-evolve --regression          # Replay baseline, compare scores
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadConfig, validateConfig } from '../lib/config.mjs';
import { run } from '../lib/run.mjs';
import { scaffoldInit, fullInit } from '../lib/init.mjs';
import { printPersonaMap } from '../lib/personas.mjs';
import { getFullSummary, loadMetrics, getStalePersonas, getSuccessRateTrend } from '../lib/metrics.mjs';
import { loadGoldenSet, loadPromptSet, getPromptsByGroup, checkStreak } from '../lib/eval.mjs';

const { values: args, positionals } = parseArgs({
  options: {
    persona: { type: 'string', short: 'p' },
    limit: { type: 'string', short: 'l' },
    'dry-run': { type: 'boolean' },
    'skip-fixer': { type: 'boolean' },
    'skip-reviewer': { type: 'boolean' },
    train: { type: 'boolean' },
    eval: { type: 'boolean' },
    'answerer-model': { type: 'string' },
    regression: { type: 'boolean' },
    'regression-file': { type: 'string' },
    'golden-max': { type: 'string' },
    'skip-golden': { type: 'boolean' },
    'skip-auto-dev': { type: 'boolean' },
    'skip-grading': { type: 'boolean' },
    'fixer-retries': { type: 'string' },
    compete: { type: 'boolean' },
    'no-compete': { type: 'boolean' },
    escalate: { type: 'boolean' },
    'no-escalate': { type: 'boolean' },
    'streak-threshold': { type: 'string' },
    'init-seed': { type: 'boolean' },
    'mcp-discovery': { type: 'boolean' },
    'current-run': { type: 'string' },
    'total-runs': { type: 'string' },
    config: { type: 'string', short: 'c' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
  strict: false,
});

// --- Commands ---

const command = positionals[0];

if (args.help) {
  console.log(`
mcp-evolve — Self-improving test harness for MCP servers

Commands:
  (default)    Run the full test loop
  init         Scaffold evolve.config.mjs and starter files
  init-seed    Auto-generate describeState from live MCP server data
  status       Show current metrics, persona map, golden set

Options:
  -p, --persona <id>     Run single persona
  -l, --limit <n>        Prompts per persona (default: from config)
  --dry-run              Generate prompts only, don't run
  --skip-fixer           Skip auto-fix step
  --skip-reviewer        Skip review step
  --train                Train personas only
  --eval                 Eval personas only (hold-out, no fixer)
  --escalate             Force escalation
  --no-escalate          Disable auto-escalation
  --regression           Replay baseline prompts
  --answerer-model <m>   Override answerer model (e.g. sonnet)
  --init-seed            Scan data source and generate seed state description
  --mcp-discovery        Force MCP discovery mode (skip script, use discoveryPrompt)
  --current-run <n>      Current run number (for multi-run progress tracking)
  --total-runs <n>       Total planned runs (for multi-run progress tracking)
  --streak-threshold <n> Consecutive 100% runs before escalation (default: 3)
  -v, --verbose          Verbose output
  -h, --help             Show this help
`);
  process.exit(0);
}

if (command === 'init') {
  // If no config exists, scaffold first
  const root = resolve('.');
  const configPath = args.config ? resolve(root, args.config) : null;

  if (!configPath) {
    console.log('Scaffolding mcp-evolve...');
    const created = scaffoldInit(root);
    if (created.length > 0) {
      console.log(`Created: ${created.join(', ')}`);
      console.log('\nNext steps:');
      console.log('  1. Edit evolve.config.mjs — add your MCP server config');
      console.log('  2. Run: mcp-evolve init -c evolve.config.mjs');
    }
    process.exit(0);
  }

  // Full init: generate prompt set
  const initConfig = await loadConfig('.', configPath);
  const qs = await fullInit(initConfig);
  if (qs) {
    console.log(`\nInit complete. Run: mcp-evolve -c ${args.config}`);
  } else {
    console.error('Init failed.');
    process.exit(1);
  }
  process.exit(0);
}

if (args['init-seed'] || command === 'init-seed') {
  const { initSeed } = await import('../lib/init-seed.mjs');
  const seedConfig = await loadConfig('.', args.config);
  await initSeed(seedConfig, {
    verbose: args.verbose,
    mcpDiscovery: args['mcp-discovery'],
  });
  process.exit(0);
}

// Load config
const config = await loadConfig('.', args.config);
const errors = validateConfig(config);

if (command === 'status') {
  const statusConfig = await loadConfig('.', args.config);
  console.log(printPersonaMap(statusConfig.personas));
  console.log('');

  try {
    const summary = getFullSummary(config);
    console.log(`Runs: ${summary.totalRuns} | Fixes: ${summary.fixRate} | Escalations: ${summary.escalationRate}`);
    console.log(`Plateau: ${summary.plateau.plateau ? 'YES — ' + summary.plateau.reason : 'No'}`);

    const streak = checkStreak(3, config);
    console.log(`Streak: ${streak.streak} consecutive 100%`);

    const ps = loadPromptSet(config);
    if (ps) {
      const train = getPromptsByGroup(ps, 'train');
      const golden = getPromptsByGroup(ps, 'golden');
      console.log(`\nPrompt set: ${ps.prompts.length} total (${train.length} train, ${golden.length} golden)`);
      for (const q of ps.prompts) {
        const badge = q.group === 'golden' ? '[golden]' : `[train ${q.consecutivePasses || 0}/${config.graduationStreak || 10}]`;
        console.log(`  ${badge} [${q.persona}] ${q.prompt.slice(0, 70)}`);
      }
    } else {
      const gs = loadGoldenSet(config);
      console.log(`\nGolden set (legacy): ${gs.prompts.length} prompts`);
      for (const q of gs.prompts) {
        console.log(`  [${q.persona}] ${q.prompt.slice(0, 80)}`);
      }
    }

    const stale = getStalePersonas(config, 3);
    if (stale.length > 0) {
      console.log(`\nStale personas (3+ runs without failure):`);
      for (const p of stale) console.log(`  ${p.id}: ${p.runsSinceLastFailure} runs clean`);
    }

    const trend = getSuccessRateTrend(config, 5);
    if (trend.length > 0) {
      console.log(`\nRecent runs:`);
      for (const r of trend) console.log(`  ${r.timestamp.slice(0, 19)} ${r.successRate}% (${r.prompts}p)`);
    }
  } catch {
    console.log('No metrics yet. Run mcp-evolve first to build data.');
  }

  process.exit(0);
}

// Validate config for run
if (errors.length > 0) {
  console.error('Configuration errors:');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nRun `mcp-evolve init` to create a starter config.');
  process.exit(1);
}

// Run
await run(config, {
  promptLimit: args.limit ? parseInt(args.limit, 10) : undefined,
  dryRun: args['dry-run'],
  skipFixer: args['skip-fixer'],
  skipReviewer: args['skip-reviewer'],
  trainOnly: args.train,
  evalOnly: args.eval,
  answererModel: args['answerer-model'],
  isRegression: args.regression,
  regressionFile: args['regression-file'],
  goldenMax: args['golden-max'] ? parseInt(args['golden-max'], 10) : undefined,
  skipGolden: args['skip-golden'],
  skipAutoDev: args['skip-auto-dev'],
  skipGrading: args['skip-grading'],
  fixerRetries: args['fixer-retries'] ? parseInt(args['fixer-retries'], 10) : 1,
  forceCompete: args.compete,
  noCompete: args['no-compete'],
  forceEscalate: args.escalate,
  noEscalate: args['no-escalate'],
  streakThreshold: args['streak-threshold'] ? parseInt(args['streak-threshold'], 10) : 3,
  verbose: args.verbose,
  personaFilter: args.persona,
  currentRun: args['current-run'] ? parseInt(args['current-run'], 10) : 1,
  totalRuns: args['total-runs'] ? parseInt(args['total-runs'], 10) : 1,
});
