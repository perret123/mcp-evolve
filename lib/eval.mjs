/**
 * mcp-evolve — Evaluation engine.
 *
 * Scoring, baselines, golden set, regression comparison, diversity detection.
 * Generic — uses config.writeTools for action detection instead of hardcoded names.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// --- Deterministic split helpers (Spec 2) ---

/**
 * Deterministic 32-bit string hash (djb2 variant).
 * Returns an unsigned 32-bit integer. Stable across Node versions.
 */
export function hashString(str) {
  let h = 5381;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

/**
 * Seeded PRNG — mulberry32. Deterministic; identical seeds yield identical
 * sequences across Node versions and platforms.
 * @param {number} seed
 * @returns {() => number} a function returning values in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically mark K of N generated prompts as `evaluation: 'holdout'`,
 * the rest as `evaluation: 'fixer'`. All marked `lifecycle: 'train'`.
 *
 * Mutates each prompt's `promptObj` in place (adds `lifecycle` + `evaluation`
 * while preserving probe/invariant/adversarial/etc). Returns the same array.
 *
 * The seed is hashed with `hashString` and fed to `mulberry32` to select a
 * stable index ordering, then the first K indices become holdout.
 *
 * @param {Array<{prompt: string, promptObj: object}>} prompts
 * @param {number} K — holdout count per call
 * @param {string} seed — seed string (e.g. `${runStartTime}-${personaId}`)
 */
export function splitForHoldout(prompts, K, seed) {
  const rng = mulberry32(hashString(seed));
  const indices = prompts.map((_, i) => i);
  // Fisher-Yates shuffle (seeded)
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const holdoutIndices = new Set(indices.slice(0, Math.max(0, Math.min(K, prompts.length))));
  prompts.forEach((p, i) => {
    if (!p.promptObj || typeof p.promptObj !== 'object') p.promptObj = {};
    p.promptObj.lifecycle = 'train';
    p.promptObj.evaluation = holdoutIndices.has(i) ? 'holdout' : 'fixer';
  });
  return prompts;
}

// --- Action detection ---

/**
 * Build a regex for detecting action requests in prompts.
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
 * Informational prompt patterns — these are NOT action requests even if
 * they contain action verbs. "How does the system add X?" is asking
 * about how adding works, not a request to add something.
 */
const INFORMATIONAL_PATTERNS = [
  /^(how|what|why|when|where|which|does|is|are|can you explain|tell me about|show me how)\b/i,
  /\b(how does|how do|how is|how are|what happens|what determines|what is)\b/i,
  /\?\s*$/,  // ends with question mark
];

/**
 * Command patterns — these ARE action requests even if phrased as questions.
 * "Can you add X to table 5?" is a command disguised as an inquiry.
 */
const COMMAND_PATTERNS = [
  /^(can you|could you|please|i need you to|go ahead and)\s+(add|put|move|create|delete|remove|process|close|cancel|transfer|set)/i,
  /\b(to table|to seat|to the guest|for table|onto)\b/i,
];

/**
 * Detect if a prompt is an action request, with context-aware filtering.
 * Returns true for actual commands, false for informational prompts about actions.
 */
export function isActionRequest(prompt, extraVerbs = []) {
  const actionPattern = buildActionPattern(extraVerbs);
  if (!actionPattern.test(prompt)) return false;

  // Check if it's a command pattern (overrides informational)
  if (COMMAND_PATTERNS.some(p => p.test(prompt))) return true;

  // Check if it's informational (contains action verb but is asking about it)
  if (INFORMATIONAL_PATTERNS.some(p => p.test(prompt))) return false;

  // Default: if it has an action verb and isn't clearly informational, treat as action
  return true;
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

export function isPassingScore(score) {
  return !!score
    && score.completed
    && !score.stuck
    && score.errorsFound === 0
    && score.actionRequirementMet !== false;
}

export function classifyErrorCategory(error, config = {}) {
  const tool = error?.tool || 'unknown';
  const message = typeof error?.error === 'string'
    ? error.error.toLowerCase()
    : JSON.stringify(error?.error || '').toLowerCase();

  if (
    tool === 'cli'
    || tool === 'harness:tool-availability'
    || tool === 'harness:healthcheck'
    || tool === 'harness:output-truncation'
  ) {
    return 'harness';
  }

  if (tool === 'harness:stuck-in-read-loop' || tool === 'harness:action-missing-write') {
    return 'model';
  }

  if (tool === 'harness:grading') {
    if (/(returned|returning|missing field|wrong value|null|silent failure|implementation|handler|backend|server|data issue|completedat)/.test(message)) {
      return 'server';
    }
    return 'model';
  }

  if (config.mcpToolPrefix && tool.startsWith(config.mcpToolPrefix)) {
    return 'server';
  }

  return 'model';
}

// --- Scoring ---

/**
 * Score a single prompt result.
 */
export function scorePrompt(promptResult, config = {}) {
  const { toolCalls = [], errors = [], debugLogErrors = [], response = '', grading = null } = promptResult;
  const prompt = promptResult.prompt || '';
  const toolNames = toolCalls.map(t => t.tool || t);

  const isAction = isActionRequest(prompt, config.actionVerbs);
  const writeToolCalled = toolNames.some(t =>
    matchesWriteTools(t, config.writeTools || [], config.mcpToolPrefix || '')
  );
  const actionNoopApproved = grading?.actionExpectation === 'valid_noop';
  const actionRequirementMet = !isAction || writeToolCalled || actionNoopApproved;

  const timedOut = response.startsWith('{') && response.includes('"type":"system"') && toolNames.length > 10;
  const stuck = isAction && !actionRequirementMet && toolNames.length >= 5;
  const mcpErrors = errors.filter(e => e.tool !== 'cli' && e.tool !== 'harness:stuck-in-read-loop');
  const completed = !timedOut && !stuck && response.length > 50 && !response.startsWith('ERROR');

  return {
    completed,
    errorsFound: mcpErrors.length,
    debugLogErrors: debugLogErrors.length,
    stuck,
    toolsUsed: toolNames.length,
    isActionRequest: isAction,
    writeToolCalled,
    actionNoopApproved,
    actionRequirementMet,
    timedOut,
    obsolete: !!promptResult.obsolete,
  };
}

/**
 * Compute aggregate scores for a full run.
 */
export function aggregateScores(scoredPrompts, scoreField = 'score') {
  const readScore = q => q[scoreField] || q.score;
  const active = scoredPrompts.filter(q => {
    const s = readScore(q);
    return s && !s.obsolete && !q.invalid;
  });
  const total = active.length;
  if (total === 0) {
    return {
      total: 0, successRate: 0, actionCompletionRate: 0,
      errorRate: 0, avgTools: 0,
      obsoleteCount: scoredPrompts.filter(q => readScore(q)?.obsolete && !q.invalid).length,
      invalidCount: scoredPrompts.filter(q => q.invalid).length,
    };
  }

  const successes = active.filter(q => isPassingScore(readScore(q)));
  const actionRequests = active.filter(q => readScore(q).isActionRequest);
  const actionsCompleted = actionRequests.filter(q => readScore(q).actionRequirementMet);
  const totalErrors = active.reduce((s, q) => s + readScore(q).errorsFound, 0);
  const totalTools = active.reduce((s, q) => s + readScore(q).toolsUsed, 0);

  return {
    total,
    successRate: (successes.length / total * 100).toFixed(1),
    actionCompletionRate: actionRequests.length > 0
      ? (actionsCompleted.length / actionRequests.length * 100).toFixed(1)
      : 'N/A',
    errorRate: (totalErrors / total).toFixed(2),
    avgTools: (totalTools / total).toFixed(1),
    obsoleteCount: scoredPrompts.filter(q => readScore(q)?.obsolete && !q.invalid).length,
    invalidCount: scoredPrompts.filter(q => q.invalid).length,
  };
}

/**
 * Pure overfitting detection. Compares pre-fix and post-fix success rates for
 * train and holdout tiers and flags a run as overfit when train improves
 * while holdout decays by more than `threshold` (default 0.1 = 10%).
 *
 * Additionally flags per-persona divergences: any holdout prompt that went
 * pass → fail while any train prompt by the same persona went fail → pass.
 *
 * @param {object} args
 * @param {object} args.trainPre  aggregated pre-fix scores for train+fixer
 * @param {object} args.trainPost aggregated post-fix scores for train+fixer
 * @param {object} args.holdoutPre  aggregated pre-fix scores for train+holdout
 * @param {object} args.holdoutPost aggregated post-fix scores for train+holdout
 * @param {Array<object>} [args.perPromptPairs] optional per-prompt {persona, prompt, evaluation, scorePre, scorePost} entries for divergence detection
 * @param {number} [args.threshold=0.1]
 * @returns {{detected: boolean, trainDelta: number, holdoutDelta: number, threshold: number, divergences: object[]}}
 */
export function overfittingDetection({ trainPre, trainPost, holdoutPre, holdoutPost, perPromptPairs = [], threshold = 0.1 }) {
  const asRate = x => typeof x === 'string' ? parseFloat(x) / 100 : Number(x) / 100;
  const trainDelta = asRate(trainPost.successRate) - asRate(trainPre.successRate);
  const holdoutDelta = asRate(holdoutPost.successRate) - asRate(holdoutPre.successRate);

  const trainImproved = trainDelta > threshold;
  const holdoutDecayed = holdoutDelta < -threshold;
  const detected = trainImproved && holdoutDecayed;

  // Per-prompt divergences: group by persona, find pass→fail holdout paired
  // with fail→pass train.
  const byPersona = new Map();
  for (const p of perPromptPairs) {
    if (!byPersona.has(p.persona)) byPersona.set(p.persona, { holdoutRegressed: [], trainImproved: [] });
    const bucket = byPersona.get(p.persona);
    const prePass = p.scorePre && isPassingScore(p.scorePre);
    const postPass = p.scorePost && isPassingScore(p.scorePost);
    if (p.evaluation === 'holdout' && prePass && !postPass) {
      bucket.holdoutRegressed.push({ prompt: p.prompt, pre: 'pass', post: 'fail' });
    }
    if (p.evaluation === 'fixer' && !prePass && postPass) {
      bucket.trainImproved.push({ prompt: p.prompt, pre: 'fail', post: 'pass' });
    }
  }

  const divergences = [];
  for (const [persona, bucket] of byPersona.entries()) {
    if (bucket.holdoutRegressed.length > 0 && bucket.trainImproved.length > 0) {
      divergences.push({ persona, ...bucket });
    }
  }

  return {
    detected,
    trainDelta: Number(trainDelta.toFixed(4)),
    holdoutDelta: Number(holdoutDelta.toFixed(4)),
    threshold,
    divergences,
  };
}

// --- Baselines ---

export function saveBaseline(results, answererModel, config) {
  const dir = config.baselinesDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const savedPrompts = [];
  for (const r of results) {
    for (const q of r.prompts) {
      const lifecycle = q.promptObj?.lifecycle || null;
      const evaluation = q.promptObj?.evaluation || null;
      savedPrompts.push({
        persona: r.persona.id,
        lifecycle,
        evaluation,
        prompt: q.prompt,
        promptObj: q.promptObj || null,
        scorePre: q.scorePre || null,
        scorePost: q.scorePost || q.score || null,
        // `score` kept as alias for legacy consumers (isPassingScore, regression replay)
        score: q.scorePost || q.score || null,
      });
    }
  }

  const baseline = {
    version: 2,
    timestamp: new Date().toISOString(),
    answererModel: answererModel || 'default',
    prompts: savedPrompts,
  };

  const ts = baseline.timestamp.replace(/[:.]/g, '-').slice(0, 19);
  const path = join(dir, `baseline-${ts}.json`);
  writeFileSync(path, JSON.stringify(baseline, null, 2));
  return path;
}

export function loadBaseline(pathOrNull, config) {
  const raw = (() => {
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
  })();

  if (!raw) return null;
  return normalizeBaseline(raw);
}

/**
 * Normalize a baseline into v2 shape. v1 baselines (no `version`, prompts
 * have `score` + `group`) become v2: `score` → `scorePost`, `scorePre` = null,
 * `group` → `lifecycle`.
 */
function normalizeBaseline(raw) {
  if (raw.version === 2 && Array.isArray(raw.prompts)) return raw;

  const prompts = (raw.prompts || raw.questions || []).map(q => ({
    persona: q.persona,
    lifecycle: q.lifecycle || q.group || null,
    evaluation: q.evaluation || 'fixer',
    prompt: q.prompt || q.question,
    promptObj: q.promptObj || null,
    scorePre: q.scorePre || null,
    scorePost: q.scorePost || q.score || null,
    score: q.scorePost || q.score || null,
  }));

  return {
    version: 2,
    timestamp: raw.timestamp || null,
    answererModel: raw.answererModel || 'default',
    prompts,
  };
}

export function compareToBaseline(currentResults, baseline) {
  const report = { improved: [], regressed: [], unchanged: [], newPrompts: [] };

  const baselineMap = new Map();
  for (const bq of (baseline.prompts || baseline.questions || [])) {
    baselineMap.set(`${bq.persona}::${bq.prompt}`, bq.score);
  }

  for (const r of currentResults) {
    for (const q of r.prompts) {
      const key = `${r.persona.id}::${q.prompt}`;
      const oldScore = baselineMap.get(key);

      if (!oldScore) {
        report.newPrompts.push({ persona: r.persona.id, prompt: q.prompt, score: q.score });
        continue;
      }

      const wasGood = isPassingScore(oldScore);
      const isGood = isPassingScore(q.score);

      if (!wasGood && isGood) {
        report.improved.push({ persona: r.persona.id, prompt: q.prompt, oldScore, newScore: q.score });
      } else if (wasGood && !isGood) {
        report.regressed.push({ persona: r.persona.id, prompt: q.prompt, oldScore, newScore: q.score });
      } else {
        report.unchanged.push({ persona: r.persona.id, prompt: q.prompt });
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
      console.log(`    + "${r.prompt.slice(0, 70)}..." (${reason})`);
    }
  }

  if (report.regressed.length > 0) {
    console.log(`\n  REGRESSED (${report.regressed.length}):`);
    for (const r of report.regressed) {
      const reason = r.newScore.stuck ? 'completed -> stuck' : `${r.oldScore.errorsFound} errors -> ${r.newScore.errorsFound}`;
      console.log(`    ! "${r.prompt.slice(0, 70)}..." (${reason})`);
    }
  }

  if (report.unchanged.length > 0) {
    console.log(`\n  UNCHANGED: ${report.unchanged.length} prompts`);
  }

  if (report.newPrompts.length > 0) {
    console.log(`\n  NEW (not in baseline): ${report.newPrompts.length} prompts`);
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

export function checkDiversity(newPrompts, baseline) {
  const baselineItems = baseline ? (baseline.prompts || baseline.questions || []) : [];
  if (baselineItems.length === 0) {
    return { avgSimilarity: 0, lowDiversity: false, duplicates: [] };
  }

  const basePrompts = baselineItems.map(q => q.prompt);
  let totalSim = 0;
  let comparisons = 0;
  const duplicates = [];

  for (const nq of newPrompts) {
    for (const bq of basePrompts) {
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

// --- Distribution drift ---

function tokenFrequencyDistribution(prompts) {
  const freq = {};
  let total = 0;
  for (const q of prompts) {
    const tokens = q.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    for (const t of tokens) {
      freq[t] = (freq[t] || 0) + 1;
      total++;
    }
  }
  if (total > 0) for (const t in freq) freq[t] /= total;
  return freq;
}

export function computeDistributionDrift(newPrompts, referencePrompts, threshold = 0.4) {
  if (referencePrompts.length === 0) return { drift: 0, noveltyRatio: 0, highDrift: false, topNovelTokens: [] };

  const ref = tokenFrequencyDistribution(referencePrompts);
  const novel = tokenFrequencyDistribution(newPrompts);

  // Jensen-Shannon divergence (symmetric, bounded [0, 1])
  const allTokens = new Set([...Object.keys(ref), ...Object.keys(novel)]);
  let jsd = 0;
  for (const t of allTokens) {
    const p = ref[t] || 0;
    const q = novel[t] || 0;
    const m = (p + q) / 2;
    if (p > 0) jsd += 0.5 * p * Math.log2(p / m);
    if (q > 0) jsd += 0.5 * q * Math.log2(q / m);
  }

  const novelTokens = Object.keys(novel).filter(t => !ref[t]);
  const noveltyRatio = parseFloat((novelTokens.length / Math.max(Object.keys(novel).length, 1)).toFixed(3));

  return {
    drift: parseFloat(jsd.toFixed(4)),
    noveltyRatio,
    highDrift: jsd > threshold,
    topNovelTokens: novelTokens.slice(0, 10),
  };
}

export function getPreviousPrompts(personaId, config) {
  const baseline = loadBaseline(null, config);
  if (!baseline) return [];
  return (baseline.prompts || baseline.questions || [])
    .filter(q => q.persona === personaId)
    .map(q => q.prompt);
}

// --- Streak Detection ---

export function checkStreak(minStreak = 3, config) {
  const dir = config.baselinesDir;
  if (!existsSync(dir)) return { streak: 0, triggered: false, baselines: [], allPassingPrompts: [] };

  const files = readdirSync(dir)
    .filter(f => f.startsWith('baseline-') && f.endsWith('.json'))
    .sort()
    .reverse();

  let streak = 0;
  const streakBaselines = [];

  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      const baseline = normalizeBaseline(raw);
      const prompts = baseline.prompts || [];

      // Spec 2: only golden-lifecycle prompts count toward the streak.
      const goldens = prompts.filter(q => (q.lifecycle || q.group) === 'golden');

      // Empty golden → streak is 0. Do not count a run with no golden tier
      // toward the streak; otherwise the first few post-migration runs would
      // trivially "streak" on an empty set.
      if (goldens.length === 0) {
        break;
      }

      const allPassed = goldens.every(q => isPassingScore(q.scorePost || q.score));

      if (allPassed) {
        streak++;
        streakBaselines.push({ file, timestamp: baseline.timestamp, promptCount: goldens.length });
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
    allPassingPrompts: streakBaselines.length > 0
      ? files.slice(0, streak).flatMap(file => {
          try {
            const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
            const b = normalizeBaseline(raw);
            return (b.prompts || [])
              .filter(q => (q.lifecycle || q.group) === 'golden')
              .map(q => ({ persona: q.persona, prompt: q.prompt }));
          } catch { return []; }
        })
      : [],
  };
}

// --- Prompt Set (v2: golden only, ephemeral train per run) ---

export function loadPromptSet(config) {
  try {
    const raw = JSON.parse(readFileSync(config.promptSetPath, 'utf-8'));
    // Spec 2: reject any prompt-set whose entries lack `lifecycle`. V1 files
    // have `group: 'train'|'golden'` on each prompt and contaminated invariants;
    // they must not be silently interpreted as v2.
    if (raw && Array.isArray(raw.prompts) && raw.prompts.some(p => p && typeof p === 'object' && !p.lifecycle)) {
      throw new Error(
        `v1 prompt-set detected at ${config.promptSetPath}. Delete or archive it and run \`node bin/cli.mjs init -c <your-config>\`.`
      );
    }
    return raw;
  } catch (err) {
    // If the file doesn't exist, return null (legacy behavior).
    if (err && err.code === 'ENOENT') return null;
    // If the file is unparseable OR v1 rejection fired, re-throw so the
    // caller sees a clear error.
    if (err && err.message && /v1 prompt-set/.test(err.message)) throw err;
    return null;
  }
}

export function savePromptSet(ps, config) {
  writeFileSync(config.promptSetPath, JSON.stringify(ps, null, 2) + '\n');
}
