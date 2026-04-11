/**
 * mcp-evolve — Core test loop.
 *
 * Generates prompts from personas, runs them via MCP tools,
 * scores results, fixes failures, escalates when passing.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claude, readPrompt, parseStreamOutput } from './claude.mjs';
import * as progress from './progress.mjs';

/**
 * Safely wrap `fn` as a phase in the progress tracker. Emits phase_start
 * before fn() and a paired phase_end after, even on error. Never throws from
 * its own bookkeeping — the main loop should never crash because of timings.
 */
async function withPhase(prog, phase, fn) {
  try { progress.setPhase(prog, phase); } catch { /* non-critical */ }
  try {
    return await fn();
  } finally {
    try { progress.setPhase(prog, 'idle'); } catch { /* non-critical */ }
  }
}
import { llm, llmWithTools, parseModelSpec, isLocalModel, setLlmConfig } from './llm.mjs';
import {
  buildRunDateContext,
  resolvePromptDateContext,
  formatDateContextForPrompt,
} from './dates.mjs';
import { getPersona, getPersonasByGroup } from './personas.mjs';
import {
  scorePrompt, aggregateScores, saveBaseline, loadBaseline,
  compareToBaseline, printRegressionReport, checkDiversity, computeDistributionDrift, getPreviousPrompts,
  loadGoldenSet, promoteToGoldenSet, getGoldenPrompts, checkStreak, updateGoldenHealth,
  loadPromptSet, savePromptSet, updatePromptSetAfterRun, addTrainPrompts, getPromptsByGroup,
  isActionRequest as isActionRequestFn,
  buildActionPattern,
  isPassingScore,
  classifyErrorCategory,
} from './eval.mjs';
import { updateMetrics, recordEscalation, computeTestingEntropy } from './metrics.mjs';
import { autoDev } from './autodev.mjs';
import { runCompetition } from './compete.mjs';
import { runAuditAndMerge } from './audit.mjs';
import { getFailingPatterns } from './failing-prompts.mjs';

// --- Debug log monitoring ---

const ERROR_PATTERNS = /WARNING|ERROR|SEVERE|Exception|PERMISSION_DENIED|UNAUTHENTICATED|INTERNAL|FAILED_PRECONDITION|NOT_FOUND|ALREADY_EXISTS/;
const NOISE_PATTERNS = /Detected non-HTTP|channelRead|HttpVersionRouting/;

function snapshotLogPositions(config) {
  const positions = {};
  for (const logFile of (config.debugLogFiles || [])) {
    try {
      positions[logFile] = readFileSync(logFile, 'utf-8').split('\n').length;
    } catch { positions[logFile] = 0; }
  }
  return positions;
}

function collectNewLogErrors(snapshot, config) {
  const errors = [];
  for (const logFile of (config.debugLogFiles || [])) {
    try {
      const lines = readFileSync(logFile, 'utf-8').split('\n');
      const startLine = snapshot[logFile] || 0;
      const newLines = lines.slice(startLine);
      let currentError = null;
      for (let i = 0; i < newLines.length; i++) {
        const line = newLines[i];
        if (NOISE_PATTERNS.test(line)) continue;
        if (ERROR_PATTERNS.test(line)) {
          if (currentError) errors.push(currentError);
          currentError = { file: logFile.split('/').pop(), lineNumber: startLine + i + 1, text: line };
        } else if (currentError && (line.startsWith('\t') || line.startsWith('  at ') || line.startsWith('Caused by'))) {
          currentError.text += '\n' + line;
        } else if (currentError) {
          errors.push(currentError);
          currentError = null;
        }
      }
      if (currentError) errors.push(currentError);
    } catch { /* file might not exist */ }
  }
  return errors;
}

// --- Helpers ---

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function matchesWriteTools(toolName, config) {
  const clean = toolName.replace(config.mcpToolPrefix || '', '');
  for (const pattern of config.writeTools || []) {
    if (pattern.includes('*')) {
      const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (re.test(clean) || re.test(toolName)) return true;
    } else {
      if (clean === pattern || toolName === pattern || clean.includes(pattern)) return true;
    }
  }
  return false;
}

const NON_FIXABLE_HARNESS_TOOLS = new Set([
  'harness:tool-availability',
  'harness:healthcheck',
  'harness:output-truncation',
]);

function isOutputTruncationIssue(text) {
  return /\b(truncated|cut off|mid-sentence|incomplete response|ends abruptly)\b/i.test(text || '');
}

function isInvalidRunError(error) {
  return error?.tool === 'harness:tool-availability' || error?.tool === 'harness:healthcheck';
}

function collectInvalidRunReasons(allErrors, healthcheckResult) {
  const reasons = [];

  if (healthcheckResult && !healthcheckResult.ok) {
    reasons.push(`Healthcheck failed: ${healthcheckResult.error || 'unknown error'}`);
  }

  const toolAvailabilityErrors = allErrors.filter(isInvalidRunError);
  if (toolAvailabilityErrors.length > 0) {
    reasons.push(`Configured MCP tools were unavailable in ${toolAvailabilityErrors.length} prompt(s)`);
  }

  return [...new Set(reasons)];
}

async function runHealthcheck(config, runDateContext) {
  if (!config.healthcheck) return { ok: true, skipped: true, details: null };

  log('Running healthcheck...');
  try {
    const result = await config.healthcheck({ config, runDateContext });
    if (result === false) {
      return { ok: false, error: 'healthcheck returned false', details: null };
    }
    if (result && typeof result === 'object' && result.ok === false) {
      return {
        ok: false,
        error: result.error || 'healthcheck returned ok=false',
        details: result.details || null,
      };
    }
    const details = typeof result === 'string'
      ? result
      : result && typeof result === 'object'
        ? result.details || null
        : null;
    if (details) log(`  Healthcheck: ${details}`);
    return { ok: true, details };
  } catch (err) {
    return { ok: false, error: err.message || String(err), details: null };
  }
}

// --- Seed / Reset / Prefetch ---

export async function runSeed(config) {
  if (!config.seed) return;
  log('Seeding test environment...');
  try {
    await config.seed(config);
    log('  Seed complete');
  } catch (err) {
    log(`  Seed failed: ${err.message?.slice(0, 100)}`);
  }
}

export async function runReset(config) {
  if (!config.reset) return;
  log('Resetting test environment...');
  try {
    await config.reset(config);
    log('  Reset complete');
  } catch (err) {
    log(`  Reset failed: ${err.message?.slice(0, 100)}`);
  }
}

export function getStateDescription(config) {
  if (!config.describeState) return '';
  try {
    return config.describeState(config);
  } catch {
    return '';
  }
}

export async function runPrefetch(config) {
  if (!config.prefetch) return '';
  log('Running prefetch...');
  try {
    // Pass a model-aware function: routes local models through llmWithTools,
    // Claude models through claude CLI. Normalizes return to plain text.
    const prefetchFn = async (prompt, opts = {}) => {
      const model = opts.model || config.prefetchModel || 'sonnet';
      if (isLocalModel(model)) {
        const res = await llmWithTools(prompt, { ...opts, model });
        if (res && res.__localResult) return res.response || '';
        return typeof res === 'string' ? res : '';
      }
      return claude(prompt, { ...opts, model });
    };
    const result = await config.prefetch(prefetchFn, config);
    if (result) log(`  Prefetch returned ${result.length} chars`);
    return result || '';
  } catch (err) {
    log(`  Prefetch failed: ${err.message?.slice(0, 100)}`);
    return '';
  }
}

// --- Generate prompts ---

export async function generatePrompts(persona, config, fullContext, runDateContext, failingEntries = []) {
  log(`Generating ${config.promptsPerPersona} prompts for "${persona.name}"...`);

  const previousPrompts = getPreviousPrompts(persona.id, config);
  const diversityHint = previousPrompts.length > 0
    ? `\n\nIMPORTANT: Vary your phrasing. These prompts were used before — do NOT repeat them:\n${previousPrompts.map(q => `- ${q}`).join('\n')}`
    : '';

  const adversarial = Math.random() < (config.adversarialRatio || 0);

  const prefetchHint = fullContext
    ? adversarial
      ? `\n\nReal data from the system (for reference, but you may IGNORE it for this prompt):\n${fullContext}`
      : `\n\nIMPORTANT: Use ONLY real data from the system:\n${fullContext}`
    : '';
  const dateHint = runDateContext
    ? `\n\nIMPORTANT: Use this run-level date context for any date-based prompts:\n${formatDateContextForPrompt(runDateContext)}`
    : '';

  const adversarialHint = adversarial
    ? '\n\nThis prompt MUST be adversarial: reference a nonexistent ID, misspell a name, ask to delete something already gone, or provide contradictory constraints. Set `"adversarial": true` on each generated prompt JSON object.'
    : '';

  const antiExamples = failingEntries.length > 0
    ? [
        '',
        '## Anti-Examples — DO NOT generate semantically similar prompts',
        '',
        'The following prompts were previously determined to trigger fabrication, contain contaminated invariants, or otherwise mislead the test loop. Avoid producing prompts that would exercise the same behavior or produce the same errors.',
        '',
        ...failingEntries.slice(0, 15).map(e => {
          const err = e.triggeringError?.fullError
            ? String(e.triggeringError.fullError).slice(0, 200)
            : '(no error text)';
          return `- Prompt: "${(e.prompt || '(pattern-level)').slice(0, 200)}"\n  Reason: ${e.reason}\n  Error it produced: ${err}`;
        }),
      ].join('\n')
    : '';

  const generationPrompt = [
    `System: ${config.systemDescription}`,
    '',
    `You are: ${persona.description}`,
    '',
    `Your main concerns: ${persona.concerns.join(', ')}`,
    `Your style: ${persona.questionStyle || 'Natural and direct.'}`,
    '',
    `Generate exactly ${config.promptsPerPersona} realistic prompts you would send to an AI assistant about this system.`,
    diversityHint,
    prefetchHint,
    dateHint,
    adversarialHint,
    antiExamples,
    '',
    `Language: ${config.language || 'English'}`,
    '',
    'Reply with ONLY a JSON object: {"prompts": [{"prompt": "text", "probe": "probe prompt", "invariant": "rule", "probeType": "action|read", "adversarial": false}]}',
  ].join('\n');

  const output = await llm(generationPrompt, {
    systemPrompt: readPrompt(config.promptsDir, 'user-sim.md'),
    model: config.promptModel || 'sonnet',
    timeout: config.promptTimeout || 600_000,
  });

  try {
    return JSON.parse(output).prompts || [];
  } catch {
    const match = output.match(/\{[\s\S]*"prompts"[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]).prompts || []; } catch { /* fall through */ }
    }
    log(`  Could not parse prompts. Raw: ${output.slice(0, 300)}`);
    return [];
  }
}

