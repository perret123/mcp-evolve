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
import { init } from '../lib/init.mjs';
import { printPersonaMap } from '../lib/personas.mjs';
import { getFullSummary, loadMetrics, getStalePersonas, getSuccessRateTrend } from '../lib/metrics.mjs';
import { loadGoldenSet, checkStreak } from '../lib/eval.mjs';

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
    escalate: { type: 'boolean' },
    'no-escalate': { type: 'boolean' },
    'streak-threshold': { type: 'string' },
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
  status       Show current metrics, persona map, golden set

Options:
  -p, --persona <id>     Run single persona
  -l, --limit <n>        Questions per persona (default: from config)
  --dry-run              Generate questions only, don't answer
  --skip-fixer           Skip auto-fix step
  --skip-reviewer        Skip review step
  --train                Train personas only
  --eval                 Eval personas only (hold-out, no fixer)
  --escalate             Force escalation
  --no-escalate          Disable auto-escalation
  --regression           Replay baseline questions
  --answerer-model <m>   Override answerer model (e.g. sonnet)
  --streak-threshold <n> Consecutive 100% runs before escalation (default: 3)
  -v, --verbose          Verbose output
  -h, --help             Show this help
`);
  process.exit(0);
}

if (command === 'init') {
  const root = resolve('.');
  console.log('Initializing mcp-evolve...');
  const created = init(root);
  if (created.length > 0) {
    console.log(`Created: ${created.join(', ')}`);
    console.log('\nNext steps:');
    console.log('  1. Edit evolve.config.mjs — add your personas and MCP server config');
    console.log('  2. Edit mcp-evolve.json — point to your MCP server');
    console.log('  3. Run: npx mcp-evolve --dry-run');
  } else {
    console.log('Everything already exists.');
  }
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

    const gs = loadGoldenSet(config);
    console.log(`\nGolden set: ${gs.questions.length} questions`);
    for (const q of gs.questions) {
      console.log(`  [${q.persona}] ${q.question.slice(0, 80)}`);
    }

    const stale = getStalePersonas(config, 3);
    if (stale.length > 0) {
      console.log(`\nStale personas (3+ runs without failure):`);
      for (const p of stale) console.log(`  ${p.id}: ${p.runsSinceLastFailure} runs clean`);
    }

    const trend = getSuccessRateTrend(config, 5);
    if (trend.length > 0) {
      console.log(`\nRecent runs:`);
      for (const r of trend) console.log(`  ${r.timestamp.slice(0, 19)} ${r.successRate}% (${r.questions}q)`);
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
  questionLimit: args.limit ? parseInt(args.limit, 10) : config.questionsPerPersona,
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
  forceEscalate: args.escalate,
  noEscalate: args['no-escalate'],
  streakThreshold: args['streak-threshold'] ? parseInt(args['streak-threshold'], 10) : 3,
  verbose: args.verbose,
  personaFilter: args.persona,
});
