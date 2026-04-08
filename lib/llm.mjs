/**
 * mcp-evolve — LLM provider router.
 *
 * Routes model calls to the appropriate provider:
 *   - 'sonnet', 'opus', 'haiku' (or no prefix)  → Claude CLI
 *   - 'ollama:<model>'                           → Ollama API (localhost:11434)
 *   - 'lmstudio:<model>'                         → LM Studio API (localhost:1234)
 *
 * Two modes:
 *   - llm()           — plain text generation (grading, question gen, etc.)
 *   - llmWithTools()   — tool-calling loop for MCP servers (answering questions)
 */

import { claude } from './claude.mjs';
import { connectMcp } from './mcp-client.mjs';

// --- Provider detection ---

const CLAUDE_MODELS = new Set(['sonnet', 'opus', 'haiku']);

const PROVIDER_ENDPOINTS = {
  ollama: 'http://localhost:11434/v1/chat/completions',
  lmstudio: 'http://localhost:1234/v1/chat/completions',
};

export function parseModelSpec(model) {
  if (!model) return { provider: 'claude', model: 'sonnet' };

  for (const prefix of Object.keys(PROVIDER_ENDPOINTS)) {
    if (model.startsWith(`${prefix}:`)) {
      return { provider: prefix, model: model.slice(prefix.length + 1) };
    }
  }

  // Bare model name — Claude
  return { provider: 'claude', model };
}

export function isLocalModel(model) {
  return parseModelSpec(model).provider !== 'claude';
}

// --- Plain text generation ---

/**
 * Drop-in replacement for claude() that routes to the right provider.
 * For non-tool calls (grading, question gen, escalation, etc.).
 */
export async function llm(prompt, opts = {}) {
  const { provider, model } = parseModelSpec(opts.model);

  if (provider === 'claude') {
    return claude(prompt, { ...opts, model });
  }

  return localChat(prompt, { ...opts, provider, model });
}

async function localChat(prompt, opts) {
  const { provider, model, systemPrompt, timeout } = opts;
  const endpoint = PROVIDER_ENDPOINTS[provider];

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout || 180_000);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      return `ERROR: ${provider} API error ${res.status}: ${body.slice(0, 200)}`;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    if (err.name === 'AbortError') return 'ERROR: timeout';
    return `ERROR: ${err.message}`;
  } finally {
    clearTimeout(timer);
  }
}

// --- Tool-calling loop ---

/**
 * Run a prompt with MCP tool access using a local model.
 * Implements the standard agent loop: prompt → tool calls → results → repeat.
 *
 * Returns { answer, toolCalls, errors } — same shape as parseStreamOutput.
 */
export async function llmWithTools(prompt, opts = {}) {
  const { provider, model } = parseModelSpec(opts.model);

  if (provider === 'claude') {
    // Claude CLI handles tools natively
    return claude(prompt, { ...opts, model });
  }

  return localToolLoop(prompt, { ...opts, provider, model });
}

async function localToolLoop(prompt, opts) {
  const { provider, model, systemPrompt, mcpConfig, cwd, timeout } = opts;
  const endpoint = PROVIDER_ENDPOINTS[provider];

  // Connect to MCP servers
  const mcp = await connectMcp(mcpConfig, cwd);
  const toolCalls = [];
  const errors = [];

  try {
    const openaiTools = await mcp.getOpenAITools();

    // Filter tools by allowed pattern
    const filteredTools = opts.allowedTools
      ? openaiTools.filter(t => matchAllowedTools(t.function.name, opts.allowedTools))
      : openaiTools;

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const maxIterations = 20;
    const overallTimeout = timeout || 180_000;
    const deadline = Date.now() + overallTimeout;

    for (let i = 0; i < maxIterations; i++) {
      if (Date.now() > deadline) {
        return formatToolResult('ERROR: timeout', toolCalls, errors);
      }

      const controller = new AbortController();
      const iterTimer = setTimeout(() => controller.abort(), Math.min(60_000, deadline - Date.now()));

      let data;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages,
            tools: filteredTools.length > 0 ? filteredTools : undefined,
            stream: false,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.text();
          return formatToolResult(`ERROR: ${provider} API ${res.status}: ${body.slice(0, 200)}`, toolCalls, errors);
        }

        data = await res.json();
      } catch (err) {
        return formatToolResult(`ERROR: ${err.message}`, toolCalls, errors);
      } finally {
        clearTimeout(iterTimer);
      }

      const choice = data.choices?.[0];
      if (!choice) return formatToolResult('ERROR: no response from model', toolCalls, errors);

      const msg = choice.message;
      messages.push(msg);

      // Check for tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const fnName = tc.function?.name;
          const fnArgs = typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function?.arguments || {};

          const result = await mcp.callTool(fnName, fnArgs);

          toolCalls.push({
            id: tc.id,
            tool: fnName,
            input: fnArgs,
            result: result.content,
          });

          if (result.isError) {
            errors.push({ tool: fnName, input: fnArgs, error: result.content });
          }

          // Send tool result back to model
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result.content,
          });
        }
        continue; // Model may want to call more tools
      }

      // No tool calls — final answer
      return formatToolResult(msg.content || '', toolCalls, errors);
    }

    // Max iterations reached
    return formatToolResult('ERROR: max tool iterations reached', toolCalls, errors);
  } finally {
    await mcp.close();
  }
}

function formatToolResult(answer, toolCalls, errors) {
  // Build a stream-json compatible output that parseStreamOutput can handle.
  // OR we can return a structured object and let the caller detect it.
  // We return the structured object — the caller checks for it.
  return { __localResult: true, answer, toolCalls, errors };
}

function matchAllowedTools(toolName, pattern) {
  if (!pattern) return true;
  // Handle 'mcp__task-manager__*' style patterns
  for (const p of pattern.split(',').map(s => s.trim())) {
    if (p.includes('*')) {
      const re = new RegExp('^' + p.replace(/\*/g, '.*') + '$');
      if (re.test(toolName)) return true;
    } else if (toolName === p) {
      return true;
    }
  }
  return false;
}
