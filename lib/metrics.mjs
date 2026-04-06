/**
 * mcp-evolve — Persistent metrics store.
 *
 * Accumulates per-persona, per-tool, and system-level metrics across runs.
 * Updated after each run, consumed by steer/refine analysis.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isPassingScore } from './eval.mjs';

const MAX_HISTORY = 50;

function emptyStore() {
  return {
    version: 1,
    lastUpdated: null,
    totalRuns: 0,
    runs: [],
    personas: {},
    tools: {},
    fixes: { total: 0, successful: 0, history: [] },
    escalations: { total: 0, productive: 0, history: [] },
    apparatus: { lastRefine: null, refineHistory: [] },
  };
}

function cap(arr) {
  return arr.length > MAX_HISTORY ? arr.slice(-MAX_HISTORY) : arr;
}

export function loadMetrics(config) {
  try {
    const raw = JSON.parse(readFileSync(config.metricsPath, 'utf-8'));
    return { ...emptyStore(), ...raw };
  } catch {
    return emptyStore();
  }
}

export function saveMetrics(store, config) {
  store.lastUpdated = new Date().toISOString();
  writeFileSync(config.metricsPath, JSON.stringify(store, null, 2) + '\n');
}

export function updateMetrics({ scores, results, errors, logData, mode }, config) {
  const store = loadMetrics(config);
  const timestamp = logData?.timestamp || new Date().toISOString();
  const mcpPrefix = config.mcpToolPrefix || '';

  store.totalRuns++;

  store.runs = cap([...store.runs, {
    timestamp,
    mode: mode || 'full',
    successRate: parseFloat(scores.all.successRate) || 0,
    actionCompletionRate: scores.all.actionCompletionRate === 'N/A'
      ? null : parseFloat(scores.all.actionCompletionRate) || 0,
    errorRate: parseFloat(scores.all.errorRate) || 0,
    avgTools: parseFloat(scores.all.avgTools) || 0,
    totalQuestions: scores.all.total,
  }]);

  for (const r of results) {
    const pid = r.persona.id;
    if (!store.personas[pid]) {
      store.personas[pid] = {
        totalQuestions: 0, totalFailures: 0, totalFixes: 0,
        lastFailureRun: null, lastFailureQuestion: null,
        runsSinceLastFailure: 0, successRateHistory: [],
      };
    }
    const ps = store.personas[pid];
    const realQuestions = r.questions.filter(q => !q.question.startsWith('[REPLAY]'));
    const failures = realQuestions.filter(q => !isPassingScore(q.score));

    ps.totalQuestions += realQuestions.length;
    ps.totalFailures += failures.length;

    if (failures.length > 0) {
      ps.lastFailureRun = timestamp;
      ps.lastFailureQuestion = failures[0].question?.slice(0, 120);
      ps.runsSinceLastFailure = 0;
    } else {
      ps.runsSinceLastFailure++;
    }

    const rate = realQuestions.length > 0
      ? parseFloat(((realQuestions.length - failures.length) / realQuestions.length * 100).toFixed(1))
      : 100;
    ps.successRateHistory = cap([...ps.successRateHistory, rate]);

    // Per-tool stats
    for (const q of r.questions) {
      const toolNames = (q.toolCalls || []).map(t => t.tool || t);
      for (const tool of toolNames) {
        const clean = tool.replace(mcpPrefix, '');
        if (!store.tools[clean]) {
          store.tools[clean] = {
            totalCalls: 0, totalErrors: 0,
            calledByPersonas: [], lastErrorRun: null, callHistory: [],
          };
        }
        store.tools[clean].totalCalls++;
        if (!store.tools[clean].calledByPersonas.includes(pid)) {
          store.tools[clean].calledByPersonas.push(pid);
        }
      }

      for (const e of (q.errors || [])) {
        if (e.tool === 'cli' || e.tool === 'harness:stuck-in-read-loop') continue;
        const clean = e.tool.replace(mcpPrefix, '');
        if (store.tools[clean]) {
          store.tools[clean].totalErrors++;
          store.tools[clean].lastErrorRun = timestamp;
        }
      }
    }

    // Fix stats from replays
    const replays = r.questions.filter(q => q.question.startsWith('[REPLAY]'));
    for (const replay of replays) {
      const fixed = isPassingScore(replay.score);
      store.fixes.total++;
      if (fixed) { store.fixes.successful++; ps.totalFixes++; }
      store.fixes.history = cap([...store.fixes.history, {
        timestamp, persona: pid,
        question: replay.question.replace('[REPLAY] ', '').slice(0, 120),
        verdict: fixed ? 'FIXED' : 'STILL_FAILING',
      }]);
    }
  }

  saveMetrics(store, config);
  return store;
}

export function recordEscalation({ questionsGenerated, questionsProductive }, config) {
  const store = loadMetrics(config);
  store.escalations.total++;
  if (questionsProductive > 0) store.escalations.productive++;
  store.escalations.history = cap([...store.escalations.history, {
    timestamp: new Date().toISOString(), questionsGenerated,
    questionsProductive: questionsProductive || 0,
  }]);
  saveMetrics(store, config);
}

export function recordCompetition({ winner, featureName, voteCounts }, config) {
  const store = loadMetrics(config);
  if (!store.competitions) store.competitions = { total: 0, productive: 0, history: [] };
  store.competitions.total++;
  if (winner) store.competitions.productive++;
  store.competitions.history = cap([...store.competitions.history, {
    timestamp: new Date().toISOString(), winner, featureName, voteCounts,
  }]);
  saveMetrics(store, config);
}

export function recordRefine({ component, change, impact }, config) {
  const store = loadMetrics(config);
  store.apparatus.lastRefine = new Date().toISOString();
  store.apparatus.refineHistory = cap([...store.apparatus.refineHistory, {
    timestamp: new Date().toISOString(), component, change, impact: impact || null,
  }]);
  saveMetrics(store, config);
}

// --- Query helpers ---

export function getStalePersonas(config, minRuns = 5) {
  const store = loadMetrics(config);
  return Object.entries(store.personas)
    .map(([id, ps]) => ({
      id, runsSinceLastFailure: ps.runsSinceLastFailure,
      totalQuestions: ps.totalQuestions, lastFailureRun: ps.lastFailureRun,
      avgSuccessRate: ps.successRateHistory.length > 0
        ? (ps.successRateHistory.reduce((a, b) => a + b, 0) / ps.successRateHistory.length).toFixed(1) : 'N/A',
    }))
    .filter(p => p.runsSinceLastFailure >= minRuns)
    .sort((a, b) => b.runsSinceLastFailure - a.runsSinceLastFailure);
}

export function getUntestedTools(allToolNames, config) {
  const store = loadMetrics(config);
  const tested = new Set(Object.keys(store.tools));
  return allToolNames.filter(t => !tested.has(t));
}

export function getErrorProneTools(config, minCalls = 3) {
  const store = loadMetrics(config);
  return Object.entries(store.tools)
    .map(([name, ts]) => ({
      name, totalCalls: ts.totalCalls, totalErrors: ts.totalErrors,
      errorRate: ts.totalCalls > 0 ? (ts.totalErrors / ts.totalCalls * 100).toFixed(1) : 0,
      personas: ts.calledByPersonas,
    }))
    .filter(t => t.totalCalls >= minCalls)
    .sort((a, b) => parseFloat(b.errorRate) - parseFloat(a.errorRate));
}

export function getSuccessRateTrend(config, window = 10) {
  const store = loadMetrics(config);
  return store.runs.slice(-window).map(r => ({
    timestamp: r.timestamp, successRate: r.successRate,
    actionCompletionRate: r.actionCompletionRate, questions: r.totalQuestions,
  }));
}

export function detectPlateau(config, window = 5) {
  const store = loadMetrics(config);
  const recent = store.runs.slice(-window);
  if (recent.length < window) return { plateau: false, reason: 'not enough data' };
  const allPerfect = recent.every(r => r.successRate === 100);
  if (!allPerfect) return { plateau: false, reason: 'recent failures exist' };
  const recentEsc = store.escalations.history.slice(-3);
  if (recentEsc.some(e => e.questionsProductive > 0)) {
    return { plateau: false, reason: '100% but escalation still finding gaps' };
  }
  return {
    plateau: true,
    reason: `${window} consecutive 100% runs and escalation not finding new gaps`,
    suggestion: 'Evolve the testing apparatus or add new persona clusters',
  };
}

export function getFullSummary(config) {
  const store = loadMetrics(config);
  return {
    totalRuns: store.totalRuns, lastUpdated: store.lastUpdated,
    recentRuns: store.runs.slice(-10),
    personaCount: Object.keys(store.personas).length,
    toolCount: Object.keys(store.tools).length,
    fixRate: store.fixes.total > 0
      ? `${store.fixes.successful}/${store.fixes.total} (${(store.fixes.successful / store.fixes.total * 100).toFixed(0)}%)`
      : 'no fixes yet',
    escalationRate: store.escalations.total > 0
      ? `${store.escalations.productive}/${store.escalations.total} productive`
      : 'no escalations yet',
    plateau: detectPlateau(config),
  };
}
