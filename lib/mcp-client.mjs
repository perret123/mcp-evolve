/**
 * mcp-evolve — Minimal MCP client for local model tool calling.
 *
 * Uses @modelcontextprotocol/sdk to connect to stdio MCP servers,
 * list available tools, and execute tool calls.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';

/**
 * Connect to all MCP servers defined in an mcp-config JSON file.
 * Returns a McpSession with tool listing and calling capabilities.
 */
export async function connectMcp(mcpConfigPath, cwd) {
  const config = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
  const servers = config.mcpServers || {};

  const connections = [];

  for (const [name, serverDef] of Object.entries(servers)) {
    const transport = new StdioClientTransport({
      command: serverDef.command,
      args: serverDef.args || [],
      env: { ...process.env, ...(serverDef.env || {}) },
      cwd: serverDef.cwd || cwd || process.cwd(),
      stderr: 'pipe',
    });

    const client = new Client({
      name: 'mcp-evolve',
      version: '1.0.0',
    });

    await client.connect(transport);
    connections.push({ name, client, transport });
  }

  return new McpSession(connections);
}

class McpSession {
  constructor(connections) {
    this._connections = connections;
    this._toolMap = null; // lazy: maps tool name → connection
  }

  async listTools() {
    if (this._toolMap) return [...this._toolMap.values()].map(t => t.def);

    this._toolMap = new Map();
    for (const conn of this._connections) {
      const result = await conn.client.listTools();
      for (const tool of result.tools || []) {
        this._toolMap.set(tool.name, { def: tool, conn });
      }
    }
    return [...this._toolMap.values()].map(t => t.def);
  }

  /**
   * Convert MCP tool definitions to OpenAI-compatible function format.
   */
  async getOpenAITools() {
    const tools = await this.listTools();
    return tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    }));
  }

  /**
   * Call a tool by name. Returns the result text.
   */
  async callTool(name, args) {
    if (!this._toolMap) await this.listTools();

    const entry = this._toolMap.get(name);
    if (!entry) return { isError: true, content: `Unknown tool: ${name}` };

    try {
      const result = await entry.conn.client.callTool({ name, arguments: args });
      const text = (result.content || [])
        .map(c => c.text || JSON.stringify(c))
        .join('\n');
      return { isError: !!result.isError, content: text };
    } catch (err) {
      return { isError: true, content: err.message || String(err) };
    }
  }

  async close() {
    for (const conn of this._connections) {
      try { await conn.client.close(); } catch { /* ignore */ }
    }
    this._connections = [];
    this._toolMap = null;
  }
}
