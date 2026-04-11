/**
 * mcp-evolve — Progress tracker with ETA estimation.
 *
 * Initial estimate: based on configured timeouts (× FRACTION_OF_TIMEOUT).
 * Refined estimate: rolling average of actual operation durations, plus
 * historical data pulled from {dataDir}/timings.jsonl when available.
 *
 * Persistence is delegated to `lib/timings.mjs` — we emit phase_start /
 * phase_end / prompt_start / prompt_end / run_complete events to the
 * append-only log. The in-memory state exists only for the live progress
 * display and ETA.
 */

import { createLogger, loadTimings, query, newRunId } from './timings.mjs';
import { randomUUID } from 'node:crypto';

// Typical execution time as a fraction of the max timeout. Tunable.
const FRACTION_OF_TIMEOUT = 0.35;
const ROLLING_WINDOW = 5;

// How far back we look in the timings log for refined estimates (6h matches
// the old progress.json session window so behaviour is consistent).
const HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;

// --- Initial estimates from configured timeouts ---

function estimatePrefetchMs(config) {
  return (config.prefetchTimeout || 60_000) * FRACTION_OF_TIMEOUT;
}

function estimateGenerationMs(config, personaCount) {
  // Generation runs in parallel per persona — assume linear scaling above 5 personas
  return (config.promptTimeout || 600_000) * FRACTION_OF_TIMEOUT * Math.max(1, personaCount / 5);
}

function estimatePerPromptMs(config) {
  const probeBefore = config.probeTimeout || 60_000;
  const answer = config.answererTimeout || 180_000;
  const probeAfter = config.probeTimeout || 60_000;
  const grade = config.graderTimeout || 60_000;
  return (probeBefore + answer + probeAfter + grade) * FRACTION_OF_TIMEOUT;
}

// --- Historical refinement from timings.jsonl ---

function loadHistoricalRefinements(config) {
  try {
    const events = loadTimings(config, { sinceMs: HISTORY_WINDOW_MS });
    if (events.length === 0) return { refined: {}, runHistory: [] };

    const refined = {};
    const prefetchAvg = query.avgPhaseMs(events, 'prefetch');
    const generationAvg = query.avgPhaseMs(events, 'generation');
    const promptAvg = query.avgPromptMs(events);

    if (prefetchAvg > 0) refined.prefetchMs = prefetchAvg;
    if (generationAvg > 0) refined.generationMs = generationAvg;
    if (promptAvg > 0) refined.perPromptMs = promptAvg;

    const runHistory = events
      .filter(e => e.type === 'run_complete' && Number.isFinite(e.total_ms))
      .map(e => ({
        run_id: e.run_id,
        durMs: e.total_ms,
        promptCount: e.prompts || 0,
        completedAt: e.ts,
      }));

    return { refined, runHistory };
  } catch {
    return { refined: {}, runHistory: [] };
  }
}

// --- State management ---

export function createProgress(config, opts = {}) {
  const totalPrompts = opts.totalPrompts || 0;
  const personaCount = opts.personaCount || 0;
  const currentRun = opts.currentRun || 1;
  const totalRuns = opts.totalRuns || 1;

  const initial = {
    prefetchMs: estimatePrefetchMs(config),
    generationMs: personaCount > 0 ? estimateGenerationMs(config, personaCount) : 0,
    perPromptMs: estimatePerPromptMs(config),
  };

  // Pull recent history from timings.jsonl to seed refined estimates.
  const historical = loadHistoricalRefinements(config);

  // Generate a fresh run id and create a logger bound to it.
  const runId = newRunId();
  let logger = null;
  try { logger = createLogger(config, runId); } catch { /* non-critical */ }

  const progress = {
    config,
    runId,
    logger,
    totalPrompts,
    personaCount,
    currentRun,
    totalRuns,
    currentPrompt: 0,
    startedAt: Date.now(),

    // Initial (timeout-based) estimates
    initial,

    // Refined estimates — start with initial, overlay historical, mutate as we go
    refined: { ...initial, ...historical.refined },

    // Per-phase actual timings for current run
    actualPhases: {
      prefetch: null,
      generation: null,
      prompts: [],     // array of {name, durMs, ts}
      fix: null,
      review: null,
      escalate: null,
    },

    // Per-run history (durations of completed runs from recent log)
    runHistory: historical.runHistory,

    // Current phase tracking
    phase: 'init',
    phaseStartedAt: Date.now(),
    currentPromptStartedAt: null,
    currentPromptName: null,
    currentPromptId: null,
    currentPromptPersona: null,

    // Aggregate counters for run_complete event
    errorCount: 0,
    fixCount: 0,
  };

  // Emit run_start so analytics can see when runs begin even if they crash.
  try {
    logger?.runStart({
      project: config?.dataDir || null,
      current_run: currentRun,
      total_runs: totalRuns,
      total_prompts: totalPrompts,
      persona_count: personaCount,
    });
  } catch { /* non-critical */ }

  return progress;
}

