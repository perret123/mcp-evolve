/**
 * mcp-evolve — Core test loop.
 *
 * Generates questions from personas, answers via MCP tools,
 * scores results, fixes failures, escalates when passing.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claude, readPrompt, parseStreamOutput } from './claude.mjs';
import { getPersona, getPersonasByGroup } from './personas.mjs';
import {
  scoreQuestion, aggregateScores, saveBaseline, loadBaseline,
  compareToBaseline, printRegressionReport, checkDiversity, getPreviousQuestions,
  loadGoldenSet, promoteToGoldenSet, getGoldenQuestions, checkStreak, updateGoldenHealth,
  isActionRequest as isActionRequestFn,
  buildActionPattern,
} from './eval.mjs';
import { updateMetrics, recordEscalation } from './metrics.mjs';
import { autoDev } from './autodev.mjs';
import { runCompetition } from './compete.mjs';

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

// --- Seed / Reset / Prefetch ---

async function runSeed(config) {
  if (!config.seed) return;
  log('Seeding test environment...');
  try {
    await config.seed(config);
    log('  Seed complete');
  } catch (err) {
    log(`  Seed failed: ${err.message?.slice(0, 100)}`);
  }
}

async function runReset(config) {
  if (!config.reset) return;
  log('Resetting test environment...');
  try {
    await config.reset(config);
    log('  Reset complete');
  } catch (err) {
    log(`  Reset failed: ${err.message?.slice(0, 100)}`);
  }
}

function getStateDescription(config) {
  if (!config.describeState) return '';
  try {
    return config.describeState(config);
  } catch {
    return '';
  }
}

async function runPrefetch(config) {
  if (!config.prefetch) return '';
  log('Running prefetch...');
  try {
    const result = await config.prefetch(claude, config);
    if (result) log(`  Prefetch returned ${result.length} chars`);
    return result || '';
  } catch (err) {
    log(`  Prefetch failed: ${err.message?.slice(0, 100)}`);
    return '';
  }
}

// --- Generate questions ---

async function generateQuestions(persona, config, fullContext) {
  log(`Generating ${config.questionsPerPersona} questions for "${persona.name}"...`);

  const previousQuestions = getPreviousQuestions(persona.id, config);
  const diversityHint = previousQuestions.length > 0
    ? `\n\nIMPORTANT: Vary your phrasing. These questions were asked before — do NOT repeat them:\n${previousQuestions.map(q => `- ${q}`).join('\n')}`
    : '';

  const prefetchHint = fullContext
    ? `\n\nIMPORTANT: Use ONLY real data from the system:\n${fullContext}`
    : '';

  const prompt = [
    `System: ${config.systemDescription}`,
    '',
    `You are: ${persona.description}`,
    '',
    `Your main concerns: ${persona.concerns.join(', ')}`,
    `Your question style: ${persona.questionStyle || 'Natural and direct.'}`,
    '',
    `Generate exactly ${config.questionsPerPersona} realistic questions you would ask an AI assistant about this system.`,
    diversityHint,
    prefetchHint,
    '',
    `Language: ${config.language || 'English'}`,
    '',
    'Reply with ONLY a JSON object: {"questions": ["question1", "question2", ...]}',
  ].join('\n');

  const output = await claude(prompt, {
    systemPrompt: readPrompt(config.promptsDir, 'user-sim.md'),
    mcpConfig: config.mcpConfig,
    strictMcpConfig: true,
    disableBuiltinTools: true,
    model: 'sonnet',
    cwd: config.projectRoot,
  });

  try {
    return JSON.parse(output).questions || [];
  } catch {
    const match = output.match(/\{[\s\S]*"questions"[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]).questions || []; } catch { /* fall through */ }
    }
    log(`  Could not parse questions. Raw: ${output.slice(0, 300)}`);
    return [];
  }
}

// --- Answer questions ---

