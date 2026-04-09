/**
 * mcp-evolve — LLM provider router.
 *
 * Routes model calls to the appropriate provider:
 *   - 'sonnet', 'opus', 'haiku' (or no prefix)  → Claude CLI
 *   - 'ollama:<model>'                           → Ollama native API (localhost:11434)
 *   - 'lmstudio:<model>'                         → LM Studio OpenAI API (localhost:1234)
 *
 * Two modes:
 *   - llm()           — plain text generation (grading, question gen, etc.)
 *   - llmWithTools()   — tool-calling loop for MCP servers (answering questions)
 */

import { claude } from './claude.mjs';
import { connectMcp } from './mcp-client.mjs';

// --- Global config for local model options ---
let _globalConfig = null;

/** Set global config so llm() calls auto-inject numCtx/numPredict. */
export function setLlmConfig(config) { _globalConfig = config; }

function applyDefaults(opts) {
  if (!_globalConfig) return opts;
  if (_globalConfig.localContextWindow && !opts.numCtx) opts.numCtx = _globalConfig.localContextWindow;
  if (_globalConfig.localMaxPredict && !opts.numPredict) opts.numPredict = _globalConfig.localMaxPredict;
  return opts;
}

// --- Provider detection ---

const PROVIDERS = {
  ollama: {
    chat: 'http://localhost:11434/api/chat',         // native — supports options.num_ctx, num_predict
    openai: 'http://localhost:11434/v1/chat/completions', // for tool calling (better tool_calls format)
  },
  lmstudio: {
    openai: 'http://localhost:1234/v1/chat/completions',
  },
};

export function parseModelSpec(model) {
  if (!model) return { provider: 'claude', model: 'sonnet' };

  for (const prefix of Object.keys(PROVIDERS)) {
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

  return localChat(prompt, applyDefaults({ ...opts, provider, model }));
}

async function localChat(prompt, opts) {
  const { provider, model, systemPrompt, timeout } = opts;

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout || 600_000);

  try {
    if (provider === 'ollama') {
      // Use native Ollama API — supports num_ctx, num_predict
      const body = { model, messages, stream: false };
      const options = {};
      if (opts.numCtx) options.num_ctx = opts.numCtx;
      if (opts.numPredict) options.num_predict = opts.numPredict;
      if (Object.keys(options).length > 0) body.options = options;

      const res = await fetch(PROVIDERS.ollama.chat, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        return `ERROR: ollama API error ${res.status}: ${text.slice(0, 200)}`;
      }

      const data = await res.json();
      return data.message?.content || '';
    } else {
      // LM Studio / OpenAI-compatible
      const body = { model, messages, stream: false };
      const res = await fetch(PROVIDERS[provider].openai, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        return `ERROR: ${provider} API error ${res.status}: ${text.slice(0, 200)}`;
      }

      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    }
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
    return claude(prompt, { ...opts, model });
  }

  return localToolLoop(prompt, applyDefaults({ ...opts, provider, model }));
}

async function localToolLoop(prompt, opts) {
  const { provider, model, systemPrompt, mcpConfig, cwd, timeout } = opts;

  // Tool calling uses OpenAI-compatible endpoint (better tool_calls format)
  const endpoint = PROVIDERS[provider]?.openai || PROVIDERS[provider]?.chat;

  // Connect to MCP servers
  const mcp = await connectMcp(mcpConfig, cwd);
  const toolCalls = [];
  const errors = [];

  try {
    const openaiTools = await mcp.getOpenAITools();

    // For local models, MCP client already scopes tools to configured servers.
    const filteredTools = openaiTools;

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const maxIterations = 20;
    const overallTimeout = timeout || 600_000;
    const deadline = Date.now() + overallTimeout;

    for (let i = 0; i < maxIterations; i++) {
      if (Date.now() > deadline) {
        return formatToolResult('ERROR: timeout', toolCalls, errors);
      }

      const controller = new AbortController();
      const iterTimer = setTimeout(() => controller.abort(), Math.min(120_000, deadline - Date.now()));

      let data;
      try {
        const body = {
          model,
          messages,
          tools: filteredTools.length > 0 ? filteredTools : undefined,
          stream: false,
        };

        // Ollama: pass num_ctx/num_predict via extra fields (some versions support it)
        if (provider === 'ollama') {
          if (opts.numCtx) body.num_ctx = opts.numCtx;
          if (opts.numPredict) body.num_predict = opts.numPredict;
        }

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text();
          return formatToolResult(`ERROR: ${provider} API ${res.status}: ${text.slice(0, 200)}`, toolCalls, errors);
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
  return { __localResult: true, answer, toolCalls, errors };
}