// --- Phase tracking ---

/**
 * Mark the end of the current phase (if any) and the start of `phase`.
 * Emits phase_end (for the previous phase) and phase_start (for the new one).
 * Passing `null` / `undefined` closes the current phase without opening a new one.
 */
export function setPhase(progress, phase) {
  if (!progress) return;
  // Close the previous phase
  if (progress.phase && progress.phase !== 'init') {
    const dur = Date.now() - progress.phaseStartedAt;
    const prev = progress.phase;

    // Legacy in-memory buckets (kept for the live display)
    if (prev === 'prefetch') progress.actualPhases.prefetch = dur;
    else if (prev === 'generation') progress.actualPhases.generation = dur;
    else if (prev === 'fix' || prev === 'fix_batch') progress.actualPhases.fix = dur;
    else if (prev === 'review' || prev === 'reviewer') progress.actualPhases.review = dur;
    else if (prev === 'escalate') progress.actualPhases.escalate = dur;

    try { progress.logger?.phaseEnd(prev, dur); } catch { /* non-critical */ }
    refineEstimates(progress);
  }

  progress.phase = phase || 'idle';
  progress.phaseStartedAt = Date.now();

  if (phase && phase !== 'idle') {
    try { progress.logger?.phaseStart(phase); } catch { /* non-critical */ }
  }
}

export function startPrompt(progress, name, opts = {}) {
  if (!progress) return;
  progress.currentPromptStartedAt = Date.now();
  progress.currentPromptName = name;
  progress.currentPromptId = opts.promptId || randomUUID();
  progress.currentPromptPersona = opts.persona || null;

  try {
    progress.logger?.promptStart({
      persona: progress.currentPromptPersona,
      prompt: name,
      prompt_id: progress.currentPromptId,
    });
  } catch { /* non-critical */ }
}

export function completePrompt(progress, opts = {}) {
  if (!progress) return;
  if (progress.currentPromptStartedAt) {
    const dur = Date.now() - progress.currentPromptStartedAt;
    progress.actualPhases.prompts.push({
      name: progress.currentPromptName,
      durMs: dur,
      ts: Date.now(),
    });

    try {
      progress.logger?.promptEnd({
        persona: progress.currentPromptPersona,
        prompt_id: progress.currentPromptId,
        dur_ms: dur,
        success: opts.success !== false,
        errors: opts.errors || 0,
        tools_used: opts.toolsUsed || undefined,
        tool_count: opts.toolCount || undefined,
      });
    } catch { /* non-critical */ }

    if (opts.errors) progress.errorCount += opts.errors;

    progress.currentPromptStartedAt = null;
    progress.currentPromptName = null;
    progress.currentPromptId = null;
    progress.currentPromptPersona = null;
    refineEstimates(progress);
  }
  progress.currentPrompt++;
}

/**
 * Record a one-shot "sub-phase" timing without touching the main progress
 * phase state. Use for concurrent phases (e.g. per-persona generation) where
 * normal setPhase would interleave. Returns `end()` which emits a phase_end
 * event with the measured duration.
 *
 * Usage:
 *   const end = progress.recordSubPhase(prog, 'generation');
 *   try { ... } finally { end(); }
 */
