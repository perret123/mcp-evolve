/**
 * mcp-evolve init — scaffolds a starter config.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const STARTER_CONFIG = `/**
 * mcp-evolve configuration.
 * See: https://github.com/mperret/mcp-evolve
 */
export default {
  // -- MCP Server Connection --

  /** Path to your MCP server config JSON (same format as Claude Code's mcpServers) */
  mcpConfig: './mcp-evolve.json',

  /** Tool name prefix to strip for clean metric names (e.g. 'mcp__my-server__') */
  mcpToolPrefix: 'mcp__my-server__',

  /** Allowed tools pattern for the answerer */
  answererTools: 'mcp__my-server__*',

  // -- Your Server --

  /** Short description of what your MCP server does (used in prompts) */
  systemDescription: 'a project management platform',

  /** Source directories the fixer/reviewer can edit to improve tools */
  srcDirs: ['./src'],

  /** Knowledge directory (optional — for domain-specific context files) */
  knowledgeDir: null,

  /**
   * Write/mutation tool names — mcp-evolve uses these to detect whether
   * an action request actually triggered a write operation.
   * Use exact names (after prefix stripping) or patterns with *.
   */
  writeTools: [
    'create_*',
    'update_*',
    'delete_*',
  ],

  // -- Personas --

  /**
   * Each persona simulates a different type of user.
   * The harness generates questions from their perspective,
   * then tests whether your MCP tools can answer them.
   */
  personas: [
    {
      id: 'admin',
      group: 'train',      // 'train' = fixer can fix, 'eval' = hold-out
      name: 'System Admin',
      role: 'Admin',
      mbti: 'INTJ',
      cluster: 'management',
      description: \`You are Alex, a system administrator who manages the platform.
        You're technical, detail-oriented, and want to understand system health.\`,
      concerns: [
        'System status and health',
        'User management',
        'Configuration and settings',
        'Activity logs and audit trails',
      ],
      questionStyle: 'Direct and technical. Asks about system state, metrics, and configuration.',
    },
    {
      id: 'end-user',
      group: 'train',
      name: 'Regular User',
      role: 'User',
      mbti: 'ESFP',
      cluster: 'users',
      description: \`You are Sam, a regular user of the platform. You use it daily
        for your work and want things to be simple and fast.\`,
      concerns: [
        'Finding and viewing data',
        'Creating and updating records',
        'Understanding what actions are available',
      ],
      questionStyle: 'Casual and task-oriented. Gives direct commands more than asks questions.',
    },
    {
      id: 'new-user',
      group: 'eval',
      name: 'New User',
      role: 'User',
      mbti: 'ENFP',
      cluster: 'learning',
      description: \`You are Jordan, brand new to the platform. You have lots of
        questions about how things work and what's possible.\`,
      concerns: [
        'Understanding basic concepts',
        'How to perform common tasks',
        'What data is available',
      ],
      questionStyle: 'Curious and exploratory. Asks "what is..." and "how do I..." questions.',
    },
  ],

  // -- Tuning --

  /** Questions generated per persona per run */
  questionsPerPersona: 3,

  /** Debug log files to monitor during tests (optional) */
  debugLogFiles: [],

  /** Language for generated questions */
  language: 'English',

  /**
   * Optional: pre-fetch real data from your MCP server so question
   * generation uses real entity names instead of hallucinated ones.
   *
   * Receives a \`claude(prompt, opts)\` helper function.
   * Return a string that will be injected into the question generator prompt.
   */
  // prefetch: async (claude, config) => {
  //   const output = await claude('List all available resources', {
  //     mcpConfig: config.mcpConfig,
  //     strictMcpConfig: true,
  //     disableBuiltinTools: true,
  //     allowedTools: config.answererTools,
  //     model: 'haiku',
  //   });
  //   return output;
  // },
};
`;

const STARTER_MCP_CONFIG = `{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {}
    }
  }
}
`;

export function init(projectRoot) {
  const configPath = join(projectRoot, 'evolve.config.mjs');
  const mcpConfigPath = join(projectRoot, 'mcp-evolve.json');
  const dataDir = join(projectRoot, '.mcp-evolve');

  const created = [];

  if (existsSync(configPath)) {
    console.log(`  evolve.config.mjs already exists — skipping`);
  } else {
    writeFileSync(configPath, STARTER_CONFIG);
    created.push('evolve.config.mjs');
  }

  if (existsSync(mcpConfigPath)) {
    console.log(`  mcp-evolve.json already exists — skipping`);
  } else {
    writeFileSync(mcpConfigPath, STARTER_MCP_CONFIG);
    created.push('mcp-evolve.json');
  }

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    created.push('.mcp-evolve/');
  }

  return created;
}