// --- Run prompts ---

export async function runPrompt(promptText, persona, config, runDateContext, overrides = {}) {
  log(`  Running: "${promptText.slice(0, 80)}..."`);
  const logSnapshot = snapshotLogPositions(config);

  const userName = persona.name?.split('(')[0]?.trim() || persona.id;
  const promptDateContext = resolvePromptDateContext(promptText, runDateContext);
  const effectiveModel = overrides.model || config.answererModel;

  const fullPrompt = [
    'Run date context:',
    formatDateContextForPrompt(promptDateContext),
    '',
    `User: ${userName}`,
    '',
    `Prompt: ${promptText}`,
  ].join('\n');

  let result;
  if (isLocalModel(effectiveModel)) {
    // Local model: use MCP client + tool-calling loop
    const output = await llmWithTools(fullPrompt, {
      systemPrompt: readPrompt(config.promptsDir, 'answerer.md'),
      mcpConfig: config.mcpConfig,
      allowedTools: config.answererTools,
      model: effectiveModel,
      cwd: config.projectRoot,
      timeout: config.answererTimeout || 180_000,
    });
    // llmWithTools returns { __localResult, response, toolCalls, errors }
    result = output.__localResult
      ? { response: output.response, toolCalls: output.toolCalls, errors: output.errors }
      : parseStreamOutput(output);
  } else {
    // Claude CLI: existing path
    const output = await claude(fullPrompt, {
      systemPrompt: readPrompt(config.promptsDir, 'answerer.md'),
      mcpConfig: config.mcpConfig,
      strictMcpConfig: true,
      disableBuiltinTools: true,
      outputFormat: 'stream-json',
      verbose: true,
      allowedTools: config.answererTools,
      model: effectiveModel,
      cwd: config.projectRoot,
    });
    result = parseStreamOutput(output);
  }

  const debugLogErrors = collectNewLogErrors(logSnapshot, config);
  result.debugLogErrors = debugLogErrors;
  result.dateContext = promptDateContext;

  // Detect stuck-in-read-loop (with context-aware action detection)
  const toolNames = result.toolCalls.map(t => t.tool);
  const usingLocalModel = isLocalModel(overrides.model || config.answererModel);
  const calledWrite = toolNames.some(t => matchesWriteTools(t, config));
  const isAction = isActionRequestFn(promptText, config.actionVerbs);
  // Local models use unprefixed tool names (e.g. 'list_tasks' not 'mcp__server__list_tasks')
  const matchedExpectedTool = usingLocalModel
    ? toolNames.length > 0
    : config.mcpToolPrefix
      ? toolNames.some(t => t.startsWith(config.mcpToolPrefix))
      : toolNames.length > 0;
  const responseMentionsUnavailableTools = /don't have .*mcp tools|mcp tools.*unavailable|only tool available.*lsp|only have access to .*lsp/i.test(result.response || '');

  if (config.mcpToolPrefix && !matchedExpectedTool && (toolNames.length > 0 || responseMentionsUnavailableTools) && !usingLocalModel) {
    result.errors.push({
      tool: 'harness:tool-availability',
      input: { prompt: promptText, toolsCalled: toolNames },
      error: `Expected tool calls with prefix "${config.mcpToolPrefix}" but got ${toolNames.length > 0 ? toolNames.join(', ') : 'no MCP tool calls'}.`,
    });
    result.invalidHarnessState = true;
  }

  if (isAction && !calledWrite && toolNames.length >= 5) {
    log(`  WARNING: Action request but no write tool called after ${toolNames.length} tool calls`);
    result.errors.push({
      tool: 'harness:stuck-in-read-loop',
      input: { prompt: promptText, toolsCalled: toolNames },
      error: `LLM made ${toolNames.length} read calls but never called a write tool for an action request.`,
    });
  }

  if (result.errors.length > 0) {
    log(`  ERRORS: ${result.errors.length}`);
    for (const err of result.errors) {
      log(`    ${err.tool}: ${typeof err.error === 'string' ? err.error.slice(0, 150) : JSON.stringify(err.error).slice(0, 150)}`);
    }
  }

  return result;
}

// --- Grade responses ---

export async function gradeResponse(promptText, result, persona, config, runDateContext, probeContext = {}) {
  const toolLog = result.toolCalls.map(tc => {
    return `Tool: ${tc.tool}\nInput: ${JSON.stringify(tc.input)}\nResult: ${tc.result || '(no result captured)'}`;
  }).join('\n---\n');

  const userName = persona?.name?.split('(')[0]?.trim() || persona?.id || 'unknown';
  const promptDateContext = result.dateContext || resolvePromptDateContext(promptText, runDateContext);
  const isAction = isActionRequestFn(promptText, config.actionVerbs);
  const writeToolCalled = result.toolCalls.some(tc => matchesWriteTools(tc.tool, config));
  const writeTools = (config.writeTools || []).join(', ') || '(none configured)';

  const probeSection = probeContext.beforeProbe && probeContext.afterProbe ? [
    `\n## Metamorphic Probe`,
    `Probe type: ${probeContext.probeType || 'unknown'}`,
    `Invariant to verify: ${probeContext.invariant || '(none)'}`,
    `\n### Before (state before main prompt)`,
    `Probe: ${probeContext.probe}`,
    `Probe response: ${probeContext.beforeProbe.response.slice(0, 1500)}`,
    `\n### After (state after main prompt)`,
    `Probe: ${probeContext.probe}`,
    `Probe response: ${probeContext.afterProbe.response.slice(0, 1500)}`,
  ].join('\n') : '';

  const adversarialHint = probeContext.adversarial === true
    ? `\nAdversarial: true (the prompt is DESIGNED to fail. Score pass when errors appear. Fail only if the tool returned false success.)`
    : '';

  const graderPrompt = [
    `## Run date context\n${formatDateContextForPrompt(promptDateContext)}`,
    `\n## Harness contract\nSystem: ${config.systemDescription}\nConfigured write tools: ${writeTools}\nPrompt is action request: ${isAction ? 'yes' : 'no'}\nIf this is an action request, it only counts as complete if a configured write tool was called OR the request was already satisfied and the assistant clearly explained the no-op.${adversarialHint}`,
    `## User\n${userName}`,
    `\n## Prompt\n${promptText}`,
    `\n## Tool calls and results\n${toolLog || '(no tools called)'}`,
    `\n## Final response\n${result.response.slice(0, 1500)}`,
    probeSection,
  ].join('\n');

  try {
    const output = await llm(graderPrompt, {
      systemPrompt: readPrompt(config.promptsDir, 'grader.md'),
      model: config.graderModel,
      timeout: config.graderTimeout || 60_000,
    });

    const match = output.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const grade = JSON.parse(match[0]);
    const normalized = {
      pass: !!grade.pass,
      issues: Array.isArray(grade.issues) ? grade.issues : [],
      actionExpectation: grade.actionExpectation || (
        isAction
          ? (writeToolCalled ? 'write_performed' : 'missing_write')
          : 'not_action'
      ),
      invariantResult: grade.invariantResult || 'skipped',
      promptStatus: grade.promptStatus || grade.questionStatus || 'valid',
    };

    if (!normalized.pass && normalized.issues.length > 0) {
      log(`  GRADING ISSUES: ${normalized.issues.join('; ')}`);
    }
    return normalized;
  } catch {
    // Grading failure is non-fatal — skip silently
  }

  return null;
}

// --- Fix errors ---