export function recordSubPhase(progress, phase) {
  if (!progress) return () => {};
  const startedAt = Date.now();
  try { progress.logger?.phaseStart(phase); } catch { /* non-critical */ }
  return () => {
    try { progress.logger?.phaseEnd(phase, Date.now() - startedAt); } catch { /* non-critical */ }
  };
}

/**
 * Emit a fix_start / fix_end pair around a named error_tool fix. Returns an
 * `end(success)` callback that the caller invokes when the fix finishes.
 */
export function startFix(progress, errorTool) {
  if (!progress) return () => {};
  const startedAt = Date.now();
  try { progress.logger?.fixStart({ error_tool: errorTool }); } catch { /* non-critical */ }
  return (success = true) => {
    try {
      progress.logger?.fixEnd({
        error_tool: errorTool,
        dur_ms: Date.now() - startedAt,
        success: !!success,
      });
    } catch { /* non-critical */ }
    if (success) progress.fixCount += 1;
  };
}

function refineEstimates(progress) {
  // Use actual phase timings if we have them, else keep initial
  if (progress.actualPhases.prefetch) progress.refined.prefetchMs = progress.actualPhases.prefetch;
  if (progress.actualPhases.generation) progress.refined.generationMs = progress.actualPhases.generation;

  // Per-prompt: rolling average of last N
  const recentPrompts = progress.actualPhases.prompts.slice(-ROLLING_WINDOW);
  if (recentPrompts.length > 0) {
    const avgMs = recentPrompts.reduce((sum, p) => sum + p.durMs, 0) / recentPrompts.length;
    progress.refined.perPromptMs = avgMs;
  }
}

// --- Run lifecycle ---

export function completeRun(progress) {
  if (!progress) return;
  // Close any open phase first
  if (progress.phase && progress.phase !== 'init' && progress.phase !== 'idle') {
    setPhase(progress, 'idle');
  }

  const runDurMs = Date.now() - progress.startedAt;
  progress.runHistory.push({
    run_id: progress.runId,
    durMs: runDurMs,
    promptCount: progress.currentPrompt,
    completedAt: new Date().toISOString(),
  });

  try {
    progress.logger?.runComplete({
      total_ms: runDurMs,
      prompts: progress.currentPrompt,
      errors: progress.errorCount,
      fixes: progress.fixCount,
      current_run: progress.currentRun,
      total_runs: progress.totalRuns,
    });
  } catch { /* non-critical */ }
}

// --- ETA calculation ---

export function getEtaMs(progress) {
  if (!progress) return 0;

  // Remaining work in current run
  const remainingPrompts = Math.max(0, progress.totalPrompts - progress.currentPrompt);
  const currentRunRemaining = remainingPrompts * progress.refined.perPromptMs;

  // Add fix/review/escalate phases if we haven't done them yet (rough estimates)
  let phasePadding = 0;
  if (progress.phase !== 'fix' && progress.phase !== 'fix_batch' &&
      progress.phase !== 'review' && progress.phase !== 'reviewer' &&
      progress.phase !== 'escalate') {
    phasePadding = (progress.config.fixerTimeout || 300_000) * FRACTION_OF_TIMEOUT * 0.3; // 30% chance of fixing
  }

  // Remaining whole runs after this one
  const wholeRunsRemaining = Math.max(0, progress.totalRuns - progress.currentRun);
  const avgRunMs = computeAvgRunMs(progress);
  const futureRunsMs = wholeRunsRemaining * avgRunMs;

  return currentRunRemaining + phasePadding + futureRunsMs;
}

function computeAvgRunMs(progress) {
  // Use actual completed runs first
  if (progress.runHistory.length > 0) {
    return progress.runHistory.reduce((sum, r) => sum + r.durMs, 0) / progress.runHistory.length;
  }
  // Else estimate from current refined timings
  return (
    progress.refined.prefetchMs +
    progress.refined.generationMs +
    progress.refined.perPromptMs * progress.totalPrompts
  );
}

export function getElapsedMs(progress) {
  if (!progress) return 0;
  return Date.now() - progress.startedAt;
}

