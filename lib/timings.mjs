/**
 * mcp-evolve — Append-only timings log.
 *
 * Every run writes JSON-line events to {dataDir}/timings.jsonl. Each line is a
 * self-contained event with a schema version, timestamp, run id, type, and
 * type-specific fields. The log is append-only and safe across parallel
 * processes — we rely on the POSIX guarantee that small write(2) calls under
 * PIPE_BUF bytes are atomic and that appendFileSync opens with O_APPEND.
 *
 * Event shapes (all carry `v`, `ts`, `run_id`, `type`):
 *   run_start       { project, total_runs?, current_run? }
 *   run_complete    { total_ms, prompts, errors, fixes }
 *   phase_start     { phase }
 *   phase_end       { phase, dur_ms }
 *   prompt_start    { persona, prompt, prompt_id }
 *   prompt_end      { persona, prompt_id, dur_ms, success, errors, tools_used?, tool_count? }
 *   tool_call       { tool, dur_ms }  (not currently emitted but schema-ready)
 *   fix_start       { error_tool }
 *   fix_end         { error_tool, dur_ms, success }
 *
 * Queries live in the `query` export — pure functions over an events array.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1;

// --- Path helpers ---

export function getTimingsPath(config) {
  const dir = config?.dataDir || '.mcp-evolve';
  return join(dir, 'timings.jsonl');
}

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
}

// --- Core write ---

/**
 * Append a single event to the timings log. Merges base fields (v, ts, run_id)
 * with caller-provided fields. Never throws — timings is non-critical.
 */
export function appendEvent(config, event) {
  try {
    const path = getTimingsPath(config);
    ensureDir(path);
    const line = JSON.stringify({
      v: SCHEMA_VERSION,
      ts: new Date().toISOString(),
      ...event,
    }) + '\n';
    // appendFileSync opens with O_APPEND on POSIX which gives atomic line
    // appends for small writes (< PIPE_BUF, typically 4096 bytes).
    appendFileSync(path, line, 'utf-8');
  } catch {
    // Timings are non-critical; swallow to avoid crashing the main loop.
  }
}

// --- Logger factory ---

/**
 * Create a bound logger for a given run. Every event it writes is tagged with
 * the same run_id so later analytics can group by run.
 */
export function createLogger(config, runId) {
  const run_id = runId || randomUUID();

  const emit = (type, fields = {}) => appendEvent(config, { run_id, type, ...fields });

  return {
    runId: run_id,
    emit,
    runStart: (fields = {}) => emit('run_start', fields),
    runComplete: (fields = {}) => emit('run_complete', fields),
    phaseStart: (phase) => emit('phase_start', { phase }),
    phaseEnd: (phase, dur_ms) => emit('phase_end', { phase, dur_ms }),
    promptStart: (fields) => emit('prompt_start', fields),
    promptEnd: (fields) => emit('prompt_end', fields),
    toolCall: (fields) => emit('tool_call', fields),
    fixStart: (fields) => emit('fix_start', fields),
    fixEnd: (fields) => emit('fix_end', fields),
  };
}

// --- Read / parse ---

/**
 * Load and parse every event from the timings log. Malformed lines and events
 * without a recognized schema version are skipped — we prefer to keep loading
 * rather than crash on historical/corrupt data.
 *
 * Options:
 *   path — override the default path (mainly for tests)
 *   sinceMs — only return events with ts >= now() - sinceMs
 */
export function loadTimings(config, opts = {}) {
  const path = opts.path || getTimingsPath(config);
  if (!existsSync(path)) return [];

  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }

  const events = [];
  const cutoff = opts.sinceMs ? Date.now() - opts.sinceMs : null;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    // Schema guard: skip events without a recognized version.
    if (!ev || typeof ev !== 'object') continue;
    if (typeof ev.v !== 'number') continue;
    if (ev.v > SCHEMA_VERSION) continue; // future data — skip defensively
    if (!ev.type) continue;
    if (cutoff) {
      const t = ev.ts ? Date.parse(ev.ts) : NaN;
      if (!Number.isFinite(t) || t < cutoff) continue;
    }
    events.push(ev);
  }
  return events;
}

// --- Queries ---

function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function matchesFilter(event, filter) {
  if (!filter) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (event[k] !== v) return false;
  }
  return true;
}