async function fixError(error, debugLogErrors, config) {
  log(`  Running fixer for ${error.tool}...`);
  const isReadLoop = error.tool === 'harness:stuck-in-read-loop';
  const isGrading = error.tool === 'harness:grading';

  const debugLogContext = debugLogErrors.length > 0
    ? `\n\n**Debug logs:**\n\`\`\`\n${debugLogErrors.map(e => `[${e.file}:${e.lineNumber}] ${e.text}`).join('\n').slice(0, 2000)}\n\`\`\``
    : '';

  const srcDirHint = config.srcDirs.length > 0
    ? `The MCP server source is at: ${config.srcDirs.join(', ')}`
    : 'Find the MCP server source in the project.';

  const fixerPrompt = isReadLoop ? [
    `During automated MCP testing, an LLM was asked to perform an action but couldn't figure out how to call the write tool.`,
    `\n**User request:** ${error.input?.prompt || 'unknown'}`,
    `**Tools called instead:** ${(error.input?.toolsCalled || []).join(', ')}`,
    `**Problem:** ${error.error}`,
    `\n${srcDirHint}`,
    `The issue is almost certainly that the write tool's description or inputSchema doesn't give enough information for an LLM to construct the correct parameters.`,
    `Read the write tools, find the relevant one, and improve its description and parameter descriptions.`,
    debugLogContext,
  ] : isGrading ? [
    `An automated QA grader found a semantic issue with the MCP tool's behavior.`,
    `The tool call succeeded (no error), but the result was incorrect or incomplete.`,
    `\n**User prompt:** ${error.input?.prompt || 'unknown'}`,
    `**Issue found:** ${error.error}`,
    `\n${srcDirHint}`,
    `This is a logic bug or data issue in the tool implementation — the tool returned wrong or incomplete data.`,
    `Read the relevant tool source code, understand the bug, and fix the implementation.`,
    debugLogContext,
  ] : [
    `An MCP tool call failed during automated testing.`,
    `\n**Tool:** ${error.tool}`,
    `**Input:** ${JSON.stringify(error.input, null, 2)}`,
    `**Error:** ${typeof error.error === 'string' ? error.error : JSON.stringify(error.error)}`,
    debugLogContext,
    `\n${srcDirHint}`,
    `Read the relevant tool file, understand the issue, and fix it.`,
  ];

  return await claude(fixerPrompt.join('\n'), {
    systemPrompt: readPrompt(config.promptsDir, 'fixer.md'),
    allowedTools: config.fixerTools,
    model: config.fixerModel,
    timeout: config.fixerTimeout || 300_000,
    cwd: config.projectRoot,
  });
}

// --- Git mutex (serializes worktree creation to avoid index.lock races) ---

let _gitMutex = Promise.resolve();

async function withGitLock(fn) {
  const prev = _gitMutex;
  let resolve;
  _gitMutex = new Promise(r => { resolve = r; });
  await prev;
  try {
    return await fn();
  } finally {
    resolve();
  }
}

// --- Worktree-based fixer ---

async function fixErrorInWorktree(error, debugLogErrors, config, slug) {
  const { execSync: execS } = await import('node:child_process');
  const { mkdirSync: mkS, existsSync: exS } = await import('node:fs');

  const worktreeBase = join(config.dataDir || join(config.projectRoot, '.mcp-evolve'), 'worktrees');
  if (!exS(worktreeBase)) mkS(worktreeBase, { recursive: true });

  const branchName = `fix/${slug}`;
  const worktreePath = join(worktreeBase, slug);

  try {
    // Create worktree from current HEAD (serialized via mutex to avoid index.lock races)
    await withGitLock(() => {
      execS(`git worktree add -b "${branchName}" "${worktreePath}" HEAD`, {
        cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000,
      });
    });

    // Run the fixer in the worktree (isolated copy)
    await fixError(error, debugLogErrors, { ...config, projectRoot: worktreePath });

    // Check if anything changed
    const diff = execS('git diff --stat', { cwd: worktreePath, encoding: 'utf-8', timeout: 5_000 }).trim();
    if (!diff) {
      // No changes — clean up
      execS(`git worktree remove "${worktreePath}" --force`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000 });
      execS(`git branch -D "${branchName}"`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 5_000 });
      return null;
    }

    // Commit changes in worktree
    execS('git add -A', { cwd: worktreePath, encoding: 'utf-8', timeout: 5_000 });
    execS(`git commit -m "fix: ${error.tool} — ${(error.error || '').slice(0, 60)}"`, {
      cwd: worktreePath, encoding: 'utf-8', timeout: 5_000,
    });

    return { branchName, worktreePath, slug };
  } catch (err) {
    // Clean up on error
    try { execS(`git worktree remove "${worktreePath}" --force`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000 }); } catch {}
    try { execS(`git branch -D "${branchName}"`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 5_000 }); } catch {}
    log(`  Worktree fix failed: ${err.message || err}`);
    return null;
  }
}

/**
 * Run the model-error fixer inside a git worktree so its output can be audited.
 * Returns { branchName, worktreePath, slug } or null if no changes were produced.
 */
async function runModelErrorFixerInWorktree(filteredModelErrors, config) {
  const { execSync: execS } = await import('node:child_process');

  const worktreeBase = join(config.dataDir || join(config.projectRoot, '.mcp-evolve'), 'worktrees');
  if (!existsSync(worktreeBase)) mkdirSync(worktreeBase, { recursive: true });

  const slug = `model-error-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-').slice(0, 40);
  const branchName = `fix/${slug}`;
  const worktreePath = join(worktreeBase, slug);

  try {
    await withGitLock(() => {
      execS(`git worktree add -b "${branchName}" "${worktreePath}" HEAD`, {
        cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000,
      });
    });

    const errorSummary = filteredModelErrors.map(me =>
      `[${me.persona.id}] Prompt: "${me.prompt.slice(0, 100)}"\n  Errors: ${me.errors.map(e => e.error || e.tool).join('; ')}`
    ).join('\n\n');

    const srcDirHint = config.srcDirs.length > 0
      ? `The MCP server source is at: ${config.srcDirs.join(', ')}`
      : 'Find the MCP server source in the project.';

    await claude(
      [
        `${filteredModelErrors.length} prompts failed due to model errors (the LLM couldn't use the tools correctly).`,
        `\n${errorSummary}`,
        `\n${srcDirHint}`,
      ].join('\n'),
      {
        systemPrompt: readPrompt(config.promptsDir, 'fixer-model-error.md'),
        allowedTools: config.fixerTools,
        model: config.fixerModel,
        timeout: config.fixerTimeout || 300_000,
        cwd: worktreePath,
      },
    );

    const diff = execS('git diff --stat', { cwd: worktreePath, encoding: 'utf-8', timeout: 5_000 }).trim();
    if (!diff) {
      execS(`git worktree remove "${worktreePath}" --force`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000 });
      execS(`git branch -D "${branchName}"`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 5_000 });
      return null;
    }

    execS('git add -A', { cwd: worktreePath, encoding: 'utf-8', timeout: 5_000 });
    execS(`git commit -m "fix(model-error): batch pattern fix"`, {
      cwd: worktreePath, encoding: 'utf-8', timeout: 5_000,
    });

    return { branchName, worktreePath, slug };
  } catch (err) {
    try { execS(`git worktree remove "${worktreePath}" --force`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000 }); } catch {}
    try { execS(`git branch -D "${branchName}"`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 5_000 }); } catch {}
    log(`  Model-error worktree failed: ${err.message || err}`);
    return null;
  }
}

// --- Deep fix (dev step) ---

async function deepFix(promptText, persona, replayScore, config) {
  log(`  Running deep fix for [${persona.id}]...`);

  const srcDirHint = config.srcDirs.length > 0
    ? `The source code is at: ${config.srcDirs.join(', ')}`
    : 'Find the source code in the project.';

  const deepFixPrompt = [
    `A test prompt keeps failing even after the surface-level fixer improved tool descriptions.`,
    '',
    `**Persona:** ${persona.id} (${persona.name})`,
    `**Prompt:** ${promptText}`,
    `**Tool calls made:** ${replayScore.toolsUsed} calls`,
    `**Problem:** ${replayScore.stuck ? 'Stuck in read loop — gathered data but never called the write tool' : replayScore.timedOut ? 'Timed out — too many tool calls' : 'Failed with errors'}`,
    '',
    `The fixer already tried editing tool descriptions — that didn't help.`,
    `The issue is deeper. Read the full chain: tool handler → backend function → data layer.`,
    `${srcDirHint}`,
    '',
    `Find and fix the real blocker. It might be in the backend handler, the response format, auth, or the tool might need restructuring.`,
    config.buildCommand ? `\nAfter fixing, rebuild: ${config.buildCommand}` : '',
  ].join('\n');

  return await claude(deepFixPrompt, {
    systemPrompt: [
      'You are a senior developer fixing a failing test.',
      'The surface-level fixer already tried improving tool descriptions — that didn\'t work. You need to go deeper.',
      'Read the actual implementation, find the real bug, and fix it.',
      'Make the minimal fix that solves the problem.',
    ].join(' '),
    allowedTools: 'Read,Edit,Grep,Glob,Bash',
    model: config.fixerModel,
    timeout: config.fixerTimeout || 300_000,
    cwd: config.projectRoot,
  });
}

// --- Reviewer ---

// --- Escalation ---

