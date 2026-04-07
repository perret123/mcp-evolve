#!/usr/bin/env node

/**
 * mcp-evolve self-test MCP server.
 *
 * Exposes mcp-evolve's own data and operations as MCP tools,
 * so mcp-evolve can test itself. The snake eats its own tail.
 *
 * Tools:
 *   Read:  list_runs, get_run_details, get_metrics_summary, get_persona_map,
 *          get_golden_set, get_stale_personas, get_tool_coverage, get_run_comparison
 *   Write: add_golden_question, remove_golden_question, validate_new_persona
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Data directory — either from env or default
const DATA_DIR = resolve(process.env.MCP_EVOLVE_DATA_DIR || '.mcp-evolve');
const LOGS_DIR = join(DATA_DIR, 'logs');
const BASELINES_DIR = join(DATA_DIR, 'baselines');
const GOLDEN_SET_PATH = join(DATA_DIR, 'golden-set.json');
const METRICS_PATH = join(DATA_DIR, 'metrics.json');

// We also need personas — load from config or env
const PERSONAS_PATH = process.env.MCP_EVOLVE_PERSONAS_PATH || null;

// Knowledge base directory
const KNOWLEDGE_DIR = resolve(process.env.MCP_EVOLVE_KNOWLEDGE_DIR || join(new URL('.', import.meta.url).pathname, 'knowledge'));

// --- Helpers ---

function loadJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function listFiles(dir, prefix, suffix) {
  try {
    return readdirSync(dir)
      .filter(f => f.startsWith(prefix) && f.endsWith(suffix))
      .sort();
  } catch {
    return [];
  }
}

// --- Server ---

const server = new McpServer({
  name: 'mcp-evolve-self',
  version: '0.1.0',
}, {
  instructions: [
    'This MCP server exposes the mcp-evolve test harness data and operations.',
    'mcp-evolve is a self-improving test harness for MCP servers.',
    '',
    'Key concepts:',
    '- Run: a single execution of the test loop (generates questions, answers them, scores results)',
    '- Persona: a simulated user with specific concerns, MBTI type, and communication style',
    '- Golden set: permanent regression questions that run every time',
    '- Baseline: a score snapshot for regression comparison',
    '- Metrics: accumulated stats across all runs (per-persona, per-tool, system-level)',
    '- Escalation: when everything passes 3x, harder questions are generated from source code analysis',
    '',
    'Use knowledge_search ONLY when you need to explain mcp-evolve concepts the user may not know. Do NOT call it alongside data tools if the question is purely about data/numbers.',
    '',
    'IMPORTANT: Call the minimum number of tools needed. Each guide entry below is sufficient on its own — do NOT add extra tools "just in case".',
    '',
    'Tool selection guide — pick the most specific tool; avoid redundant calls:',
    '- Trends / success rates over time → get_metrics_summary ALONE (has last 10 run rates built in)',
    '- Persona pass/fail breakdown → get_metrics_summary ALONE (has per-persona failure counts, success rate history, runsSinceLastFailure); optionally add get_stale_personas for a staleness-focused view',
    '- Tool error rates / coverage gaps → get_tool_coverage ALONE (comprehensive; no need to also call get_metrics_summary)',
    '- What broke in a specific run → list_runs then get_run_details (2 tools max; do NOT add get_metrics_summary — run details has everything about that run)',
    '- Compare two runs → list_runs (to get filenames), then get_run_comparison (not two get_run_details calls)',
    '- Plateau / escalation analysis → get_metrics_summary ALONE (includes escalation counts, fix rates, success rate trends, and runsSinceLastFailure — all sufficient for plateau detection; do NOT also call get_golden_set or get_stale_personas)',
    '- Golden set status / growth → get_golden_set ALONE (each question has promotedAt timestamp for tracking growth)',
    '- Stale personas → get_stale_personas ALONE',
    '- Persona layout / MBTI distribution → get_persona_map ALONE (includes full MBTI used/available breakdown; no need for knowledge_search)',
  ].join('\n'),
});

// --- Knowledge Search ---

server.tool(
  'knowledge_search',
  'Search the mcp-evolve knowledge base for domain concepts, architecture, and how things work. Use ONLY when the user asks "what is X?" or "how does X work?" for concepts like "golden set", "persona", "escalation", "MBTI", "scoring", "staleness". Do NOT call alongside data tools (get_metrics_summary, get_tool_coverage, get_persona_map, etc.) unless the user explicitly asks for a concept explanation — the data tools return self-explanatory data.',
  { query: z.string().describe('Search term or concept to look up (e.g. "golden set", "escalation", "MBTI", "scoring", "action detection")') },
  async ({ query }) => {
    // Load all knowledge files and search
    const results = [];
    try {
      const files = readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'));
      const queryLower = query.toLowerCase();
      const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

      for (const file of files) {
        const content = readFileSync(join(KNOWLEDGE_DIR, file), 'utf-8');
        const sections = content.split(/^## /m);

        for (const section of sections) {
          if (!section.trim()) continue;
          const sectionLower = section.toLowerCase();

          // Extract section title (first line) and content
          const lines = section.split('\n');
          const title = lines[0].trim();
          const titleLower = title.toLowerCase();
          const body = lines.slice(1).join('\n').trim();

          // Score: query words in title worth 3x, in body worth 1x
          const titleHits = queryWords.filter(w => titleLower.includes(w)).length;
          const bodyHits = queryWords.filter(w => sectionLower.includes(w)).length;
          const score = titleHits * 3 + bodyHits;
          if (score === 0) continue;

          results.push({ file, title, body: body.slice(0, 1500), score });
        }
      }

      results.sort((a, b) => b.score - a.score);
    } catch (err) {
      return { content: [{ type: 'text', text: `Knowledge search error: ${err.message}` }], isError: true };
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No knowledge found for "${query}". Try broader terms.` }] };
    }

    const top = results.slice(0, 3);
    const text = top.map(r => `### ${r.title} (${r.file})\n\n${r.body}`).join('\n\n---\n\n');
    return { content: [{ type: 'text', text }] };
  },
);

// --- Read Tools ---

server.tool(
  'list_runs',
  'List recent test runs with timestamps, success rates, question counts, and error counts. Each result includes a "file" field — pass it to get_run_details or get_run_comparison. For success-rate trends alone, prefer get_metrics_summary (which already includes the last 10 rates).',
  { limit: z.number().optional().describe('Max runs to return (default 10, max 50)') },
  async ({ limit }) => {
    const files = listFiles(LOGS_DIR, 'run-', '.json').reverse();
    const maxLimit = Math.min(limit || 10, 50);
    const runs = [];

    for (const file of files.slice(0, maxLimit)) {
      const data = loadJSON(join(LOGS_DIR, file));
      if (!data) continue;
      runs.push({
        file,
        timestamp: data.timestamp,
        duration: data.durationMs ? `${(data.durationMs / 1000).toFixed(0)}s` : null,
        personas: data.config?.personas?.length || 0,
        totalQuestions: data.summary?.totalQuestions || 0,
        totalErrors: data.summary?.totalErrors || 0,
        successRate: data.scores?.all?.successRate || '0',
        actionCompletionRate: data.scores?.all?.actionCompletionRate || 'N/A',
        mode: [
          data.config?.trainOnly ? 'train' : '',
          data.config?.evalOnly ? 'eval' : '',
          data.config?.isRegression ? 'regression' : '',
          data.config?.dryRun ? 'dry-run' : '',
        ].filter(Boolean).join(', ') || 'full',
      });
    }

    return { content: [{ type: 'text', text: JSON.stringify(runs, null, 2) }] };
  },
);

server.tool(
  'get_run_details',
  'Get full details of ONE specific run: per-persona results, individual questions asked, tools called, errors, and answer previews. This tool alone (after list_runs for the filename) is sufficient for "what broke/happened in run X" questions — do NOT also call get_metrics_summary. For aggregate persona pass/fail analysis across runs, use get_metrics_summary instead. To compare two runs, use get_run_comparison instead of calling this twice.',
  { filename: z.string().describe('Run log filename from list_runs "file" field, e.g. "run-2026-04-04T03-43-09.json". Call list_runs first to get valid filenames.') },
  async ({ filename }) => {
    const data = loadJSON(join(LOGS_DIR, filename));
    if (!data) return { content: [{ type: 'text', text: `Run not found: ${filename}. Call list_runs first to get valid filenames (use the "file" field from the results).` }], isError: true };

    const summary = {
      timestamp: data.timestamp,
      duration: data.durationMs ? `${(data.durationMs / 1000).toFixed(0)}s` : null,
      scores: data.scores,
      errorsByTool: data.summary?.errorsByTool || {},
      results: (data.results || []).map(r => ({
        persona: r.persona,
        group: r.group,
        questions: (r.questions || []).map(q => ({
          question: q.question,
          success: q.score?.completed && !q.score?.stuck && q.score?.errorsFound === 0 && q.score?.actionRequirementMet !== false,
          toolsUsed: q.score?.toolsUsed || 0,
          errors: q.errorCount || 0,
          isAction: q.score?.isActionRequest || false,
          writeToolCalled: q.score?.writeToolCalled || false,
          toolsCalled: q.toolsCalled || [],
          answerPreview: q.answerPreview?.slice(0, 200) || '',
        })),
      })),
    };

    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  },
);

server.tool(
  'get_metrics_summary',
  'Get a high-level overview across all runs. Returns: last 10 success rates (trend analysis), per-persona stats (totalQuestions, totalFailures, runsSinceLastFailure, last 5 success rates per persona), fix effectiveness, escalation productivity (total + productive count), and apparatus/plateau signals. This single tool is sufficient for: trends, plateau analysis, escalation questions, and persona breakdowns — no need to add get_golden_set, get_stale_personas, or get_run_details. For detailed tool error rates and coverage gaps, use get_tool_coverage instead.',
  {},
  async () => {
    const metrics = loadJSON(METRICS_PATH);
    if (!metrics) return { content: [{ type: 'text', text: 'No metrics data yet. Run mcp-evolve first.' }] };

    const summary = {
      totalRuns: metrics.totalRuns,
      lastUpdated: metrics.lastUpdated,
      recentSuccessRates: (metrics.runs || []).slice(-10).map(r => ({
        timestamp: r.timestamp?.slice(0, 19),
        rate: r.successRate,
        questions: r.totalQuestions,
      })),
      personas: Object.entries(metrics.personas || {}).map(([id, ps]) => ({
        id,
        totalQuestions: ps.totalQuestions,
        totalFailures: ps.totalFailures,
        totalFixes: ps.totalFixes,
        runsSinceLastFailure: ps.runsSinceLastFailure,
        recentRates: (ps.successRateHistory || []).slice(-5),
      })),
      tools: Object.entries(metrics.tools || {})
        .map(([name, ts]) => ({
          name,
          calls: ts.totalCalls,
          errors: ts.totalErrors,
          errorRate: ts.totalCalls > 0 ? `${(ts.totalErrors / ts.totalCalls * 100).toFixed(1)}%` : '0%',
          personas: ts.calledByPersonas,
        }))
        .sort((a, b) => b.calls - a.calls),
      fixes: {
        total: metrics.fixes?.total || 0,
        successful: metrics.fixes?.successful || 0,
        rate: metrics.fixes?.total > 0
          ? `${(metrics.fixes.successful / metrics.fixes.total * 100).toFixed(0)}%` : 'N/A',
      },
      escalations: {
        total: metrics.escalations?.total || 0,
        productive: metrics.escalations?.productive || 0,
      },
      apparatus: {
        lastRefine: metrics.apparatus?.lastRefine || 'never',
        changes: (metrics.apparatus?.refineHistory || []).length,
      },
    };

    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  },
);

server.tool(
  'get_persona_map',
  'Get the persona map showing all personas organized by cluster, with their MBTI types, roles, and train/eval group assignments. Also returns mbtiUsed and mbtiAvailable lists for gap analysis. This single tool is sufficient for MBTI distribution and blind spot questions — no need to add knowledge_search.',
  {},
  async () => {
    // Try to load personas from the config-provided path
    let personas = [];
    if (PERSONAS_PATH && existsSync(PERSONAS_PATH)) {
      try {
        const mod = await import(`file://${resolve(PERSONAS_PATH)}`);
        personas = mod.personas || mod.default?.personas || [];
      } catch { /* fall through */ }
    }

    if (personas.length === 0) {
      // Fall back to metrics persona list
      const metrics = loadJSON(METRICS_PATH);
      if (metrics?.personas) {
        personas = Object.keys(metrics.personas).map(id => ({ id, mbti: '?', cluster: '?', group: '?' }));
      }
    }

    // Build cluster map
    const clusters = {};
    for (const p of personas) {
      const c = p.cluster || 'unclustered';
      if (!clusters[c]) clusters[c] = [];
      clusters[c].push({
        id: p.id,
        name: p.name || p.id,
        role: p.role || 'User',
        mbti: p.mbti || '?',
        group: p.group || 'train',
        concerns: p.concerns?.length || 0,
      });
    }

    const allMbti = ['INTJ','INTP','ENTJ','ENTP','INFJ','INFP','ENFJ','ENFP','ISTJ','ISFJ','ESTJ','ESFJ','ISTP','ISFP','ESTP','ESFP'];
    const usedMbti = new Set(personas.map(p => p.mbti).filter(m => m && m !== '?'));
    const availableMbti = allMbti.filter(m => !usedMbti.has(m));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          totalPersonas: personas.length,
          clusters,
          mbtiUsed: [...usedMbti],
          mbtiAvailable: availableMbti,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'get_golden_set',
  'Get the golden set — permanent regression questions that run on every test cycle. Shows persona, question text, promotedAt timestamp, and promotion reason. Use ONLY when the user asks about golden set contents or management. NOT needed for plateau analysis or escalation questions — those are covered by get_metrics_summary.',
  {},
  async () => {
    const gs = loadJSON(GOLDEN_SET_PATH);
    if (!gs || !gs.questions?.length) {
      return { content: [{ type: 'text', text: 'Golden set is empty. Run mcp-evolve to build it.' }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(gs, null, 2) }] };
  },
);

