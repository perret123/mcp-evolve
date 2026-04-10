/**
 * mcp-evolve — Init seed: auto-generate describeState from a live data source.
 *
 * Two modes:
 *   1. discoveryPrompt — LLM calls MCP tools to explore data (requires working MCP auth)
 *   2. script          — runs a shell command that dumps data directly (bypasses MCP/auth)
 *
 * Both feed raw output to a describer LLM to produce a structured describeState block.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { claude, readPrompt, parseStreamOutput } from './claude.mjs';
import { llm } from './llm.mjs';

function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

/**
 * Discover data by running the MCP discovery prompt via Claude CLI.
 * Returns raw text summary of tool results.
 */
async function discoverViaMcp(config, seedDataSource) {
  const { discoveryPrompt, discoveryModel } = seedDataSource;

  if (!discoveryPrompt) {
    console.error('\nError: seedDataSource.discoveryPrompt is required when not using script mode.');
    process.exit(1);
  }

  if (!existsSync(config.mcpConfig)) {
    console.error(`\nError: MCP config not found at ${config.mcpConfig}`);
    console.error('Make sure your MCP server config exists and the server is running.');
    process.exit(1);
  }

  const model = discoveryModel || config.answererModel || 'haiku';
  log(`Running MCP discovery with model "${model}"...`);
  log(`  Prompt: ${discoveryPrompt.slice(0, 120)}${discoveryPrompt.length > 120 ? '...' : ''}`);

  let rawDiscovery;
  try {
    rawDiscovery = await claude(discoveryPrompt, {
      mcpConfig: config.mcpConfig,
      strictMcpConfig: true,
      disableBuiltinTools: true,
      allowedTools: config.answererTools,
      model,
      outputFormat: 'stream-json',
      verbose: true,
      timeout: 120_000,
    });
  } catch (err) {
    console.error(`\nDiscovery failed: ${err.message}`);
    console.error('Is the MCP server running? Check your mcpConfig path.');
    process.exit(1);
  }

  if (!rawDiscovery || rawDiscovery.startsWith('ERROR:')) {
    console.error(`\nDiscovery returned an error: ${(rawDiscovery || 'empty response').slice(0, 300)}`);
    console.error('Is the MCP server running? Check your mcpConfig path.');
    process.exit(1);
  }

  const parsed = parseStreamOutput(rawDiscovery);

  if (parsed.errors.length > 0 && parsed.toolCalls.length === 0) {
    console.error('\nDiscovery encountered errors with no successful tool calls:');
    for (const err of parsed.errors.slice(0, 5)) {
      console.error(`  [${err.tool}] ${(err.error || '').slice(0, 200)}`);
    }
    process.exit(1);
  }

  log(`  Discovery complete: ${parsed.toolCalls.length} tool calls, ${parsed.errors.length} errors`);

  const toolSummary = parsed.toolCalls.map(tc => {
    const input = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
    const result = (tc.result || '(no result)').slice(0, 5000);
    return `--- ${tc.tool}(${input}) ---\n${result}`;
  }).join('\n\n');

  if (!toolSummary.trim()) {
    console.error('\nDiscovery returned no tool results. The MCP server may not have responded.');
    process.exit(1);
  }

  return toolSummary;
}

/**
 * Discover data by running a shell script/command.
 * The script should output raw data (text, markdown, JSON) to stdout.
 * Returns the script's stdout.
 */
