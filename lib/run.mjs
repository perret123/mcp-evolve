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
  loadGoldenSet, promoteToGoldenSet, getGoldenQuestions, checkStreak,
  buildActionPattern,
} from './eval.mjs';
import { updateMetrics, recordEscalation } from './metrics.mjs';

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

// --- Prefetch ---

async function runPrefetch(config) {
  if (!config.prefetch) return '';
  log('Running prefetch to get real entity names...');
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

async function generateQuestions(persona, config, prefetchData) {
  log(`Generating ${config.questionsPerPersona} questions for "${persona.name}"...`);

  const previousQuestions = getPreviousQuestions(persona.id, config);
  const diversityHint = previousQuestions.length > 0
    ? `\n\nIMPORTANT: Vary your phrasing. These questions were asked before — do NOT repeat them:\n${previousQuestions.map(q => `- ${q}`).join('\n')}`
    : '';

  const prefetchHint = prefetchData
    ? `\n\nIMPORTANT: Use ONLY real data from the system:\n${prefetchData}`
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

  // Detect stuck-in-read-loop
  const toolNames = result.toolCalls.map(t => t.tool);
  const calledWrite = toolNames.some(t => matchesWriteTools(t, config));
  const actionPattern = buildActionPattern(config.actionVerbs);
  const isActionRequest = actionPattern.test(question);

  if (isActionRequest && !calledWrite && toolNames.length >= 5) {
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

// --- Fix errors ---

async function fixError(error, debugLogErrors, config) {
  log(`  Running fixer for ${error.tool}...`);
  const isReadLoop = error.tool === 'harness:stuck-in-read-loop';

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

  // Prefetch real data for question generation
  const prefetchData = await runPrefetch(config);

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

    let questions;
    if (isRegression) {
      questions = regressionQuestions.filter(q => q.persona === persona.id).map(q => q.question);
    } else {
      questions = await generateQuestions(persona, config, prefetchData);
    }

    // Append golden set questions
    const goldenForPersona = goldenSet.questions.filter(q => q.persona === persona.id);
    if (goldenForPersona.length > 0) {
      const newGolden = goldenForPersona.map(q => q.question).filter(gq => !questions.includes(gq));
      if (newGolden.length > 0) {
        questions.push(...newGolden);
        log(`  + ${newGolden.length} golden set questions`);
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
      const score = scoreQuestion({ question, ...result }, config);
      result.score = score;
      personaResult.questions.push({ question, ...result });

      for (const error of result.errors) {
        personaErrors.push({ persona: persona.id, question, ...error });
      }

      // Fix errors for train personas
      const isTrainPersona = (persona.group || 'train') === 'train';
      const mcpErrors = result.errors.filter(e => e.tool !== 'cli');
      if (mcpErrors.length > 0 && !effectiveSkipFixer && isTrainPersona) {
        for (const error of mcpErrors) {
          await fixError(error, result.debugLogErrors || [], config);
        }

        // Rebuild and replay
        if (config.buildCommand) {
          log(`  Rebuilding and replaying...`);
          try {
            const { execSync } = await import('node:child_process');
            execSync(config.buildCommand, { cwd: config.projectRoot, stdio: 'ignore', timeout: 30_000 });

            const replay = await answerQuestion(question, persona, config);
            const replayScore = scoreQuestion({ question, ...replay }, config);
            replay.score = replayScore;

            const fixed = replayScore.completed && !replayScore.stuck && replayScore.errorsFound === 0;
            const prevOk = score.completed && !score.stuck && score.errorsFound === 0;
            const verdict = fixed && !prevOk ? 'FIXED' : fixed ? 'STILL OK' : 'STILL FAILING';
            log(`  Replay: ${verdict}`);

            if (verdict === 'FIXED') {
              if (promoteToGoldenSet(persona, question, {
                timestamp: new Date().toISOString(),
                originalErrors: score.errorsFound,
                originalStuck: score.stuck,
              }, config)) {
                log(`  PROMOTED to golden set`);
              }
            }

            personaResult.questions.push({ question: `[REPLAY] ${question}`, ...replay });
          } catch (err) {
            log(`  Rebuild failed: ${err.message?.slice(0, 100)}`);
          }
        }
      }
    }

    return { personaResult, personaErrors };
  }

  // Execute personas
  const canParallelize = effectiveSkipFixer || dryRun;

  if (canParallelize && selectedPersonas.length > 1) {
    log(`Running ${selectedPersonas.length} personas in PARALLEL`);
    const results = await Promise.all(selectedPersonas.map(p => runPersona(p)));
    for (const r of results) {
      if (!r) continue;
      allResults.push(r.personaResult);
      allErrors.push(...r.personaErrors);
    }
  } else {
    for (const persona of selectedPersonas) {
      const r = await runPersona(persona);
      if (!r) continue;
      allResults.push(r.personaResult);
      allErrors.push(...r.personaErrors);
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

  // Regression comparison
  if (isRegression && regressionBaseline) {
    printRegressionReport(compareToBaseline(allResults, regressionBaseline));
  }

  // Escalation
  if (!dryRun && !noEscalate) {
    const currentAllPassed = scoredQuestions.length > 0 &&
      scoredQuestions.every(q => q.score?.completed && !q.score?.stuck && q.score?.errorsFound === 0);

    if (forceEscalate || currentAllPassed) {
      const streak = checkStreak(streakThreshold, config);
      if (forceEscalate || streak.triggered) {
        log(`\n100% STREAK: ${streak.streak} runs`);
        await escalate(streak.allPassingQuestions, prefetchData, config);
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

  return { scores: { all: allScores, train: trainScores, eval: evalScores }, logData, allResults, allErrors };
}