export const query = {
  /**
   * Average duration of a named phase across all completed phase_end events.
   * Optional filter narrows by arbitrary fields (e.g. { run_id: 'xyz' }).
   */
  avgPhaseMs(events, phase, filter) {
    const durs = events
      .filter(e => e.type === 'phase_end' && e.phase === phase && matchesFilter(e, filter))
      .map(e => e.dur_ms)
      .filter(n => Number.isFinite(n));
    return avg(durs);
  },

  /**
   * Average per-prompt duration. Optional filter may include persona, run_id, etc.
   * Example: query.avgPromptMs(events, { persona: 'owner' })
   */
  avgPromptMs(events, filter) {
    const durs = events
      .filter(e => e.type === 'prompt_end' && matchesFilter(e, filter))
      .map(e => e.dur_ms)
      .filter(n => Number.isFinite(n));
    return avg(durs);
  },

  /**
   * Durations of the last N completed runs, most-recent first.
   */
  lastRunDurations(events, n = 10) {
    const runs = events
      .filter(e => e.type === 'run_complete' && Number.isFinite(e.total_ms))
      .slice(-n)
      .reverse();
    return runs.map(e => e.total_ms);
  },

  /**
   * Count + total duration per tool, sorted by count descending.
   * Uses tool_call events. If your prompt_end includes a `tools_used` array,
   * counts are derived from those as well (without duration).
   */
  toolStats(events) {
    const stats = new Map();
    for (const e of events) {
      if (e.type === 'tool_call' && e.tool) {
        const s = stats.get(e.tool) || { tool: e.tool, count: 0, totalMs: 0 };
        s.count += 1;
        if (Number.isFinite(e.dur_ms)) s.totalMs += e.dur_ms;
        stats.set(e.tool, s);
      } else if (e.type === 'prompt_end' && Array.isArray(e.tools_used)) {
        for (const tool of e.tools_used) {
          const s = stats.get(tool) || { tool, count: 0, totalMs: 0 };
          s.count += 1;
          stats.set(tool, s);
        }
      }
    }
    return [...stats.values()].sort((a, b) => b.count - a.count);
  },

  /**
   * Slowest prompts by duration, top N.
   */
  slowestPrompts(events, n = 10) {
    return events
      .filter(e => e.type === 'prompt_end' && Number.isFinite(e.dur_ms))
      .slice()
      .sort((a, b) => b.dur_ms - a.dur_ms)
      .slice(0, n)
      .map(e => ({
        persona: e.persona,
        prompt: e.prompt,
        prompt_id: e.prompt_id,
        dur_ms: e.dur_ms,
        run_id: e.run_id,
      }));
  },

  /**
   * Group all phase_end events by phase name, returning average and count.
   */
  phaseBreakdown(events) {
    const phases = new Map();
    for (const e of events) {
      if (e.type !== 'phase_end' || !e.phase) continue;
      if (!Number.isFinite(e.dur_ms)) continue;
      const p = phases.get(e.phase) || { phase: e.phase, count: 0, totalMs: 0 };
      p.count += 1;
      p.totalMs += e.dur_ms;
      phases.set(e.phase, p);
    }
    return [...phases.values()]
      .map(p => ({ ...p, avgMs: p.totalMs / p.count }))
      .sort((a, b) => b.totalMs - a.totalMs);
  },

  /**
   * Average per-prompt duration grouped by persona.
   */
  promptByPersona(events) {
    const byPersona = new Map();
    for (const e of events) {
      if (e.type !== 'prompt_end' || !e.persona) continue;
      if (!Number.isFinite(e.dur_ms)) continue;
      const p = byPersona.get(e.persona) || { persona: e.persona, count: 0, totalMs: 0 };
      p.count += 1;
      p.totalMs += e.dur_ms;
      byPersona.set(e.persona, p);
    }
    return [...byPersona.values()]
      .map(p => ({ ...p, avgMs: p.totalMs / p.count }))
      .sort((a, b) => b.avgMs - a.avgMs);
  },

  /**
   * All events for a specific run, in file order.
   */
  eventsForRun(events, runId) {
    return events.filter(e => e.run_id === runId);
  },
};

// --- Convenience utilities ---

/** Generate a new run id (UUID v4 via node:crypto). */
export function newRunId() {
  return randomUUID();
}
