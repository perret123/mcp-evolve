/**
 * mcp-evolve — Evaluation engine.
 *
 * Scoring, baselines, golden set, regression comparison, diversity detection.
 * Generic — uses config.writeTools for action detection instead of hardcoded names.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_GOLDEN_MAX = 50;

// --- Action detection ---

/**
 * Build a regex for detecting action requests in questions.
 * Uses common action verbs — extended by write tool names from config.
 */
const BASE_ACTION_VERBS = [
  'add', 'put', 'move', 'transfer', 'remove', 'delete', 'create',
  'update', 'cancel', 'close', 'process', 'send', 'assign', 'set',
  'approve', 'reject', 'finalize', 'submit', 'import', 'export',
];

export function buildActionPattern(extraVerbs = []) {
  const allVerbs = [...new Set([...BASE_ACTION_VERBS, ...extraVerbs])];
  return new RegExp(`\\b(${allVerbs.join('|')})\\b`, 'i');
}

/**
 * Check if a tool name matches write tool patterns from config.
 */
function matchesWriteTools(toolName, writeToolPatterns, mcpPrefix) {
  const clean = toolName.replace(mcpPrefix, '');
  for (const pattern of writeToolPatterns) {
    if (pattern.includes('*')) {
      const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (re.test(clean) || re.test(toolName)) return true;
    } else {
      if (clean === pattern || toolName === pattern || clean.includes(pattern)) return true;
    }
  }
  return false;
}

// --- Scoring ---

/**
 * Score a single question result.
 */
export function scoreQuestion(questionResult, config = {}) {
  const { question, toolCalls = [], errors = [], debugLogErrors = [], answer = '' } = questionResult;
  const toolNames = toolCalls.map(t => t.tool || t);

  const actionPattern = buildActionPattern(config.actionVerbs);
  const isActionRequest = actionPattern.test(question);
  const writeToolCalled = toolNames.some(t =>
    matchesWriteTools(t, config.writeTools || [], config.mcpToolPrefix || '')
  );

  const timedOut = answer.startsWith('{') && answer.includes('"type":"system"') && toolNames.length > 10;
  const stuck = isActionRequest && !writeToolCalled && toolNames.length >= 5;
  const mcpErrors = errors.filter(e => e.tool !== 'cli' && e.tool !== 'harness:stuck-in-read-loop');
  const completed = !timedOut && !stuck && answer.length > 50 && !answer.startsWith('ERROR');

  return {
    completed,
    errorsFound: mcpErrors.length,
    debugLogErrors: debugLogErrors.length,
    stuck,
    toolsUsed: toolNames.length,
    isActionRequest,
    writeToolCalled,
    timedOut,
  };
}

/**
 * Compute aggregate scores for a full run.
 */
export function aggregateScores(scoredQuestions) {
  const total = scoredQuestions.length;
  if (total === 0) return { total: 0, successRate: 0, actionCompletionRate: 0, errorRate: 0, avgTools: 0 };

  const successes = scoredQuestions.filter(q => q.score.completed && !q.score.stuck && q.score.errorsFound === 0);
  const actionRequests = scoredQuestions.filter(q => q.score.isActionRequest);
  const actionsCompleted = actionRequests.filter(q => q.score.writeToolCalled);
  const totalErrors = scoredQuestions.reduce((s, q) => s + q.score.errorsFound, 0);
  const totalTools = scoredQuestions.reduce((s, q) => s + q.score.toolsUsed, 0);

  return {
    total,
    successRate: (successes.length / total * 100).toFixed(1),
    actionCompletionRate: actionRequests.length > 0
      ? (actionsCompleted.length / actionRequests.length * 100).toFixed(1)
      : 'N/A',
    errorRate: (totalErrors / total).toFixed(2),
    avgTools: (totalTools / total).toFixed(1),
  };
}

// --- Baselines ---

export function saveBaseline(results, answererModel, config) {
  const dir = config.baselinesDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const questions = [];
  for (const r of results) {
    for (const q of r.questions) {
      questions.push({
        persona: r.persona.id,
        group: r.persona.group,
        question: q.question,
        score: q.score,
      });
    }
  }

  const baseline = {
    timestamp: new Date().toISOString(),
    answererModel: answererModel || 'default',
    questions,
  };

  const ts = baseline.timestamp.replace(/[:.]/g, '-').slice(0, 19);
  const path = join(dir, `baseline-${ts}.json`);
  writeFileSync(path, JSON.stringify(baseline, null, 2));
  return path;
}

export function loadBaseline(pathOrNull, config) {
  if (pathOrNull) {
    return JSON.parse(readFileSync(pathOrNull, 'utf-8'));
  }

  const dir = config.baselinesDir;
  if (!existsSync(dir)) return null;

  const files = readdirSync(dir)
    .filter(f => f.startsWith('baseline-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'));
}

export function compareToBaseline(currentResults, baseline) {
  const report = { improved: [], regressed: [], unchanged: [], newQuestions: [] };

  const baselineMap = new Map();
  for (const bq of baseline.questions) {
    baselineMap.set(`${bq.persona}::${bq.question}`, bq.score);
  }

  for (const r of currentResults) {
    for (const q of r.questions) {
      const key = `${r.persona.id}::${q.question}`;
      const oldScore = baselineMap.get(key);

      if (!oldScore) {
        report.newQuestions.push({ persona: r.persona.id, question: q.question, score: q.score });
        continue;
      }

      const wasGood = oldScore.completed && !oldScore.stuck && oldScore.errorsFound === 0;
      const isGood = q.score.completed && !q.score.stuck && q.score.errorsFound === 0;

      if (!wasGood && isGood) {
        report.improved.push({ persona: r.persona.id, question: q.question, oldScore, newScore: q.score });
      } else if (wasGood && !isGood) {
        report.regressed.push({ persona: r.persona.id, question: q.question, oldScore, newScore: q.score });
      } else {
        report.unchanged.push({ persona: r.persona.id, question: q.question });
      }
    }
  }

  return report;
}

