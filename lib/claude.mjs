/**
 * mcp-evolve — Claude CLI wrapper.
 *
 * Wraps `claude --print` for non-interactive automation.
 */

import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let _claudePath = null;

/**
 * Run claude --print with given arguments. Returns stdout.
 */
export async function claude(prompt, opts = {}) {
  if (!_claudePath) {
    _claudePath = join(process.env.HOME || '', '.local', 'bin', 'claude');
  }

  const cliArgs = ['--print', '-p', prompt];

  if (opts.systemPrompt) cliArgs.push('--system-prompt', opts.systemPrompt);
  if (opts.mcpConfig) cliArgs.push('--mcp-config', opts.mcpConfig);
  if (opts.strictMcpConfig) cliArgs.push('--strict-mcp-config');
  if (opts.outputFormat) cliArgs.push('--output-format', opts.outputFormat);
  if (opts.jsonSchema) cliArgs.push('--json-schema', JSON.stringify(opts.jsonSchema));
  if (opts.allowedTools) cliArgs.push('--allowedTools', opts.allowedTools);
  if (opts.disableBuiltinTools) cliArgs.push('--tools', '');
  if (opts.model) cliArgs.push('--model', opts.model);
  if (opts.verbose) cliArgs.push('--verbose');

  cliArgs.push('--dangerously-skip-permissions');
  cliArgs.push('--no-session-persistence');

  return new Promise((resolve) => {
    const devNull = openSync('/dev/null', 'r');
    const child = spawn(_claudePath, cliArgs, {
      cwd: opts.cwd || process.cwd(),
      stdio: [devNull, 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timeoutMs = opts.timeout || 180_000;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`ERROR: ${err.message}`);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        resolve(`ERROR: ${stderr || `exit code ${code}`}`);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Read a prompt file from the prompts directory.
 */
export function readPrompt(promptsDir, name) {
  return readFileSync(join(promptsDir, name), 'utf-8');
}

/**
 * Parse stream-json output for tool calls and errors.
 */
export function parseStreamOutput(output) {
  const toolCalls = [];
  const errors = [];
  let answer = '';

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);

      if (event.type === 'result') {
        answer = event.result || '';
        if (event.is_error) errors.push({ tool: 'cli', error: answer });
      }

      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === 'tool_use') {
            toolCalls.push({ tool: block.name, input: block.input });
          }
        }
      }

      if (event.type === 'tool_result') {
        const lastTool = toolCalls[toolCalls.length - 1] || { tool: 'unknown', input: {} };
        const content = typeof event.content === 'string'
          ? event.content : JSON.stringify(event.content);

        // Attach result to the tool call for grading
        lastTool.result = content.slice(0, 2000);

        if (event.is_error) {
          errors.push({ tool: lastTool.tool, input: lastTool.input, error: content });
        }
        if (content.includes('"isError":true') || content.includes('"isError": true')) {
          errors.push({ tool: lastTool.tool, input: lastTool.input, error: content });
        }
      }
    } catch { /* not JSON */ }
  }

  if (!answer) answer = output;

  // Detect MCP-level errors in the final answer text
  if (errors.length === 0 && toolCalls.length > 0 && !answer.startsWith('{')) {
    const answerLower = answer.toLowerCase();
    const errorPatterns = ['unauthenticated', 'not authenticated', 'permission denied', 'connection refused', 'econnrefused'];
    for (const pattern of errorPatterns) {
      if (answerLower.includes(pattern)) {
        errors.push({
          tool: toolCalls[toolCalls.length - 1]?.tool || 'unknown',
          input: toolCalls[toolCalls.length - 1]?.input,
          error: `[detected in answer] ${answer.slice(0, 500)}`,
        });
        break;
      }
    }
  }

  return { answer, toolCalls, errors };
}