export function getSessionElapsedMs(progress) {
  if (!progress) return 0;
  // Session elapsed = earliest run_history entry to now, else same as run elapsed.
  if (progress.runHistory.length === 0) return getElapsedMs(progress);
  const earliest = Math.min(...progress.runHistory.map(r => {
    const t = Date.parse(r.completedAt);
    return Number.isFinite(t) ? t - r.durMs : Date.now();
  }));
  return Date.now() - earliest;
}

// --- Formatting ---

export function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return `${totalMin}m${sec.toString().padStart(2, '0')}s`;
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${hours}h${min.toString().padStart(2, '0')}m`;
}

function renderBar(pct, width) {
  const filled = Math.round((pct / 100) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

export function formatProgress(progress) {
  if (!progress) return '';
  const pct = progress.totalPrompts > 0
    ? Math.round((progress.currentPrompt / progress.totalPrompts) * 100)
    : 0;
  const bar = renderBar(pct, 20);
  const elapsed = formatDuration(getElapsedMs(progress));
  const eta = formatDuration(getEtaMs(progress));

  const isRefined = progress.actualPhases.prompts.length > 0;
  const avgLabel = isRefined ? 'avg' : 'est';
  const perPrompt = `${avgLabel} ${formatDuration(progress.refined.perPromptMs)}/prompt`;

  const runInfo = progress.totalRuns > 1
    ? `Run ${progress.currentRun}/${progress.totalRuns} | `
    : '';

  return `${runInfo}${bar} ${progress.currentPrompt}/${progress.totalPrompts} (${pct}%) | elapsed ${elapsed} | ETA ${eta} | ${perPrompt}`;
}

export function formatInitialEstimate(progress) {
  if (!progress) return '';
  const lines = [];
  lines.push(`Initial estimates (from configured timeouts × ${FRACTION_OF_TIMEOUT}):`);
  lines.push(`  prefetch:    ${formatDuration(progress.initial.prefetchMs)}`);
  if (progress.initial.generationMs > 0) {
    lines.push(`  generation:  ${formatDuration(progress.initial.generationMs)}`);
  }
  lines.push(`  per prompt:  ${formatDuration(progress.initial.perPromptMs)} × ${progress.totalPrompts} = ${formatDuration(progress.initial.perPromptMs * progress.totalPrompts)}`);

  const totalRunMs = progress.initial.prefetchMs + progress.initial.generationMs + progress.initial.perPromptMs * progress.totalPrompts;
  lines.push(`  one run:     ~${formatDuration(totalRunMs)}`);

  if (progress.totalRuns > 1) {
    lines.push(`  ${progress.totalRuns} runs:    ~${formatDuration(totalRunMs * progress.totalRuns)}`);
  }
  return lines.join('\n');
}

export function formatRunSummary(progress) {
  if (!progress) return '';
  const lines = [];
  const dur = formatDuration(getElapsedMs(progress));
  lines.push(`Run ${progress.currentRun}/${progress.totalRuns} complete in ${dur}`);

  const phases = progress.actualPhases;
  if (phases.prefetch) lines.push(`  prefetch:   ${formatDuration(phases.prefetch)}`);
  if (phases.generation) lines.push(`  generation: ${formatDuration(phases.generation)}`);
  if (phases.prompts.length > 0) {
    const totalPromptMs = phases.prompts.reduce((s, p) => s + p.durMs, 0);
    const avgMs = totalPromptMs / phases.prompts.length;
    lines.push(`  prompts:    ${formatDuration(totalPromptMs)} (${phases.prompts.length} × avg ${formatDuration(avgMs)})`);
  }
  if (phases.fix) lines.push(`  fix:        ${formatDuration(phases.fix)}`);
  if (phases.review) lines.push(`  review:     ${formatDuration(phases.review)}`);
  if (phases.escalate) lines.push(`  escalate:   ${formatDuration(phases.escalate)}`);

  if (progress.runHistory.length > 0 && progress.currentRun < progress.totalRuns) {
    const remaining = progress.totalRuns - progress.currentRun;
    const avgRunMs = computeAvgRunMs(progress);
    lines.push(`Remaining: ${remaining} run(s) × ~${formatDuration(avgRunMs)} = ${formatDuration(remaining * avgRunMs)}`);
  }
  return lines.join('\n');
}