function discoverViaScript(config, seedDataSource) {
  const { script } = seedDataSource;

  log(`Running extraction script...`);
  log(`  Command: ${script}`);

  let output;
  try {
    output = execSync(script, {
      cwd: config.projectRoot,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = err.stderr ? `\n  stderr: ${err.stderr.slice(0, 300)}` : '';
    console.error(`\nScript failed (exit ${err.status}): ${err.message.slice(0, 200)}${stderr}`);
    process.exit(1);
  }

  if (!output || !output.trim()) {
    console.error('\nScript returned empty output.');
    process.exit(1);
  }

  log(`  Script complete: ${output.length} bytes`);
  return output;
}

/**
 * Run the init-seed workflow:
 * 1. Discover data (via MCP tools or script)
 * 2. Feed raw results to a describer LLM to produce structured state
 * 3. Write seed-state.md to dataDir
 */
export async function initSeed(config, opts = {}) {
  log('mcp-evolve init-seed');
  log(`System: ${config.systemDescription}`);

  // --- Validate ---

  if (!config.seedDataSource) {
    console.error('\nError: No seedDataSource configured in evolve.config.mjs.');
    console.error('Add a seedDataSource block to your config:\n');
    console.error(`  // Option A: LLM discovers data via MCP tools
  seedDataSource: {
    discoveryPrompt: 'Call list_items, then call get_item_details for each...',
    discoveryModel: 'haiku',
  },

  // Option B: Script extracts data directly (bypasses MCP auth)
  seedDataSource: {
    script: 'node scripts/extract-state.mjs --format evolve',
  },

  // Both: script as primary, MCP discovery as fallback
  seedDataSource: {
    script: 'node scripts/extract-state.mjs --format evolve',
    discoveryPrompt: 'Call list_items...',  // used if --mcp-discovery flag is passed
  },
`);
    process.exit(1);
  }

  const { script, discoveryPrompt } = config.seedDataSource;

  if (!script && !discoveryPrompt) {
    console.error('\nError: seedDataSource needs at least one of: script, discoveryPrompt');
    process.exit(1);
  }

  // Ensure data directory exists
  if (!existsSync(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true });
  }

  // --- Step 1: Discover data ---

  // Use script if available (unless --mcp-discovery forces MCP mode)
  const useMcp = opts.mcpDiscovery || (!script && discoveryPrompt);
  let rawData;

  if (useMcp) {
    rawData = await discoverViaMcp(config, config.seedDataSource);
  } else {
    rawData = discoverViaScript(config, config.seedDataSource);
  }

  // --- Step 2: Generate describeState ---
  //
  // If the script already outputs evolve-format text (starts with "TEST DATASET"),
  // skip the LLM step and use it directly.

  let stateDescription;
  const looksLikeEvolveFormat = rawData.trimStart().startsWith('TEST DATASET');

  if (looksLikeEvolveFormat && !opts.forceDescribe) {
    log('Script output is already in evolve format — using directly');
    stateDescription = rawData.trim();
  } else {
    const describerModel = opts.describerModel || config.promptModel || 'sonnet';
    log(`Generating state description with model "${describerModel}"...`);

    const systemPrompt = readPrompt(config.promptsDir, 'seed-describer.md');

    const describerPrompt = [
      `System: ${config.systemDescription}`,
      '',
      'Raw data from discovery:',
      '',
      rawData,
      '',
      'Produce the structured test dataset description now.',
    ].join('\n');

    try {
      stateDescription = await llm(describerPrompt, {
        model: describerModel,
        systemPrompt,
        timeout: 180_000,
      });
    } catch (err) {
      console.error(`\nState description generation failed: ${err.message}`);
      process.exit(1);
    }

    if (!stateDescription || stateDescription.startsWith('ERROR:')) {
      console.error(`\nState description generation failed: ${(stateDescription || 'empty').slice(0, 300)}`);
      process.exit(1);
    }
  }

  // --- Step 3: Write results ---

  const seedStatePath = join(config.dataDir, 'seed-state.md');
  writeFileSync(seedStatePath, stateDescription);
  log(`Wrote state description to ${seedStatePath}`);

  // --- Step 4: Print results and instructions ---

  console.log('\n' + '='.repeat(60));
  console.log('GENERATED STATE DESCRIPTION');
  console.log('='.repeat(60));
  console.log(stateDescription);
  console.log('='.repeat(60));

  console.log(`
Next steps:
  1. Review the generated description above
  2. Edit ${seedStatePath} if anything needs adjustment
  3. Add a describeState block to your evolve.config.mjs:

     import { readFileSync } from 'node:fs';

     describeState: () => readFileSync(
       '.mcp-evolve/seed-state.md', 'utf-8'
     ),

  Or inline it directly in your config.
`);

  return stateDescription;
}