async function escalate(allPassingPrompts, prefetchData, config, runDateContext) {
  log('\n' + '='.repeat(60));
  log('ESCALATION — generating harder prompts');
  log('='.repeat(60));

  const seen = new Set();
  const unique = allPassingPrompts.filter(q => {
    const key = `${q.persona}::${q.prompt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const byPersona = {};
  for (const q of unique) (byPersona[q.persona] = byPersona[q.persona] || []).push(q.prompt);

  const passingLog = Object.entries(byPersona)
    .map(([pid, qs]) => `### ${pid}\n${qs.map(q => `- ${q}`).join('\n')}`)
    .join('\n\n');

  const testedIds = new Set(Object.keys(byPersona));
  const personas = config.personas;
  const escalationPersonas = [
    ...personas.filter(p => testedIds.has(p.id)).slice(0, 5),
    ...personas.filter(p => !testedIds.has(p.id)).slice(0, 2),
  ];

  const personaDesc = escalationPersonas
    .map(p => `- **${p.id}** (${p.role || 'User'}): ${p.description.slice(0, 150)}...`)
    .join('\n');

  const escalationPrompt = [
    `The test harness passed 100% three times in a row. Find the gaps.`,
    `\n## Run date context\n${formatDateContextForPrompt(runDateContext)}`,
    `\n## Passing prompts\n${passingLog}`,
    `\n## Personas for escalation\n${personaDesc}`,
    `\n## System context\n${prefetchData || '(no prefetch data)'}`,
    `\nGenerate exactly ${escalationPersonas.length} harder prompts — one per persona.`,
  ].join('\n');

  const escalatorModel = config.escalatorModel;
  const output = isLocalModel(escalatorModel)
    ? await llm(escalationPrompt, {
        systemPrompt: readPrompt(config.promptsDir, 'escalator.md'),
        model: escalatorModel,
        timeout: config.escalatorTimeout || 300_000,
      })
    : await claude(escalationPrompt, {
        systemPrompt: readPrompt(config.promptsDir, 'escalator.md'),
        allowedTools: 'Read,Grep,Glob',
        model: escalatorModel,
        timeout: config.escalatorTimeout || 300_000,
        cwd: config.projectRoot,
      });

  let escalatedPrompts = [];
  try {
    const match = output.match(/\{[\s\S]*"prompts"[\s\S]*\}/);
    if (match) escalatedPrompts = JSON.parse(match[0]).prompts || [];
  } catch { /* fall through */ }

  if (escalatedPrompts.length === 0) {
    log('  No escalation prompts generated');
    return [];
  }

  log(`  Generated ${escalatedPrompts.length} escalation prompts:`);
  for (const eq of escalatedPrompts) {
    log(`    [${eq.persona}] ${eq.prompt}`);
  }

  // Drift guard: check if escalated prompts diverge from baseline distribution
  const baseline = loadBaseline(null, config);
  const goldenSet = loadGoldenSet(config);
  const referenceQs = [
    ...(baseline?.prompts || []).map(q => q.prompt),
    ...(goldenSet?.prompts || []).map(q => q.prompt),
  ];
  if (referenceQs.length > 0) {
    const drift = computeDistributionDrift(
      escalatedPrompts.map(q => q.prompt),
      referenceQs,
      config.driftThreshold ?? 0.4,
    );
    if (drift.highDrift) {
      log(`  DRIFT WARNING: JSD=${drift.drift}, novelty=${drift.noveltyRatio}`);
      log(`    Novel tokens: ${drift.topNovelTokens.join(', ')}`);
      if (config.driftAction === 'reject') {
        log('  Escalation prompts rejected due to high drift');
        recordEscalation({ promptsGenerated: escalatedPrompts.length, promptsProductive: 0 }, config);
        return [];
      }
    } else {
      log(`  Drift check: JSD=${drift.drift} (OK)`);
    }
  }

  // In legacy mode (no prompt-set.json), promote directly to golden set
  const promptSet = loadPromptSet(config);
  if (!promptSet) {
    let promoted = 0;
    for (const eq of escalatedPrompts) {
      const persona = getPersona(config.personas, eq.persona);
      if (!persona) continue;
      if (promoteToGoldenSet(persona, eq.prompt, {
        timestamp: new Date().toISOString(),
        source: 'escalation',
        reason: eq.why || 'auto-escalation',
      }, config, eq)) promoted++;
    }
    log(`  Promoted ${promoted} to golden set`);
  }
  // In fixed-sets mode, the caller adds to prompt-set.json

  recordEscalation({ promptsGenerated: escalatedPrompts.length, promptsProductive: 0 }, config);
  return escalatedPrompts;
}

// --- Main ---

export async function run(config, args = {}) {
  setLlmConfig(config);
  const startTime = Date.now();
  const runState = { audit: null };
  const {
    promptLimit = config.promptsPerPersona || config.questionsPerPersona,
    dryRun = false,
    skipFixer = false,
    skipReviewer = false,
    trainOnly = false,
    evalOnly = false,
    answererModel,
    isRegression = false,
    regressionFile = null,
    goldenMax,
    skipGolden = false,
    skipAutoDev = false,
    forceEscalate = false,
    noEscalate = false,
    streakThreshold = 3,
    verbose = false,
    personaFilter,
    currentRun = 1,
    totalRuns = 1,
  } = args;

  // Override config prompt limit
  config.promptsPerPersona = promptLimit;
  if (answererModel) config.answererModel = answererModel;

  // Ensure data dirs exist
  for (const dir of [config.logsDir, config.baselinesDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Select personas
  let selectedPersonas;
  let regressionBaseline = null;
  let regressionPrompts = null;

  if (isRegression) {
    regressionBaseline = loadBaseline(regressionFile, config);
    if (!regressionBaseline) { console.error('No baseline found.'); process.exit(1); }
    regressionPrompts = regressionBaseline.prompts || regressionBaseline.questions || [];
    const ids = [...new Set(regressionPrompts.map(q => q.persona))];
    selectedPersonas = ids.map(id => getPersona(config.personas, id)).filter(Boolean);
  } else if (personaFilter) {
    selectedPersonas = [getPersona(config.personas, personaFilter)].filter(Boolean);
  } else if (trainOnly) {
    selectedPersonas = getPersonasByGroup(config.personas, 'train');
  } else if (evalOnly) {
    selectedPersonas = getPersonasByGroup(config.personas, 'eval');
  } else {
    selectedPersonas = config.personas;
  }

  if (selectedPersonas.length === 0) {
    console.error('No personas selected.');
    process.exit(1);
  }

  const effectiveSkipFixer = skipFixer || evalOnly;
  const effectiveSkipReviewer = skipReviewer || evalOnly;

  log(`mcp-evolve starting${totalRuns > 1 ? ` (run ${currentRun}/${totalRuns})` : ''}`);
  log(`System: ${config.systemDescription}`);
  log(`Personas: ${selectedPersonas.map(p => `${p.id}[${p.group || 'train'}]`).join(', ')}`);
  log(`Prompts/persona: ${isRegression ? 'from baseline' : promptLimit}`);

  // Initialize progress tracker (estimated total prompts: personas × promptsPerPersona)
  const estimatedPrompts = selectedPersonas.length * (promptLimit || 1);
  let prog = null;
  try {
    prog = progress.createProgress(config, {
      totalPrompts: estimatedPrompts,
      personaCount: selectedPersonas.length,
      currentRun,
      totalRuns,
    });
    log(progress.formatInitialEstimate(prog));
  } catch (e) { /* progress is non-critical */ }
  console.log('');

  // Reset any leftover state from a previous run, then seed fresh
  await runReset(config);
  await withPhase(prog, 'seed', () => runSeed(config));

  const runDateContext = buildRunDateContext(config);
  const healthcheckResult = await withPhase(prog, 'healthcheck', () => runHealthcheck(config, runDateContext));
  if (!healthcheckResult.ok) {
    log(`  Healthcheck failed: ${healthcheckResult.error}`);
  }

  // Get state description (static) + prefetch live data
  const stateDescription = healthcheckResult.ok ? getStateDescription(config) : '';
  const prefetchData = healthcheckResult.ok
    ? await withPhase(prog, 'prefetch', () => runPrefetch(config))
    : '';
  const fullContext = [stateDescription, prefetchData].filter(Boolean).join('\n\n');

  // Load prompt set (fixed sets mode) or fall back to legacy golden set
  const promptSet = loadPromptSet(config);
  const useFixedSets = !!promptSet;

  // Legacy golden set — only used if no prompt-set.json exists
  const goldenSet = useFixedSets ? { prompts: [] } : (skipGolden ? { prompts: [] } : loadGoldenSet(config));
  if (goldenMax && !useFixedSets) goldenSet.maxSize = goldenMax;

  if (useFixedSets) {
    const trainCount = getPromptsByGroup(promptSet, 'train').length;
    const goldenCount = getPromptsByGroup(promptSet, 'golden').length;
    log(`Prompt set: ${promptSet.prompts.length} prompts (${trainCount} train, ${goldenCount} golden)`);
  } else if (goldenSet.prompts.length > 0) {
    log(`Golden set: ${goldenSet.prompts.length} permanent regression prompts`);
  }

  let globalGoldenHealthy = true;
  if (!useFixedSets && goldenSet.prompts.length > 0 && !isRegression) {
    const lastBaseline = loadBaseline(null, config);
    if (lastBaseline) {
      const baselinePrompts = lastBaseline.prompts || lastBaseline.questions || [];
      const activeGolden = goldenSet.prompts.filter(q => !q.blocked && !q.obsolete);
      const activeGoldenKeys = new Set(activeGolden.map(q => `${q.persona}::${q.prompt}`));
      const lastGoldenResults = baselinePrompts.filter(q =>
        activeGoldenKeys.has(`${q.persona}::${q.prompt}`)
      );
      const goldenFailing = lastGoldenResults.some(q => !isPassingScore(q.score));
      if (goldenFailing) {
        globalGoldenHealthy = false;
        log('Golden set still failing — running in global golden-only mode');
      }
    }
  }

  const allResults = [];
  const allErrors = [];

  // --- Run + grade a single prompt ---
  async function runAndGrade(promptObj, persona) {
    const pText = typeof promptObj === 'string' ? promptObj : (promptObj.prompt || promptObj.question);
    const probe = typeof promptObj === 'object' ? promptObj.probe : null;
    const invariant = typeof promptObj === 'object' ? promptObj.invariant : null;
    const probeType = typeof promptObj === 'object' ? promptObj.probeType : null;
    const adversarialFlag = typeof promptObj === 'object' && promptObj.adversarial === true;

    // 1. Before-probe (if probe exists)
    let beforeProbe = null;
    if (probe) {
      log(`    [probe:before] "${probe.slice(0, 60)}..."`);
      beforeProbe = await runPrompt(probe, persona, config, runDateContext, {
        model: config.probeModel || 'haiku',
      });
    }

    // 2. Main prompt (answerer sees only text)
    const result = await runPrompt(pText, persona, config, runDateContext);

    // 3. After-probe (if probe exists)
    let afterProbe = null;
    if (probe) {
      log(`    [probe:after] "${probe.slice(0, 60)}..."`);
      afterProbe = await runPrompt(probe, persona, config, runDateContext, {
        model: config.probeModel || 'haiku',
      });
    }

    // 4. Grade with probe context
    if (!args.skipGrading && result.errors.length === 0) {
      const grading = await gradeResponse(pText, result, persona, config, runDateContext, {
        probe, beforeProbe, afterProbe, invariant, probeType, adversarial: adversarialFlag,
      });
      if (grading) result.grading = grading;
      if (grading?.issues?.length > 0 && !adversarialFlag) {
        for (const issue of grading.issues) {
          result.errors.push({
            tool: isOutputTruncationIssue(issue) ? 'harness:output-truncation' : 'harness:grading',
            input: { prompt: pText },
            error: issue,
          });
        }
      } else if (grading?.issues?.length > 0 && adversarialFlag) {
        // Adversarial prompts: the grader reported issues, but these are expected. Record as info.
        result.adversarialExpectedIssues = grading.issues;
      }
      // Obsolete prompts don't trigger the fixer
      if (grading?.promptStatus === 'obsolete') {
        result.errors = [];
        result.obsolete = true;
        result.obsoleteReason = grading.issues?.[0] || 'prompt no longer valid for current data';
      }
    }

    // 5. Attach probe metadata to result
    if (probe) {
      result.probeData = {
        probe, invariant, probeType,
        beforeResponse: beforeProbe?.response?.slice(0, 500),
        afterResponse: afterProbe?.response?.slice(0, 500),
        invariantResult: result.grading?.invariantResult || 'skipped',
      };
    }

    const writeToolCalled = result.toolCalls.some(tc => matchesWriteTools(tc.tool, config));
    const isAction = isActionRequestFn(pText, config.actionVerbs);
    if (isAction && !writeToolCalled && result.errors.length === 0 && result.grading?.actionExpectation !== 'valid_noop') {
      result.errors.push({
        tool: 'harness:action-missing-write',
        input: { prompt: pText },
        error: 'Action request finished without a write tool and without an explicitly approved no-op.',
      });
    }

    result.errors = result.errors.map(error => ({
      ...error,
      category: classifyErrorCategory(error, config),
    }));

    const score = scorePrompt({ prompt: pText, ...result }, config);
    result.score = score;
    return { prompt: pText, promptObj, persona, ...result };
  }

  // === FIXED SETS MODE ===
  if (useFixedSets && !isRegression && !dryRun) {
    // Filter prompts to selected personas
    const selectedIds = new Set(selectedPersonas.map(p => p.id));
    const eligible = promptSet.prompts.filter(q => selectedIds.has(q.persona) && !q.obsolete);

    // Sample if maxTrainPerRun / maxGoldenPerRun is set
    function sampleUpTo(arr, max) {
      if (!max || arr.length <= max) return arr;
      const shuffled = [...arr].sort(() => Math.random() - 0.5);
      return shuffled.slice(0, max);
    }
    const trainQs = sampleUpTo(eligible.filter(q => q.group === 'train'), config.maxTrainPerRun);
    const goldenQs = sampleUpTo(eligible.filter(q => q.group === 'golden'), config.maxGoldenPerRun);
    const promptsToRun = [...trainQs, ...goldenQs];

    // Throttle concurrency for local models (prevents KV cache OOM)
    const effectiveModel = config.answererModel || 'sonnet';
    const concurrency = isLocalModel(effectiveModel) ? (config.localConcurrency || 1) : promptsToRun.length;

    log(`Running ${promptsToRun.length} prompts${concurrency < promptsToRun.length ? ` (concurrency: ${concurrency})` : ' in PARALLEL'}${eligible.length > promptsToRun.length ? ` (sampled from ${eligible.length})` : ''}`);

    // Update progress with actual prompt count (may differ from initial estimate)
    try {
      if (prog) {
        prog.totalPrompts = promptsToRun.length;
        progress.setPhase(prog, 'prompts_run');
      }
    } catch {}

    // Run + grade prompts, throttled for local models
    const results = [];
    for (let i = 0; i < promptsToRun.length; i += concurrency) {
      const chunk = promptsToRun.slice(i, i + concurrency);
      const chunkResults = await Promise.all(
        chunk.map(q => {
          const persona = config.personas.find(p => p.id === q.persona);
          const promptText = (q.promptObj && q.promptObj.prompt) || q.prompt;
          try { progress.startPrompt(prog, promptText.slice(0, 120), { persona: persona?.id }); } catch {}
          return runAndGrade(q.promptObj || q.prompt, persona).then(res => {
            try {
              const toolNames = Array.isArray(res.toolCalls) ? res.toolCalls.map(t => t.tool) : [];
              progress.completePrompt(prog, {
                success: (res.errors || []).length === 0,
                errors: (res.errors || []).length,
                toolCount: toolNames.length,
                toolsUsed: toolNames.slice(0, 32),
              });
              log(progress.formatProgress(prog));
            } catch {}
            return res;
          }).catch(err => {
            try {
              progress.completePrompt(prog, { success: false, errors: 1 });
            } catch {}
            throw err;
          });
        })
      );
      results.push(...chunkResults);
    }

    // Group results by persona for downstream compatibility
    const byPersona = {};
    for (const r of results) {
      const pid = r.persona.id;
      if (!byPersona[pid]) byPersona[pid] = { persona: r.persona, prompts: [] };
      byPersona[pid].prompts.push(r);
      for (const error of r.errors) {
        allErrors.push({ persona: pid, prompt: r.prompt, ...error });
      }
    }
    for (const pr of Object.values(byPersona)) {
      allResults.push(pr);
    }

  // === LEGACY MODE (no prompt-set.json) ===
  } else {
    // --- Per-persona runner (legacy) ---
    async function runPersona(persona) {
      log(`\n${'='.repeat(60)}`);
      log(`Persona: ${persona.name} (${persona.role || 'User'}) [${persona.group || 'train'}]`);
      log('='.repeat(60));

      // Golden set prompts for this persona — skip blocked ones
      const goldenForPersona = goldenSet.prompts.filter(q => q.persona === persona.id && !q.blocked && !q.obsolete);
      const blockedCount = goldenSet.prompts.filter(q => q.persona === persona.id && q.blocked).length;
      if (blockedCount > 0) log(`  ${blockedCount} golden prompt(s) blocked (needs /dev)`);
      const goldenPrompts = goldenForPersona.map(q => q.promptObj || q.prompt);

      let prompts;
      if (isRegression) {
        prompts = regressionPrompts.filter(q => q.persona === persona.id).map(q => q.promptObj || q.prompt);
      } else if (!globalGoldenHealthy) {
        prompts = [];
      } else {
        const { getFailingForPersona } = await import('./failing-prompts.mjs');
        const failingEntries = getFailingForPersona(config, persona.id);

        let endGen = () => {};
        try { endGen = progress.recordSubPhase(prog, 'generation'); } catch {}
        try {
          prompts = await generatePrompts(persona, config, fullContext, runDateContext, failingEntries);
        } finally {
          try { endGen(); } catch {}
        }
      }

      // Append golden set prompts
      if (goldenPrompts.length > 0) {
        const promptTexts = new Set(prompts.map(q => typeof q === 'string' ? q : (q.prompt || q.question)));
        const newGolden = goldenPrompts.filter(gq => !promptTexts.has(typeof gq === 'string' ? gq : (gq.prompt || gq.question)));
        if (newGolden.length > 0) {
          prompts.push(...newGolden);
          log(`  + ${newGolden.length} golden set prompts${!globalGoldenHealthy ? ' (golden-only mode)' : ''}`);
        }
      }

      if (prompts.length === 0) { log('  No prompts, skipping'); return null; }

      if (!isRegression && !dryRun) {
        const baseline = loadBaseline(null, config);
        const diversity = checkDiversity(prompts.map(q => typeof q === 'string' ? q : (q.prompt || q.question)), baseline);
        if (diversity.lowDiversity) log(`  WARNING: Low diversity (${diversity.avgSimilarity})`);
      }

      const personaResult = { persona, prompts: [] };
      const personaErrors = [];

      if (dryRun) {
        for (const q of prompts) {
          const pt = typeof q === 'string' ? q : (q.prompt || q.question);
          log(`    - ${pt}`);
          const score = scorePrompt({ prompt: pt, toolCalls: [], errors: [], debugLogErrors: [], response: '[dry run]' }, config);
          personaResult.prompts.push({ prompt: pt, promptObj: typeof q === 'object' ? q : null, toolCalls: [], errors: [], debugLogErrors: [], response: '[dry run]', score });
        }
        return { personaResult, personaErrors };
      }

      for (const p of prompts) {
        const pt = typeof p === 'string' ? p : (p.prompt || p.question || '');
        try { progress.startPrompt(prog, pt.slice(0, 120), { persona: persona.id }); } catch {}
        let result;
        try {
          result = await runAndGrade(p, persona);
        } catch (err) {
          try { progress.completePrompt(prog, { success: false, errors: 1 }); } catch {}
          throw err;
        }
        personaResult.prompts.push(result);
        for (const error of result.errors) {
          personaErrors.push({ persona: persona.id, prompt: result.prompt, ...error });
        }
        try {
          const toolNames = Array.isArray(result.toolCalls) ? result.toolCalls.map(t => t.tool) : [];
          progress.completePrompt(prog, {
            success: (result.errors || []).length === 0,
            errors: (result.errors || []).length,
            toolCount: toolNames.length,
            toolsUsed: toolNames.slice(0, 32),
          });
          log(progress.formatProgress(prog));
        } catch {}
      }

      return { personaResult, personaErrors };
    }

    // Legacy mode runs generation + prompts interleaved per-persona in parallel.
    // We can't cleanly separate the two phases, so we treat the whole block as
    // `prompts_run` (generation timings come from individual generatePrompts
    // calls captured via the `generation` phase when we instrument them below).
    await withPhase(prog, 'prompts_run', async () => {
      if (selectedPersonas.length > 1) {
        log(`Running ${selectedPersonas.length} personas in PARALLEL`);
        const results = await Promise.all(selectedPersonas.map(p => runPersona(p)));
        for (const r of results) {
          if (!r) continue;
          allResults.push(r.personaResult);
          allErrors.push(...r.personaErrors);
        }
      } else {
        const r = await runPersona(selectedPersonas[0]);
        if (r) {
          allResults.push(r.personaResult);
          allErrors.push(...r.personaErrors);
        }
      }
    });
  }

  const invalidReasons = collectInvalidRunReasons(allErrors, healthcheckResult);
  const runInvalid = invalidReasons.length > 0;

  if (runInvalid) {
    log('');
    log('='.repeat(60));
    log('INVALID RUN — quarantined from baselines, golden set, metrics');
    log('='.repeat(60));
    for (const reason of invalidReasons) log(`  ${reason}`);
  }

  // Phase B: Batch fix all errors, then rebuild once, then replay all failed
  if (!runInvalid && !effectiveSkipFixer && !dryRun) {
    const fixableErrors = [];
    for (const r of allResults) {
      // In fixed-sets mode, all personas get fixing. In legacy mode, only train.
      if (!useFixedSets && (r.persona.group || 'train') !== 'train') continue;
      for (const q of r.prompts) {
        // Adversarial prompts: errors are expected, do NOT feed them to the fixer
        if (q.promptObj?.adversarial === true) continue;
        const mcpErrors = (q.errors || []).filter(e =>
          e.tool !== 'cli' && !NON_FIXABLE_HARNESS_TOOLS.has(e.tool) && e.category !== 'model'
        );
        if (mcpErrors.length > 0) {
          // Find this prompt's group in the persisted prompt-set (if fixed-sets mode)
          let lifecycle = r.persona.group || 'train';
          if (useFixedSets && promptSet) {
            const psEntry = promptSet.prompts.find(e =>
              e.persona === r.persona.id && e.prompt === q.prompt
            );
            if (psEntry?.group) lifecycle = psEntry.group;
          }

          fixableErrors.push({
            persona: r.persona,
            prompt: q.prompt,
            errors: mcpErrors,
            debugLogErrors: q.debugLogErrors || [],
            probe: q.probeData?.probe || q.promptObj?.probe || null,
            invariant: q.probeData?.invariant || q.promptObj?.invariant || null,
            probeType: q.probeData?.probeType || q.promptObj?.probeType || null,
            lifecycle,
          });
        }
      }
    }

    if (fixableErrors.length > 0) {
      log('');
      log('='.repeat(60));
      log(`BATCH FIX: ${fixableErrors.length} prompts with errors`);
      log('='.repeat(60));
      try { progress.setPhase(prog, 'fix_batch'); } catch {}

      // Run fixers in PARALLEL — each in its own git worktree
      const fixPromises = fixableErrors.map((fe, i) => {
        const error = fe.errors[0]; // one fix per prompt
        const slug = `${fe.persona.id}-${i}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-').slice(0, 40);
        log(`  Fixing [${fe.persona.id}] ${error.tool} (worktree: ${slug})...`);
        let endFix = null;
        try { endFix = progress.startFix(prog, error.tool); } catch {}
        return fixErrorInWorktree(error, fe.debugLogErrors, config, slug)
          .then(result => {
            if (result) log(`  Fixed [${fe.persona.id}] -> branch ${result.branchName}`);
            else log(`  No changes from [${fe.persona.id}] fixer`);
            try { endFix && endFix(!!result); } catch {}
            return result;
          })
          .catch(err => {
            log(`  Fix failed [${fe.persona.id}]: ${err.message || err}`);
            try { endFix && endFix(false); } catch {}
            return null;
          });
      });
      // Resolve all fix promises BEFORE filtering, so the index → fixableError
      // mapping stays intact even when some fixers return null.
      const allFixResults = await Promise.all(fixPromises);

      // Build branchesForAudit by pairing each non-null fix result with its
      // originating fixableError at the SAME index. Then filter.
      const branchesForAudit = allFixResults
        .map((fr, idx) => fr ? { ...fr, fixableError: fixableErrors[idx], kind: 'fixer' } : null)
        .filter(Boolean);

      // Also keep a flat list of successful fix results for the worktree cleanup block below
      const fixResults = allFixResults.filter(Boolean);

      // Run the audit + merge via the reviewer LLM
      let auditSummary = { merged: [], rejected: [], droppedPrompts: [], reviewerOutput: null, parseErrors: [] };
      if (branchesForAudit.length > 0) {
        try { progress.setPhase(prog, 'reviewer'); } catch {}
        auditSummary = await runAuditAndMerge({
          branches: branchesForAudit,
          scoredPrompts: allResults.flatMap(r =>
            r.prompts.map(q => ({
              persona: r.persona.id, prompt: q.prompt,
              group: (useFixedSets && promptSet)
                ? (promptSet.prompts.find(e => e.persona === r.persona.id && e.prompt === q.prompt)?.group || 'train')
                : (r.persona.group || 'train'),
              probeData: q.probeData || null,
              score: q.score,
              // Reference back to the underlying prompt object so invalid flag persists
              __backing: q,
            }))
          ),
          runId: new Date().toISOString(),
          config,
        });

        // Propagate invalid flags from the scored shadow back to the actual prompt results
        for (const d of auditSummary.droppedPrompts) {
          const personaResult = allResults.find(r => r.persona.id === d.persona);
          const q = personaResult?.prompts.find(pq => pq.prompt === d.prompt);
          if (q) {
            q.invalid = true;
            q.invalidReason = d.reason;
          }
        }

        try { progress.setPhase(prog, 'fix_batch'); } catch {}
      }

      // Clean up ALL worktrees (both merged and rejected) now that the reviewer is done
      {
        const { execSync: execS } = await import('node:child_process');
        for (const b of fixResults) {
          try { execS(`git worktree remove "${b.worktreePath}" --force`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000 }); } catch {}
          try { execS(`git branch -D "${b.branchName}"`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 5_000 }); } catch {}
        }
      }

      // Record the audit summary in a run-scoped state object (task 10 wires it into the log)
      runState.audit = {
        fixer: auditSummary,
      };

      // Rebuild if needed
      if (config.buildCommand) {
        log('  Rebuilding...');
        try {
          const { execSync } = await import('node:child_process');
          execSync(config.buildCommand, { cwd: config.projectRoot, stdio: 'ignore', timeout: config.buildTimeout || 30_000 });
        } catch (buildErr) {
          log(`  Build failed: ${buildErr.message || buildErr}`);
        }
      }

      // Replay all failed prompts in parallel (always, not just after build)
      log(`  Replaying ${fixableErrors.length} failed prompts in PARALLEL...`);
      try { progress.setPhase(prog, 'replay'); } catch {}
      const replayResults = await Promise.all(fixableErrors.map(async (fe) => {
        const replay = await runPrompt(fe.prompt, fe.persona, config, runDateContext);
        const replayScore = scorePrompt({ prompt: fe.prompt, ...replay }, config);
        replay.score = replayScore;

        const originalQ = allResults
          .find(r => r.persona.id === fe.persona.id)
          ?.prompts.find(q => q.prompt === fe.prompt);
        const origScore = originalQ?.score;

        const fixed = isPassingScore(replayScore);
        const prevOk = isPassingScore(origScore);
        const verdict = fixed && !prevOk ? 'FIXED' : fixed ? 'STILL OK' : 'STILL FAILING';
        log(`  [${fe.persona.id}] Replay: ${verdict} (tools: ${origScore?.toolsUsed || '?'} -> ${replayScore.toolsUsed})`);

        if (verdict === 'FIXED' && !useFixedSets) {
          if (promoteToGoldenSet(fe.persona, fe.prompt, {
            timestamp: new Date().toISOString(),
            originalErrors: origScore?.errorsFound || 0,
            originalStuck: origScore?.stuck || false,
          }, config)) log(`  PROMOTED to golden set`);
        }

        const personaResult = allResults.find(r => r.persona.id === fe.persona.id);
        if (personaResult) {
          personaResult.prompts.push({ prompt: `[REPLAY] ${fe.prompt}`, ...replay });
        }

        return { persona: fe.persona, prompt: fe.prompt, verdict, replayScore };
      }));

      const fixedCount = replayResults.filter(r => r.verdict === 'FIXED').length;
      const stillFailing = replayResults.filter(r => r.verdict === 'STILL FAILING');
      log(`  Replay summary: ${fixedCount} FIXED, ${stillFailing.length} STILL FAILING`);

      try { progress.setPhase(prog, 'idle'); } catch {}

      // Deep fix: when fixer couldn't solve it, run auto-dev
      if (stillFailing.length > 0 && !skipAutoDev) {
        log('');
        log('='.repeat(60));
        log(`DEEP FIX: ${stillFailing.length} prompts the fixer couldn't solve`);
        log('='.repeat(60));
        try { progress.setPhase(prog, 'deep_fix'); } catch {}

        for (const sf of stillFailing) {
          await deepFix(sf.prompt, sf.persona, sf.replayScore, config);
          log(`  Deep fix completed for [${sf.persona.id}]`);
        }

        // Rebuild and replay after deep fixes
        if (config.buildCommand) {
          const { execSync } = await import('node:child_process');
          log('  Rebuilding after deep fixes...');
          try {
            execSync(config.buildCommand, { cwd: config.projectRoot, stdio: 'ignore', timeout: config.buildTimeout || 30_000 });
          } catch (buildErr) {
            log(`  Rebuild after deep fix failed: ${buildErr.message?.slice(0, 100)}`);
          }
        }

        for (const sf of stillFailing) {
          const replay2 = await runPrompt(sf.prompt, sf.persona, config, runDateContext);
          const replay2Score = scorePrompt({ prompt: sf.prompt, ...replay2 }, config);
          replay2.score = replay2Score;

          const fixed2 = isPassingScore(replay2Score);
          const verdict2 = fixed2 ? 'FIXED BY DEV' : 'STILL FAILING';
          log(`  [${sf.persona.id}] ${verdict2} (tools: ${sf.replayScore.toolsUsed} -> ${replay2Score.toolsUsed})`);

          if (verdict2 === 'FIXED BY DEV' && !useFixedSets) {
            promoteToGoldenSet(sf.persona, sf.prompt, {
              timestamp: new Date().toISOString(),
              source: 'deep-fix',
              originalStuck: sf.replayScore.stuck,
            }, config);
            log(`  PROMOTED to golden set (deep fix)`);
          }

          const personaResult = allResults.find(r => r.persona.id === sf.persona.id);
          if (personaResult) {
            personaResult.prompts.push({ prompt: `[DEV-REPLAY] ${sf.prompt}`, ...replay2 });
          }
        }
        try { progress.setPhase(prog, 'idle'); } catch {}
      }
    }
  }

  // Model-error fixer — when 3+ model-category errors accumulate, look for MCP patterns
  if (!runInvalid && !effectiveSkipFixer && !dryRun) {
    const modelErrors = [];
    for (const r of allResults) {
      if (!useFixedSets && (r.persona.group || 'train') !== 'train') continue;
      for (const q of r.prompts) {
        const mErrors = (q.errors || []).filter(e => e.category === 'model');
        if (mErrors.length > 0) {
          modelErrors.push({ persona: r.persona, prompt: q.prompt, errors: mErrors, debugLogErrors: q.debugLogErrors || [] });
        }
      }
    }

    // Apply pattern-level failing entries as a pre-filter on model errors
    const failingPatterns = getFailingPatterns(config);
    const filteredModelErrors = failingPatterns.length === 0 ? modelErrors : modelErrors.filter(me => {
      const errorText = me.errors.map(e => (typeof e.error === 'string' ? e.error : JSON.stringify(e.error))).join(' ').toLowerCase();
      return !failingPatterns.some(fp => {
        try { return new RegExp(fp.patternRegex, 'i').test(errorText); } catch { return false; }
      });
    });

    if (failingPatterns.length > 0 && filteredModelErrors.length < modelErrors.length) {
      log(`  [model-error filter] ${modelErrors.length - filteredModelErrors.length} prompt(s) filtered out by ${failingPatterns.length} failing pattern(s)`);
    }

    if (filteredModelErrors.length >= (config.modelErrorThreshold || 3)) {
      log('');
      log('='.repeat(60));
      log(`MODEL ERROR FIXER: ${filteredModelErrors.length} model errors — checking for MCP patterns`);
      log('='.repeat(60));

      const meBranch = await withPhase(prog, 'model_error_fix', () => runModelErrorFixerInWorktree(filteredModelErrors, config));

      if (meBranch) {
        try { progress.setPhase(prog, 'reviewer'); } catch {}

        // Synthesize a fixableError summary so the audit has per-prompt context
        const syntheticFixable = {
          persona: { id: filteredModelErrors[0]?.persona?.id || 'unknown' },
          prompt: '[model-error batch]',
          errors: filteredModelErrors.flatMap(me => me.errors || []),
          probe: null,
          invariant: null,
          probeType: null,
          lifecycle: 'train',
        };

        const meAudit = await runAuditAndMerge({
          branches: [{
            ...meBranch,
            fixableError: syntheticFixable,
            kind: 'model-error',
          }],
          scoredPrompts: [],
          runId: new Date().toISOString(),
          config,
        });

        runState.audit = runState.audit || {};
        runState.audit.modelError = meAudit;

        // Clean up worktree after audit
        {
          const { execSync: execS } = await import('node:child_process');
          try { execS(`git worktree remove "${meBranch.worktreePath}" --force`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000 }); } catch {}
          try { execS(`git branch -D "${meBranch.branchName}"`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 5_000 }); } catch {}
        }
      } else {
        log(`  Model-error fixer produced no changes`);
      }
    } else if (failingPatterns.length > 0) {
      log(`  Model error fixer skipped — all ${modelErrors.length} error(s) match existing failing patterns`);
    }
  }

  // Score — in fixed-sets mode, group comes from prompt set; in legacy, from persona
  const scoredPrompts = allResults.flatMap(r =>
    r.prompts.map(q => {
      let group = r.persona.group;
      if (useFixedSets) {
        const psEntry = promptSet.prompts.find(e => e.persona === r.persona.id && e.prompt === q.prompt);
        group = psEntry?.group || 'train';
      }
      return { persona: r.persona.id, group, prompt: q.prompt, score: q.score };
    })
  );

  // Remove obsolete prompts from prompt set — escalation will fill the gaps
  if (useFixedSets && !runInvalid && !dryRun) {
    const obsoletePrompts = allResults.flatMap(r =>
      r.prompts.filter(q => q.obsolete).map(q => ({ persona: r.persona.id, prompt: q.prompt }))
    );
    if (obsoletePrompts.length > 0) {
      const before = promptSet.prompts.length;
      promptSet.prompts = promptSet.prompts.filter(p =>
        !obsoletePrompts.some(o => o.persona === p.persona && o.prompt === p.prompt)
      );
      savePromptSet(promptSet, config);
      log(`\nREMOVED ${before - promptSet.prompts.length} obsolete prompt(s) — escalation will generate replacements`);
    }
  }

  // Save baseline
  if (!runInvalid && !dryRun) saveBaseline(allResults, answererModel, config);

  // Graduation — update prompt set pass tracking, graduate train -> golden
  if (useFixedSets && !runInvalid && !dryRun) {
    const graduated = updatePromptSetAfterRun(promptSet, allResults, config);
    if (graduated.length > 0) {
      log(`\nGRADUATED ${graduated.length} prompt(s) to golden:`);
      for (const g of graduated) {
        log(`  [${g.persona}] ${g.prompt.slice(0, 70)}...`);
      }

      // Graduation triggers escalation — replace graduated prompts with harder ones
      if (!noEscalate) {
        const allPs = promptSet.prompts.map(q => ({ persona: q.persona, prompt: q.prompt }));
        log(`\nGenerating ${graduated.length} replacement train prompts via escalation...`);
        const escalationResults = await withPhase(prog, 'escalate',
          () => escalate(allPs, fullContext, config, runDateContext));
        if (escalationResults.length > 0) {
          addTrainPrompts(promptSet, escalationResults, config);
          log(`  Added ${escalationResults.length} new train prompts`);
        }
      }
    }
  }

  // Update golden set health — track consecutive fails, auto-dev blocked prompts (legacy mode)
  if (!useFixedSets && !runInvalid && !dryRun) {
    const { blocked: newlyBlocked } = updateGoldenHealth(allResults, config);

    // Collect ALL blocked prompts (newly blocked + previously blocked without a fix branch)
    const currentGs = loadGoldenSet(config);
    const allBlocked = (currentGs.prompts || []).filter(q => q.blocked && !q.autoDevBranch);

    if (allBlocked.length > 0 && !skipAutoDev) {
      log('');
      log('='.repeat(60));
      log(`AUTO-DEV: ${allBlocked.length} blocked golden prompt(s) — investigating in worktrees`);
      log('='.repeat(60));

      const devResults = await withPhase(prog, 'autodev', () => autoDev(allBlocked, config));
      for (const dr of devResults) {
        if (dr.verdict === 'FIX_READY') {
          log(`  [${dr.persona}] FIX READY -> branch: ${dr.branch}`);
          log(`    Review: git diff ${dr.branch}`);
          log(`    Merge:  git merge ${dr.branch}`);
          const gq = currentGs.prompts.find(q => q.persona === dr.persona && q.prompt === dr.prompt);
          if (gq) gq.autoDevBranch = dr.branch;
        } else {
          log(`  [${dr.persona}] ${dr.verdict} — could not resolve automatically`);
          const gq = currentGs.prompts.find(q => q.persona === dr.persona && q.prompt === dr.prompt);
          if (gq) gq.autoDevAttempted = new Date().toISOString();
        }
      }
      writeFileSync(config.goldenSetPath, JSON.stringify(currentGs, null, 2) + '\n');
    } else if (allBlocked.length > 0) {
      log('');
      log('='.repeat(60));
      log(`BLOCKED: ${allBlocked.length} golden prompt(s) (auto-dev skipped)`);
      log('='.repeat(60));
      for (const bq of allBlocked) {
        log(`  [${bq.persona}] ${bq.prompt.slice(0, 80)}`);
      }
    }
  }

  // Regression comparison
  if (isRegression && regressionBaseline) {
    printRegressionReport(compareToBaseline(allResults, regressionBaseline));
  }

  // Escalation — ONLY when everything passes
  if (!runInvalid && !dryRun && !noEscalate) {
    const currentAllPassed = scoredPrompts.length > 0 &&
      scoredPrompts.every(q => isPassingScore(q.score));

    // Legacy mode: also check for blocked golden prompts
    if (!useFixedSets) {
      const escGs = loadGoldenSet(config);
      const hasBlocked = (escGs.prompts || []).some(q => q.blocked);
      if (hasBlocked && !forceEscalate) {
        log(`\nEscalation skipped — ${(escGs.prompts || []).filter(q => q.blocked).length} blocked prompt(s). Fix those first.`);
      }
    }

    if (forceEscalate || currentAllPassed) {
      const streak = checkStreak(streakThreshold, config);
      if (forceEscalate || streak.triggered) {
        log(`\n100% STREAK: ${streak.streak} runs`);
        const escalationResults = await withPhase(prog, 'escalate',
          () => escalate(streak.allPassingPrompts, fullContext, config, runDateContext));

        // Fixed-sets mode: add escalation prompts as train to prompt set
        if (useFixedSets && escalationResults.length > 0) {
          addTrainPrompts(promptSet, escalationResults, config);
          log(`  Added ${escalationResults.length} escalation prompts to prompt set (as train)`);
        }
      }

      // Feature competition (streak-triggered)
      const competitionThreshold = streakThreshold * (config.competitionStreakMultiplier || 2);
      if (!args.noCompete && streak.streak >= competitionThreshold) {
        const passingLog = streak.allPassingPrompts
          .map(q => `[${q.persona}] ${q.prompt}`)
          .join('\n');
        await withPhase(prog, 'compete',
          () => runCompetition({ passingPrompts: passingLog, fullContext }, config));
      }
    }
  }

  // Feature competition (forced via --compete)
  if (!runInvalid && !dryRun && args.forceCompete) {
    const passingLog = scoredPrompts
      .filter(q => isPassingScore(q.score))
      .map(q => `[${q.persona}] ${q.prompt}`)
      .join('\n');
    await withPhase(prog, 'compete',
      () => runCompetition({ passingPrompts: passingLog, fullContext }, config));
  }

  // Write log
  const allScores = aggregateScores(scoredPrompts);
  const trainScores = aggregateScores(scoredPrompts.filter(q => q.group === 'train'));
  const goldenScores = aggregateScores(scoredPrompts.filter(q => q.group === 'golden'));
  const evalScores = aggregateScores(scoredPrompts.filter(q => q.group === 'eval'));

  const logData = {
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    answererModel: answererModel || 'default',
    dateContext: runDateContext,
    invalid: runInvalid,
    invalidReasons,
    healthcheck: healthcheckResult,
    scores: { all: allScores, train: trainScores, golden: goldenScores, eval: evalScores },
    summary: {
      totalPrompts: allResults.reduce((s, r) => s + r.prompts.length, 0),
      totalErrors: allErrors.length,
      errorsByTool: allErrors.reduce((acc, e) => { acc[e.tool] = (acc[e.tool] || 0) + 1; return acc; }, {}),
      errorsByCategory: allErrors.reduce((acc, e) => {
        const category = e.category || classifyErrorCategory(e, config);
        acc[category] = (acc[category] || 0) + 1;
        return acc;
      }, {}),
    },
    errors: allErrors,
    results: allResults.map(r => ({
      persona: r.persona.id,
      group: r.persona.group,
      prompts: r.prompts.map(q => ({
        prompt: q.prompt, score: q.score,
        probeData: q.probeData || null,
        toolsCalled: q.toolCalls.map(t => t.tool),
        resolvedDatePhrases: q.dateContext?.resolvedPhrases || [],
        errorCount: q.errors.length,
        errors: q.errors.map(e => ({
          tool: e.tool,
          category: e.category || classifyErrorCategory(e, config),
          error: typeof e.error === 'string' ? e.error.slice(0, 500) : JSON.stringify(e.error).slice(0, 500),
        })),
        responsePreview: q.response.slice(0, 300),
      })),
    })),
  };

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = join(config.logsDir, `run-${ts}.json`);
  writeFileSync(logPath, JSON.stringify(logData, null, 2));

  // Update metrics
  if (!runInvalid && !dryRun) {
    const mode = trainOnly ? 'train' : evalOnly ? 'eval' : isRegression ? 'regression' : 'full';
    try { progress.setPhase(prog, 'metrics_update'); } catch {}
    try {
      updateMetrics({ scores: { all: allScores, train: trainScores, golden: goldenScores, eval: evalScores }, results: allResults, errors: allErrors, logData, mode }, config);
    } finally {
      try { progress.setPhase(prog, 'idle'); } catch {}
    }
  }

  // Mark run complete in progress tracker
  try { progress.completeRun(prog); } catch {}

  // Summary
  console.log('');
  log('='.repeat(60));
  log('SUMMARY');
  log('='.repeat(60));
  log(`Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  log(`Personas: ${allResults.length} | Prompts: ${logData.summary.totalPrompts} | Errors: ${allErrors.length}`);

  try {
    if (prog) {
      const summary = progress.formatRunSummary(prog);
      if (summary) {
        console.log('');
        for (const line of summary.split('\n')) log(line);
      }
    }
  } catch {}

  for (const [label, scores] of [['All', allScores], ['Train', trainScores], ['Golden', goldenScores], ['Eval', evalScores]]) {
    if (scores.total === 0) continue;
    log(`  ${label} (${scores.total}p): success=${scores.successRate}% | action=${scores.actionCompletionRate}% | errors/p=${scores.errorRate} | tools=${scores.avgTools}`);
  }
  if (allScores.obsoleteCount > 0) {
    log(`  Obsolete: ${allScores.obsoleteCount} prompt(s) marked obsolete (excluded from scoring)`);
  }
  if (runInvalid) log(`  Invalid: ${invalidReasons.join(' | ')}`);

  // Entropy floor check
  if (!runInvalid && !dryRun) {
    const entropy = computeTestingEntropy(config);
    if (entropy.belowFloor) {
      log(`  ENTROPY WARNING: ${entropy.diagnosis}`);
      log(`    Persona entropy: ${entropy.personaEntropyRatio} (floor: ${config.personaEntropyFloor ?? 0.7})`);
      log(`    Tool entropy: ${entropy.toolEntropyRatio} (floor: ${config.toolEntropyFloor ?? 0.5})`);
    } else if (args.verbose) {
      log(`  Entropy: persona=${entropy.personaEntropyRatio} tool=${entropy.toolEntropyRatio} (healthy)`);
    }
  }

  log(`Log: ${logPath}`);

  // Reset test state so next run starts fresh
  await runReset(config);

  return { scores: { all: allScores, train: trainScores, golden: goldenScores, eval: evalScores }, logData, allResults, allErrors };
}