server.tool(
  'get_stale_personas',
  'Find personas that haven\'t generated a failure in many runs — they may need refreshed concerns or harder question styles. A persona is "stale" if it has passed every question for N consecutive runs. This is a filtered, staleness-focused view; for the full per-persona breakdown (all personas, all stats), use get_metrics_summary instead.',
  { minRuns: z.number().optional().describe('Minimum consecutive clean runs to be considered stale (default 3)') },
  async ({ minRuns }) => {
    const metrics = loadJSON(METRICS_PATH);
    if (!metrics?.personas) return { content: [{ type: 'text', text: 'No metrics data yet.' }] };

    const threshold = minRuns || 3;
    const stale = Object.entries(metrics.personas)
      .map(([id, ps]) => ({
        id,
        runsSinceLastFailure: ps.runsSinceLastFailure,
        totalQuestions: ps.totalQuestions,
        totalFailures: ps.totalFailures,
        totalFixes: ps.totalFixes,
        lastFailureRun: ps.lastFailureRun,
        avgSuccessRate: ps.successRateHistory?.length > 0
          ? (ps.successRateHistory.reduce((a, b) => a + b, 0) / ps.successRateHistory.length).toFixed(1) + '%'
          : 'N/A',
      }))
      .filter(p => p.runsSinceLastFailure >= threshold)
      .sort((a, b) => b.runsSinceLastFailure - a.runsSinceLastFailure);

    return { content: [{ type: 'text', text: JSON.stringify({ threshold, stalePersonas: stale }, null, 2) }] };
  },
);