export function printRegressionReport(report) {
  console.log('\n' + '='.repeat(60));
  console.log('REGRESSION REPORT');
  console.log('='.repeat(60));

  if (report.improved.length > 0) {
    console.log(`\n  IMPROVED (${report.improved.length}):`);
    for (const r of report.improved) {
      const reason = r.oldScore.stuck ? 'stuck -> completed' : `${r.oldScore.errorsFound} errors -> ${r.newScore.errorsFound}`;
      console.log(`    + "${r.question.slice(0, 70)}..." (${reason})`);
    }
  }

  if (report.regressed.length > 0) {
    console.log(`\n  REGRESSED (${report.regressed.length}):`);
    for (const r of report.regressed) {
      const reason = r.newScore.stuck ? 'completed -> stuck' : `${r.oldScore.errorsFound} errors -> ${r.newScore.errorsFound}`;
      console.log(`    ! "${r.question.slice(0, 70)}..." (${reason})`);
    }
  }

  if (report.unchanged.length > 0) {
    console.log(`\n  UNCHANGED: ${report.unchanged.length} questions`);
  }

  if (report.newQuestions.length > 0) {
    console.log(`\n  NEW (not in baseline): ${report.newQuestions.length} questions`);
  }

  const hasRegression = report.regressed.length > 0;
  console.log(`\n  VERDICT: ${hasRegression ? 'REGRESSION DETECTED' : 'OK — no regressions'}`);
  return hasRegression;
}

// --- Diversity ---

function jaccardSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function checkDiversity(newQuestions, baseline) {
  if (!baseline || baseline.questions.length === 0) {
    return { avgSimilarity: 0, lowDiversity: false, duplicates: [] };
  }

  const baseQuestions = baseline.questions.map(q => q.question);
  let totalSim = 0;
  let comparisons = 0;
  const duplicates = [];

  for (const nq of newQuestions) {
    for (const bq of baseQuestions) {
      const sim = jaccardSimilarity(nq, bq);
      totalSim += sim;
      comparisons++;
      if (sim > 0.8) {
        duplicates.push({ new: nq.slice(0, 60), baseline: bq.slice(0, 60), similarity: sim.toFixed(2) });
      }
    }
  }

  const avgSimilarity = comparisons > 0 ? totalSim / comparisons : 0;
  return {
    avgSimilarity: avgSimilarity.toFixed(3),
    lowDiversity: avgSimilarity > 0.5,
    duplicates,
  };
}

export function getPreviousQuestions(personaId, config) {
  const baseline = loadBaseline(null, config);
  if (!baseline) return [];
  return baseline.questions
    .filter(q => q.persona === personaId)
    .map(q => q.question);
}

// --- Streak Detection ---

export function checkStreak(minStreak = 3, config) {
  const dir = config.baselinesDir;
  if (!existsSync(dir)) return { streak: 0, baselines: [] };

  const files = readdirSync(dir)
    .filter(f => f.startsWith('baseline-') && f.endsWith('.json'))
    .sort()
    .reverse();

  let streak = 0;
  const streakBaselines = [];

  for (const file of files) {
    try {
      const baseline = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      const questions = baseline.questions || [];
      if (questions.length === 0) continue;

      const allPassed = questions.every(q =>
        q.score?.completed && !q.score?.stuck && q.score?.errorsFound === 0
      );

      if (allPassed) {
        streak++;
        streakBaselines.push({ file, timestamp: baseline.timestamp, questionCount: questions.length });
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return {
    streak,
    triggered: streak >= minStreak,
    baselines: streakBaselines,
    allPassingQuestions: streakBaselines.length > 0
      ? files.slice(0, streak).flatMap(file => {
          try {
            const b = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
            return (b.questions || []).map(q => ({ persona: q.persona, question: q.question }));
          } catch { return []; }
        })
      : [],
  };
}

// --- Golden Set ---

export function loadGoldenSet(config) {
  try {
    return JSON.parse(readFileSync(config.goldenSetPath, 'utf-8'));
  } catch {
    return { description: '', maxSize: DEFAULT_GOLDEN_MAX, questions: [] };
  }
}

export function promoteToGoldenSet(persona, question, fixCycle, config) {
  const gs = loadGoldenSet(config);
  const maxSize = gs.maxSize || DEFAULT_GOLDEN_MAX;

  const exists = gs.questions.some(q => q.persona === persona.id && q.question === question);
  if (exists) return false;

  gs.questions.push({
    persona: persona.id,
    group: persona.group,
    question,
    promotedAt: new Date().toISOString(),
    fixCycle,
  });

  while (gs.questions.length > maxSize) {
    gs.questions.shift();
  }

  writeFileSync(config.goldenSetPath, JSON.stringify(gs, null, 2) + '\n');
  return true;
}

export function getGoldenQuestions(personaId, config) {
  const gs = loadGoldenSet(config);
  if (!personaId) return gs.questions;
  return gs.questions.filter(q => q.persona === personaId);
}