async function answerQuestion(question, persona, config) {
  log(`  Answering: "${question.slice(0, 80)}..."`);
  const logSnapshot = snapshotLogPositions(config);

  const contextNote = `The user is a ${persona.name} (${persona.role || 'User'} role).`;

  const output = await claude(
    `${contextNote}\n\nUser question: ${question}`,
    {
      systemPrompt: readPrompt(config.promptsDir, 'answerer.md'),
      mcpConfig: config.mcpConfig,
      strictMcpConfig: true,
      disableBuiltinTools: true,
      outputFormat: 'stream-json',
      verbose: true,
      allowedTools: config.answererTools,
      model: config.answererModel,
      cwd: config.projectRoot,
    },
  );

  const debugLogErrors = collectNewLogErrors(logSnapshot, config);
  const result = parseStreamOutput(output);
  result.debugLogErrors = debugLogErrors;

  // Detect stuck-in-read-loop (with context-aware action detection)
  const toolNames = result.toolCalls.map(t => t.tool);
  const calledWrite = toolNames.some(t => matchesWriteTools(t, config));
  const isAction = isActionRequestFn(question, config.actionVerbs);

  if (isAction && !calledWrite && toolNames.length >= 5) {
    log(`  WARNING: Action request but no write tool called after ${toolNames.length} tool calls`);
    result.errors.push({
      tool: 'harness:stuck-in-read-loop',
      input: { question, toolsCalled: toolNames },
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

// --- Grade answers ---

async function gradeAnswer(question, result, persona, config) {
  const toolLog = result.toolCalls.map(tc => {
    return `Tool: ${tc.tool}\nInput: ${JSON.stringify(tc.input)}\nResult: ${tc.result || '(no result captured)'}`;
  }).join('\n---\n');

  const personaContext = persona
    ? `## User context\nThe user is ${persona.name} (${persona.role || 'User'}). ${persona.description?.slice(0, 200) || ''}`
    : '';

  const prompt = [
    personaContext,
    `\n## Question\n${question}`,
    `\n## Tool calls and results\n${toolLog || '(no tools called)'}`,
    `\n## Final answer\n${result.answer.slice(0, 1500)}`,
  ].join('\n');

  try {
    const output = await claude(prompt, {
      systemPrompt: readPrompt(config.promptsDir, 'grader.md'),
      model: config.graderModel || 'sonnet',
      timeout: 60_000,
    });

    const match = output.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const grade = JSON.parse(match[0]);

    if (!grade.pass && grade.issues?.length > 0) {
      log(`  GRADING ISSUES: ${grade.issues.join('; ')}`);
      return grade.issues;
    }
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

  const prompt = isReadLoop ? [
    `During automated MCP testing, an LLM was asked to perform an action but couldn't figure out how to call the write tool.`,
    `\n**User request:** ${error.input?.question || 'unknown'}`,
    `**Tools called instead:** ${(error.input?.toolsCalled || []).join(', ')}`,
    `**Problem:** ${error.error}`,
    `\n${srcDirHint}`,
    `The issue is almost certainly that the write tool's description or inputSchema doesn't give enough information for an LLM to construct the correct parameters.`,
    `Read the write tools, find the relevant one, and improve its description and parameter descriptions.`,
    debugLogContext,
  ] : isGrading ? [
    `An automated QA grader found a semantic issue with the MCP tool's behavior.`,
    `The tool call succeeded (no error), but the result was incorrect or incomplete.`,
    `\n**User question:** ${error.input?.question || 'unknown'}`,
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

  return await claude(prompt.join('\n'), {
    systemPrompt: readPrompt(config.promptsDir, 'fixer.md'),
    allowedTools: config.fixerTools,
    timeout: 300_000,
    cwd: config.projectRoot,
  });
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
    // Create worktree from current HEAD
    execS(`git worktree add -b "${branchName}" "${worktreePath}" HEAD`, {
      cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000,
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

async function mergeFixBranches(branches, config) {
  if (branches.length === 0) return;
  const { execSync: execS } = await import('node:child_process');

  log(`  Merging ${branches.length} fix branches...`);

  // Collect all diffs from all worktrees
  const diffs = [];
  for (const b of branches) {
    try {
      const diff = execS(`git diff HEAD..."${b.branchName}"`, {
        cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000,
      }).trim();
      if (diff) diffs.push({ branch: b.branchName, diff });
    } catch {}
  }

  if (diffs.length === 1) {
    // Single branch — fast-forward merge, no conflict possible
    try {
      execS(`git merge "${diffs[0].branch}" --no-edit`, {
        cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000,
      });
      log(`    Merged ${diffs[0].branch}`);
    } catch (err) {
      log(`    Merge failed: ${err.message || err}`);
      try { execS('git merge --abort', { cwd: config.projectRoot, encoding: 'utf-8', timeout: 5_000 }); } catch {}
    }
  } else if (diffs.length > 1) {
    // Multiple branches — give Claude ALL diffs and let it merge them
    const diffSummary = diffs.map(d => `### ${d.branch}\n\`\`\`diff\n${d.diff.slice(0, 3000)}\n\`\`\``).join('\n\n');

    log(`    ${diffs.length} branches with changes — Claude merging all at once...`);
    await claude(
      [
        `${diffs.length} parallel fixers each made independent changes to the MCP server.`,
        `Apply ALL of these changes to the current codebase. Combine them intelligently — if two fixers edited the same function, merge both improvements together.`,
        `\n${diffSummary}`,
        `\nRead the current files, then Edit to apply all changes. Keep every improvement from every branch.`,
      ].join('\n'),
      {
        systemPrompt: 'You are merging parallel code fixes. Read each diff, then apply ALL changes to the current files using Edit. If two diffs modify the same area, combine both improvements. Do not drop any changes.',
        allowedTools: config.fixerTools,
        timeout: 300_000,
        cwd: config.projectRoot,
      },
    );
    log(`    Merged all ${diffs.length} branches`);
  }

  // Clean up all worktrees and branches
  for (const b of branches) {
    try { execS(`git worktree remove "${b.worktreePath}" --force`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 10_000 }); } catch {}
    try { execS(`git branch -D "${b.branchName}"`, { cwd: config.projectRoot, encoding: 'utf-8', timeout: 5_000 }); } catch {}
  }
}

// --- Deep fix (dev step) ---

async function deepFix(question, persona, replayScore, config) {
  log(`  Running deep fix for [${persona.id}]...`);

  const srcDirHint = config.srcDirs.length > 0
    ? `The source code is at: ${config.srcDirs.join(', ')}`
    : 'Find the source code in the project.';

  const prompt = [
    `A test question keeps failing even after the surface-level fixer improved tool descriptions.`,
    '',
    `**Persona:** ${persona.id} (${persona.name})`,
    `**Question:** ${question}`,
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

  return await claude(prompt, {
    systemPrompt: [
      'You are a senior developer fixing a failing test.',
      'The surface-level fixer already tried improving tool descriptions — that didn\'t work. You need to go deeper.',
      'Read the actual implementation, find the real bug, and fix it.',
      'Make the minimal fix that solves the problem.',
    ].join(' '),
    allowedTools: 'Read,Edit,Grep,Glob,Bash',
    timeout: 300_000,
    cwd: config.projectRoot,
  });
}

// --- Reviewer ---

async function runReviewer(allResults, config) {
  log('Running reviewer...');
  const logLines = [];
  for (const r of allResults) {
    logLines.push(`## Persona: ${r.persona.name} (${r.persona.role || 'User'})`);
    for (const q of r.questions) {
      logLines.push(`\n### Q: ${q.question}`);
      logLines.push(`Tools: ${q.toolCalls.map(t => t.tool).join(', ') || 'none'}`);
      if (q.errors.length > 0) {
        logLines.push(`ERRORS:`);
        for (const e of q.errors) logLines.push(`  - ${e.tool}: ${typeof e.error === 'string' ? e.error.slice(0, 300) : JSON.stringify(e.error).slice(0, 300)}`);
      }
      logLines.push(`Answer: ${q.answer.slice(0, 200)}`);
    }
    logLines.push('');
  }

  return await claude(
    `Review these MCP test results and improve tool descriptions:\n\n---\n${logLines.join('\n')}\n---`,
    {
      systemPrompt: readPrompt(config.promptsDir, 'reviewer.md'),
      allowedTools: config.reviewerTools,
      cwd: config.projectRoot,
    },
  );
}

// --- Escalation ---

async function escalate(allPassingQuestions, prefetchData, config) {
  log('\n' + '='.repeat(60));
  log('ESCALATION — generating harder questions');
  log('='.repeat(60));

  const seen = new Set();
  const unique = allPassingQuestions.filter(q => {
    const key = `${q.persona}::${q.question}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const byPersona = {};
  for (const q of unique) (byPersona[q.persona] = byPersona[q.persona] || []).push(q.question);

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

  const prompt = [
    `The test harness passed 100% three times in a row. Find the gaps.`,
    `\n## Passing questions\n${passingLog}`,
    `\n## Personas for escalation\n${personaDesc}`,
    `\n## System context\n${prefetchData || '(no prefetch data)'}`,
    `\nGenerate exactly ${escalationPersonas.length} harder questions — one per persona.`,
  ].join('\n');

  const output = await claude(prompt, {
    systemPrompt: readPrompt(config.promptsDir, 'escalator.md'),
    allowedTools: 'Read,Grep,Glob',
    timeout: 300_000,
    cwd: config.projectRoot,
  });

  let questions = [];
  try {
    const match = output.match(/\{[\s\S]*"questions"[\s\S]*\}/);
    if (match) questions = JSON.parse(match[0]).questions || [];
  } catch { /* fall through */ }

  if (questions.length === 0) {
    log('  No escalation questions generated');
    return [];
  }

  log(`  Generated ${questions.length} escalation questions:`);
  let promoted = 0;
  for (const eq of questions) {
    log(`    [${eq.persona}] ${eq.question}`);
    const persona = getPersona(config.personas, eq.persona);
    if (!persona) continue;
    if (promoteToGoldenSet(persona, eq.question, {
      timestamp: new Date().toISOString(),
      source: 'escalation',
      reason: eq.why || 'auto-escalation',
    }, config)) promoted++;
  }

  log(`  Promoted ${promoted} to golden set`);
  recordEscalation({ questionsGenerated: questions.length, questionsProductive: 0 }, config);
  return questions;
}

// --- Main ---

export async function run(config, args = {}) {
  const startTime = Date.now();
  const {
    questionLimit = config.questionsPerPersona,
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
  } = args;

  // Override config question limit
  config.questionsPerPersona = questionLimit;
  if (answererModel) config.answererModel = answererModel;

  // Ensure data dirs exist
  for (const dir of [config.logsDir, config.baselinesDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Select personas
  let selectedPersonas;
  let regressionBaseline = null;
  let regressionQuestions = null;

  if (isRegression) {
    regressionBaseline = loadBaseline(regressionFile, config);
    if (!regressionBaseline) { console.error('No baseline found.'); process.exit(1); }
    regressionQuestions = regressionBaseline.questions;
    const ids = [...new Set(regressionQuestions.map(q => q.persona))];
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

  log(`mcp-evolve starting`);
  log(`System: ${config.systemDescription}`);
  log(`Personas: ${selectedPersonas.map(p => `${p.id}[${p.group || 'train'}]`).join(', ')}`);
  log(`Questions/persona: ${isRegression ? 'from baseline' : questionLimit}`);
  console.log('');

  // Reset any leftover state from a previous run, then seed fresh
  await runReset(config);
  await runSeed(config);

  // Get state description (static) + prefetch live data
  const stateDescription = getStateDescription(config);
  const prefetchData = await runPrefetch(config);
  const fullContext = [stateDescription, prefetchData].filter(Boolean).join('\n\n');

  // Load golden set
  const goldenSet = skipGolden ? { questions: [] } : loadGoldenSet(config);
  if (goldenMax) goldenSet.maxSize = goldenMax;
  if (goldenSet.questions.length > 0) {
    log(`Golden set: ${goldenSet.questions.length} permanent regression questions`);
  }

  const allResults = [];
  const allErrors = [];

  // --- Per-persona runner ---
  async function runPersona(persona) {
    log(`\n${'='.repeat(60)}`);
    log(`Persona: ${persona.name} (${persona.role || 'User'}) [${persona.group || 'train'}]`);
    log('='.repeat(60));

    // Golden set questions for this persona — skip blocked ones
    const goldenForPersona = goldenSet.questions.filter(q => q.persona === persona.id && !q.blocked);
    const blockedCount = goldenSet.questions.filter(q => q.persona === persona.id && q.blocked).length;
    if (blockedCount > 0) log(`  ${blockedCount} golden question(s) blocked (needs /dev)`);
    const goldenQuestions = goldenForPersona.map(q => q.question);

    // Check if this persona has failing golden questions from the last baseline
    let goldenHealthy = true;
    if (goldenQuestions.length > 0 && !isRegression) {
      const lastBaseline = loadBaseline(null, config);
      if (lastBaseline) {
        const lastGoldenResults = lastBaseline.questions.filter(q =>
          q.persona === persona.id && goldenQuestions.includes(q.question)
        );
        const goldenFailing = lastGoldenResults.some(q =>
          !q.score?.completed || q.score?.stuck || q.score?.errorsFound > 0
        );
        if (goldenFailing) {
          goldenHealthy = false;
          log(`  Golden questions still failing — skipping new question generation, focusing on fixes`);
        }
      }
    }

    let questions;
    if (isRegression) {
      questions = regressionQuestions.filter(q => q.persona === persona.id).map(q => q.question);
    } else if (!goldenHealthy) {
      // Don't generate new questions — only run golden set until it's green
      questions = [];
    } else {
      questions = await generateQuestions(persona, config, fullContext);
    }

    // Append golden set questions
    if (goldenQuestions.length > 0) {
      const newGolden = goldenQuestions.filter(gq => !questions.includes(gq));
      if (newGolden.length > 0) {
        questions.push(...newGolden);
        log(`  + ${newGolden.length} golden set questions${!goldenHealthy ? ' (golden-only mode)' : ''}`);
      }
    }

    if (questions.length === 0) { log('  No questions, skipping'); return null; }

    // Diversity check
    if (!isRegression && !dryRun) {
      const baseline = loadBaseline(null, config);
      const diversity = checkDiversity(questions, baseline);
      if (diversity.lowDiversity) log(`  WARNING: Low diversity (${diversity.avgSimilarity})`);
    }

    const personaResult = { persona, questions: [] };
    const personaErrors = [];

    if (dryRun) {
      for (const q of questions) {
        log(`    - ${q}`);
        const score = scoreQuestion({ question: q, toolCalls: [], errors: [], debugLogErrors: [], answer: '[dry run]' }, config);
        personaResult.questions.push({ question: q, toolCalls: [], errors: [], debugLogErrors: [], answer: '[dry run]', score });
      }
      return { personaResult, personaErrors };
    }

    for (const question of questions) {
      const result = await answerQuestion(question, persona, config);

      // Grade answer semantically (unless grading is disabled)
      if (!args.skipGrading && result.errors.length === 0) {
        const gradingIssues = await gradeAnswer(question, result, persona, config);
        if (gradingIssues) {
          for (const issue of gradingIssues) {
            result.errors.push({
              tool: 'harness:grading',
              input: { question },
              error: issue,
            });
          }
        }
      }

      const score = scoreQuestion({ question, ...result }, config);
      result.score = score;
      personaResult.questions.push({ question, ...result });

      for (const error of result.errors) {
        personaErrors.push({ persona: persona.id, question, ...error });
      }
    }

    return { personaResult, personaErrors };
  }

  // Execute all personas in parallel — fixer runs as a batch after all complete
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

  // Phase B: Batch fix all errors, then rebuild once, then replay all failed
  if (!effectiveSkipFixer && !dryRun) {
    const fixableErrors = [];
    for (const r of allResults) {
      if ((r.persona.group || 'train') !== 'train') continue;
      for (const q of r.questions) {
        const mcpErrors = (q.errors || []).filter(e => e.tool !== 'cli');
        if (mcpErrors.length > 0) {
          fixableErrors.push({ persona: r.persona, question: q.question, errors: mcpErrors, debugLogErrors: q.debugLogErrors || [] });
        }
      }
    }

    if (fixableErrors.length > 0) {
      log('');
      log('='.repeat(60));
      log(`BATCH FIX: ${fixableErrors.length} questions with errors`);
      log('='.repeat(60));

      // Run fixers in PARALLEL — each in its own git worktree
      const fixPromises = fixableErrors.map((fe, i) => {
        const error = fe.errors[0]; // one fix per question
        const slug = `${fe.persona.id}-${i}-${Date.now()}`.replace(/[^a-z0-9-]/gi, '-').slice(0, 40);
        log(`  Fixing [${fe.persona.id}] ${error.tool} (worktree: ${slug})...`);
        return fixErrorInWorktree(error, fe.debugLogErrors, config, slug)
          .then(result => {
            if (result) log(`  Fixed [${fe.persona.id}] → branch ${result.branchName}`);
            else log(`  No changes from [${fe.persona.id}] fixer`);
            return result;
          })
          .catch(err => { log(`  Fix failed [${fe.persona.id}]: ${err.message || err}`); return null; });
      });
      const fixResults = (await Promise.all(fixPromises)).filter(Boolean);

      // Merge all fix branches back
      if (fixResults.length > 0) {
        await mergeFixBranches(fixResults, config);
      }

      // Rebuild once
      if (config.buildCommand) {
        log('  Rebuilding...');
        try {
          const { execSync } = await import('node:child_process');
          execSync(config.buildCommand, { cwd: config.projectRoot, stdio: 'ignore', timeout: 30_000 });

          // Replay all failed questions in parallel
          log(`  Replaying ${fixableErrors.length} failed questions in PARALLEL...`);
          const replayResults = await Promise.all(fixableErrors.map(async (fe) => {
            const replay = await answerQuestion(fe.question, fe.persona, config);
            const replayScore = scoreQuestion({ question: fe.question, ...replay }, config);
            replay.score = replayScore;

            const originalQ = allResults
              .find(r => r.persona.id === fe.persona.id)
              ?.questions.find(q => q.question === fe.question);
            const origScore = originalQ?.score;

            const fixed = replayScore.completed && !replayScore.stuck && replayScore.errorsFound === 0;
            const prevOk = origScore?.completed && !origScore?.stuck && origScore?.errorsFound === 0;
            const verdict = fixed && !prevOk ? 'FIXED' : fixed ? 'STILL OK' : 'STILL FAILING';
            log(`  [${fe.persona.id}] Replay: ${verdict} (tools: ${origScore?.toolsUsed || '?'} -> ${replayScore.toolsUsed})`);

            if (verdict === 'FIXED') {
              if (promoteToGoldenSet(fe.persona, fe.question, {
                timestamp: new Date().toISOString(),
                originalErrors: origScore?.errorsFound || 0,
                originalStuck: origScore?.stuck || false,
              }, config)) log(`  PROMOTED to golden set`);
            }

            const personaResult = allResults.find(r => r.persona.id === fe.persona.id);
            if (personaResult) {
              personaResult.questions.push({ question: `[REPLAY] ${fe.question}`, ...replay });
            }

            return { persona: fe.persona, question: fe.question, verdict, replayScore };
          }));

          const fixedCount = replayResults.filter(r => r.verdict === 'FIXED').length;
          const stillFailing = replayResults.filter(r => r.verdict === 'STILL FAILING');
          log(`  Replay summary: ${fixedCount} FIXED, ${stillFailing.length} STILL FAILING`);

          // Deep fix: when fixer couldn't solve it, run the dev
          if (stillFailing.length > 0) {
            log('');
            log('='.repeat(60));
            log(`DEEP FIX: ${stillFailing.length} questions the fixer couldn't solve`);
            log('='.repeat(60));

            for (const sf of stillFailing) {
              await deepFix(sf.question, sf.persona, sf.replayScore, config);
              log(`  Deep fix completed for [${sf.persona.id}]`);
            }

            // Rebuild and replay after deep fixes
            log('  Rebuilding after deep fixes...');
            try {
              execSync(config.buildCommand, { cwd: config.projectRoot, stdio: 'ignore', timeout: 30_000 });

              for (const sf of stillFailing) {
                const replay2 = await answerQuestion(sf.question, sf.persona, config);
                const replay2Score = scoreQuestion({ question: sf.question, ...replay2 }, config);
                replay2.score = replay2Score;

                const fixed2 = replay2Score.completed && !replay2Score.stuck && replay2Score.errorsFound === 0;
                const verdict2 = fixed2 ? 'FIXED BY DEV' : 'STILL FAILING';
                log(`  [${sf.persona.id}] ${verdict2} (tools: ${sf.replayScore.toolsUsed} -> ${replay2Score.toolsUsed})`);

                if (verdict2 === 'FIXED BY DEV') {
                  promoteToGoldenSet(sf.persona, sf.question, {
                    timestamp: new Date().toISOString(),
                    source: 'deep-fix',
                    originalStuck: sf.replayScore.stuck,
                  }, config);
                  log(`  PROMOTED to golden set (deep fix)`);
                }

                const personaResult = allResults.find(r => r.persona.id === sf.persona.id);
                if (personaResult) {
                  personaResult.questions.push({ question: `[DEV-REPLAY] ${sf.question}`, ...replay2 });
                }
              }
            } catch (buildErr) {
              log(`  Rebuild after deep fix failed: ${buildErr.message?.slice(0, 100)}`);
            }
          }
        } catch (buildErr) {
          log(`  Rebuild failed: ${buildErr.message?.slice(0, 100)}`);
        }
      }
    }
  }

  // Reviewer
  const trainResults = allResults.filter(r => (r.persona.group || 'train') === 'train');
  if (!dryRun && !effectiveSkipReviewer && trainResults.some(r => r.questions.length > 0)) {
    console.log('');
    log('='.repeat(60));
    await runReviewer(trainResults, config);
  }

  // Score
  const scoredQuestions = allResults.flatMap(r =>
    r.questions.map(q => ({ persona: r.persona.id, group: r.persona.group, question: q.question, score: q.score }))
  );

  // Save baseline
  if (!dryRun) saveBaseline(allResults, answererModel, config);

  // Update golden set health — track consecutive fails, auto-dev blocked questions
  if (!dryRun) {
    const { blocked: newlyBlocked } = updateGoldenHealth(allResults, config);

    // Collect ALL blocked questions (newly blocked + previously blocked without a fix branch)
    const currentGs = loadGoldenSet(config);
    const allBlocked = (currentGs.questions || []).filter(q => q.blocked && !q.autoDevBranch);

    if (allBlocked.length > 0 && !skipAutoDev) {
      log('');
      log('='.repeat(60));
      log(`AUTO-DEV: ${allBlocked.length} blocked golden question(s) — investigating in worktrees`);
      log('='.repeat(60));

      const devResults = await autoDev(allBlocked, config);
      for (const dr of devResults) {
        if (dr.verdict === 'FIX_READY') {
          log(`  [${dr.persona}] FIX READY → branch: ${dr.branch}`);
          log(`    Review: git diff ${dr.branch}`);
          log(`    Merge:  git merge ${dr.branch}`);
          const gq = currentGs.questions.find(q => q.persona === dr.persona && q.question === dr.question);
          if (gq) gq.autoDevBranch = dr.branch;
        } else {
          log(`  [${dr.persona}] ${dr.verdict} — could not resolve automatically`);
          const gq = currentGs.questions.find(q => q.persona === dr.persona && q.question === dr.question);
          if (gq) gq.autoDevAttempted = new Date().toISOString();
        }
      }
      writeFileSync(config.goldenSetPath, JSON.stringify(currentGs, null, 2) + '\n');
    } else if (allBlocked.length > 0) {
      log('');
      log('='.repeat(60));
      log(`BLOCKED: ${allBlocked.length} golden question(s) (auto-dev skipped)`);
      log('='.repeat(60));
      for (const bq of allBlocked) {
        log(`  [${bq.persona}] ${bq.question.slice(0, 80)}`);
      }
    }
  }

  // Regression comparison
  if (isRegression && regressionBaseline) {
    printRegressionReport(compareToBaseline(allResults, regressionBaseline));
  }

  // Escalation — ONLY when everything passes AND no blocked questions
  if (!dryRun && !noEscalate) {
    const escGs = loadGoldenSet(config);
    const hasBlocked = (escGs.questions || []).some(q => q.blocked);
    const currentAllPassed = !hasBlocked && scoredQuestions.length > 0 &&
      scoredQuestions.every(q => q.score?.completed && !q.score?.stuck && q.score?.errorsFound === 0);

    if (hasBlocked && !forceEscalate) {
      log(`\nEscalation skipped — ${(escGs.questions || []).filter(q => q.blocked).length} blocked question(s). Fix those first.`);
    }

    if (forceEscalate || currentAllPassed) {
      const streak = checkStreak(streakThreshold, config);
      if (forceEscalate || streak.triggered) {
        log(`\n100% STREAK: ${streak.streak} runs`);
        await escalate(streak.allPassingQuestions, fullContext, config);
      }

      // Feature competition — triggered at configurable multiplier of streak threshold
      // (e.g., 6 consecutive 100% runs when threshold=3, multiplier=2)
      const competitionThreshold = streakThreshold * (config.competitionStreakMultiplier || 2);
      if (!args.noCompete && (args.forceCompete || streak.streak >= competitionThreshold)) {
        const passingLog = streak.allPassingQuestions
          .map(q => `[${q.persona}] ${q.question}`)
          .join('\n');
        await runCompetition({ passingQuestions: passingLog, fullContext }, config);
      }
    }
  }

  // Write log
  const allScores = aggregateScores(scoredQuestions);
  const trainScores = aggregateScores(scoredQuestions.filter(q => q.group === 'train'));
  const evalScores = aggregateScores(scoredQuestions.filter(q => q.group === 'eval'));

  const logData = {
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    answererModel: answererModel || 'default',
    scores: { all: allScores, train: trainScores, eval: evalScores },
    summary: {
      totalQuestions: allResults.reduce((s, r) => s + r.questions.length, 0),
      totalErrors: allErrors.length,
      errorsByTool: allErrors.reduce((acc, e) => { acc[e.tool] = (acc[e.tool] || 0) + 1; return acc; }, {}),
    },
    errors: allErrors,
    results: allResults.map(r => ({
      persona: r.persona.id,
      group: r.persona.group,
      questions: r.questions.map(q => ({
        question: q.question, score: q.score,
        toolsCalled: q.toolCalls.map(t => t.tool),
        errorCount: q.errors.length,
        errors: q.errors.map(e => ({ tool: e.tool, error: typeof e.error === 'string' ? e.error.slice(0, 500) : JSON.stringify(e.error).slice(0, 500) })),
        answerPreview: q.answer.slice(0, 300),
      })),
    })),
  };

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = join(config.logsDir, `run-${ts}.json`);
  writeFileSync(logPath, JSON.stringify(logData, null, 2));

  // Update metrics
  if (!dryRun) {
    const mode = trainOnly ? 'train' : evalOnly ? 'eval' : isRegression ? 'regression' : 'full';
    updateMetrics({ scores: { all: allScores, train: trainScores, eval: evalScores }, results: allResults, errors: allErrors, logData, mode }, config);
  }

  // Summary
  console.log('');
  log('='.repeat(60));
  log('SUMMARY');
  log('='.repeat(60));
  log(`Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  log(`Personas: ${allResults.length} | Questions: ${logData.summary.totalQuestions} | Errors: ${allErrors.length}`);

  for (const [label, scores] of [['All', allScores], ['Train', trainScores], ['Eval', evalScores]]) {
    if (scores.total === 0) continue;
    log(`  ${label} (${scores.total}q): success=${scores.successRate}% | action=${scores.actionCompletionRate}% | errors/q=${scores.errorRate} | tools=${scores.avgTools}`);
  }

  log(`Log: ${logPath}`);

  // Reset test state so next run starts fresh
  await runReset(config);

  return { scores: { all: allScores, train: trainScores, eval: evalScores }, logData, allResults, allErrors };
}