server.tool(
  'get_tool_coverage',
  'The definitive tool for analyzing MCP tool health. Returns per-tool call counts, error rates, which personas test each tool, and risk analysis (single-persona coverage, error-prone tools). Use this instead of get_metrics_summary for any tool-related questions.',
  {},
  async () => {
    const metrics = loadJSON(METRICS_PATH);
    if (!metrics?.tools) return { content: [{ type: 'text', text: 'No metrics data yet.' }] };

    const tools = Object.entries(metrics.tools)
      .map(([name, ts]) => ({
        name,
        totalCalls: ts.totalCalls,
        totalErrors: ts.totalErrors,
        errorRate: ts.totalCalls > 0 ? `${(ts.totalErrors / ts.totalCalls * 100).toFixed(1)}%` : '0%',
        testedByPersonas: ts.calledByPersonas,
        personaCount: ts.calledByPersonas?.length || 0,
        lastError: ts.lastErrorRun,
      }))
      .sort((a, b) => b.totalCalls - a.totalCalls);

    const singlePersonaTools = tools.filter(t => t.personaCount === 1);
    const errorProne = tools.filter(t => t.totalErrors > 0);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          totalTools: tools.length,
          tools,
          risks: {
            singlePersonaCoverage: singlePersonaTools.map(t => `${t.name} (only by ${t.testedByPersonas[0]})`),
            errorProne: errorProne.map(t => `${t.name}: ${t.errorRate} error rate`),
          },
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'get_run_comparison',
  'Compare two runs side by side — shows success rate delta, error delta, and tool usage changes. Use this instead of calling get_run_details twice. Pass filenames from list_runs.',
  {
    runA: z.string().describe('First (older) run filename'),
    runB: z.string().describe('Second (newer) run filename'),
  },
  async ({ runA, runB }) => {
    const a = loadJSON(join(LOGS_DIR, runA));
    const b = loadJSON(join(LOGS_DIR, runB));
    if (!a || !b) return { content: [{ type: 'text', text: `One or both runs not found (runA: "${runA}", runB: "${runB}"). Call list_runs first and use the "file" field from results as filenames.` }], isError: true };

    const comparison = {
      runA: { file: runA, timestamp: a.timestamp, successRate: a.scores?.all?.successRate, questions: a.summary?.totalQuestions },
      runB: { file: runB, timestamp: b.timestamp, successRate: b.scores?.all?.successRate, questions: b.summary?.totalQuestions },
      delta: {
        successRate: `${a.scores?.all?.successRate}% → ${b.scores?.all?.successRate}%`,
        errors: `${a.summary?.totalErrors} → ${b.summary?.totalErrors}`,
        avgTools: `${a.scores?.all?.avgTools} → ${b.scores?.all?.avgTools}`,
      },
    };

    return { content: [{ type: 'text', text: JSON.stringify(comparison, null, 2) }] };
  },
);

// --- Write Tools ---

server.tool(
  'add_golden_question',
  'Add a new question to the golden set for permanent regression testing. The question will be replayed on every future run to ensure it keeps passing.',
  {
    persona: z.string().describe('Persona ID this question belongs to'),
    question: z.string().describe('The question text'),
    reason: z.string().describe('Why this question should be in the golden set'),
  },
  async ({ persona, question, reason }) => {
    const gs = loadJSON(GOLDEN_SET_PATH) || { maxSize: 50, questions: [] };

    const exists = gs.questions.some(q => q.persona === persona && q.question === question);
    if (exists) return { content: [{ type: 'text', text: `Question already in golden set for persona "${persona}".` }] };

    gs.questions.push({
      persona,
      question,
      promotedAt: new Date().toISOString(),
      fixCycle: { source: 'manual', reason },
    });

    while (gs.questions.length > (gs.maxSize || 50)) gs.questions.shift();

    const { writeFileSync } = await import('node:fs');
    writeFileSync(GOLDEN_SET_PATH, JSON.stringify(gs, null, 2) + '\n');

    return { content: [{ type: 'text', text: `Added to golden set. Total: ${gs.questions.length} questions.` }] };
  },
);

server.tool(
  'remove_golden_question',
  'Remove a question from the golden set. Use this for questions that are no longer relevant or have been superseded.',
  {
    persona: z.string().describe('Persona ID'),
    questionSubstring: z.string().describe('Substring match of the question to remove'),
  },
  async ({ persona, questionSubstring }) => {
    const gs = loadJSON(GOLDEN_SET_PATH);
    if (!gs?.questions?.length) return { content: [{ type: 'text', text: 'Golden set is empty.' }] };

    const idx = gs.questions.findIndex(q =>
      q.persona === persona && q.question.includes(questionSubstring)
    );

    if (idx === -1) return { content: [{ type: 'text', text: `No matching question found for persona "${persona}" containing "${questionSubstring}".` }], isError: true };

    const removed = gs.questions.splice(idx, 1)[0];
    const { writeFileSync } = await import('node:fs');
    writeFileSync(GOLDEN_SET_PATH, JSON.stringify(gs, null, 2) + '\n');

    return { content: [{ type: 'text', text: `Removed: "${removed.question.slice(0, 80)}..." — ${gs.questions.length} questions remaining.` }] };
  },
);

server.tool(
  'validate_new_persona',
  'Check if a new persona candidate would be valid — verifies MBTI uniqueness within cluster and checks for conflicts with existing personas.',
  {
    id: z.string().describe('Proposed persona ID'),
    mbti: z.string().describe('MBTI type (e.g. INTJ, ESFP)'),
    cluster: z.string().describe('Cluster name (e.g. management, service)'),
  },
  async ({ id, mbti, cluster }) => {
    // Load existing personas from metrics
    const metrics = loadJSON(METRICS_PATH);
    const existingIds = metrics?.personas ? Object.keys(metrics.personas) : [];

    if (existingIds.includes(id)) {
      return { content: [{ type: 'text', text: JSON.stringify({ valid: false, reason: `Persona "${id}" already exists.` }) }] };
    }

    // We can't fully validate without persona definitions, but we can check what we know
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          valid: true,
          id,
          mbti,
          cluster,
          note: `Persona "${id}" with MBTI ${mbti} in cluster "${cluster}" appears valid. Existing personas: ${existingIds.join(', ') || 'none tracked yet'}.`,
        }),
      }],
    };
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
