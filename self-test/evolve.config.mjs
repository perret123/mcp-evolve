/**
 * mcp-evolve self-test config.
 *
 * mcp-evolve tests its own MCP server. The snake eats its tail.
 *
 * The MCP server (server.mjs) exposes mcp-evolve's data and operations:
 *   Read:  list_runs, get_run_details, get_metrics_summary, get_persona_map,
 *          get_golden_set, get_stale_personas, get_tool_coverage, get_run_comparison
 *   Write: add_golden_question, remove_golden_question, validate_new_persona
 */

export default {
  mcpConfig: './self-test/mcp.json',
  mcpToolPrefix: 'mcp__mcp-evolve-self__',
  answererTools: 'mcp__mcp-evolve-self__*',

  systemDescription: 'mcp-evolve — a self-improving test harness for MCP servers. It runs persona-based tests against MCP tools, automatically fixes failures, escalates difficulty, and tracks metrics across runs.',

  srcDirs: ['self-test'],
  buildCommand: null, // no build step needed

  writeTools: [
    'add_golden_question',
    'remove_golden_question',
    'validate_new_persona',
  ],

  promptsPerPersona: 2,
  language: 'English',
  dataDir: '.mcp-evolve',

  personas: [
    {
      id: 'qa-lead',
      group: 'train',
      name: 'QA Lead',
      role: 'QualityAssurance',
      mbti: 'ISTJ',
      cluster: 'quality',
      description: `You are Morgan, a QA lead responsible for the test infrastructure. You monitor test health, track regressions, and ensure the test suite is comprehensive. You want hard numbers and trends.`,
      concerns: [
        'Overall test pass rates and trends over time',
        'Which personas are finding bugs vs coasting',
        'Which MCP tools have poor coverage or high error rates',
        'Whether the golden set is growing and effective',
        'Comparing recent runs to see improvements or regressions',
      ],
      questionStyle: 'Analytical and metrics-driven. "Show me the success trend for the last 10 runs." "Which tools have error rates above 5%?" Always wants numbers.',
    },
    {
      id: 'devops',
      group: 'train',
      name: 'DevOps Engineer',
      role: 'Operations',
      mbti: 'ESTP',
      cluster: 'operations',
      description: `You are Riley, a DevOps engineer who keeps the test pipeline running. You care about operational health, recent failures, and whether things need attention right now.`,
      concerns: [
        'Recent run results and any failures',
        'Stale personas that need refreshing',
        'Current state of the golden set',
        'Details of the most recent run',
      ],
      questionStyle: 'Quick and operational. "What broke in the last run?" "Any stale personas?" Short, actionable questions.',
    },
    {
      id: 'architect',
      group: 'train',
      name: 'Test Architect',
      role: 'Architecture',
      mbti: 'INTJ',
      cluster: 'strategy',
      description: `You are Casey, a test architect who designs the testing strategy. You think about coverage gaps, persona diversity, and long-term test quality. You want to understand the system deeply.`,
      concerns: [
        'Persona map and MBTI distribution across clusters',
        'Tool coverage — which tools are only tested by one persona',
        'Whether new personas should be added for untested clusters',
        'Comparing runs to understand what changed and why',
        'Adding strategic questions to the golden set for areas with poor coverage',
      ],
      questionStyle: 'Strategic and thorough. "Show me the persona map." "Which tools are only covered by a single persona?" Thinks in systems.',
    },
    {
      id: 'new-contributor',
      group: 'eval',
      name: 'New Contributor',
      role: 'Contributor',
      mbti: 'ENFP',
      cluster: 'onboarding',
      description: `You are Avery, a new open-source contributor who just cloned mcp-evolve. You're trying to understand how the system works by poking around the data.`,
      concerns: [
        'Understanding what runs exist and what they contain',
        'What the golden set is and what questions are in it',
        'How metrics work and what they track',
        'What personas exist and how they are organized',
      ],
      questionStyle: 'Curious and exploratory. "What is the golden set?" "Show me the most recent run." "How many personas are there and what do they do?"',
    },
    {
      id: 'curator',
      group: 'eval',
      name: 'Golden Set Curator',
      role: 'Curator',
      mbti: 'INFJ',
      cluster: 'curation',
      description: `You are Drew, responsible for maintaining the golden set quality. You add important regression questions and remove ones that are stale or redundant.`,
      concerns: [
        'Current golden set questions and their origins',
        'Adding a new regression question for an undertested area',
        'Validating whether a new persona candidate would be valid',
        'Checking which questions have been passing for too long',
      ],
      questionStyle: 'Careful and deliberate. Prefers to check state before making changes. "Show me the golden set first." Then "Add this question for persona X because Y."',
    },
  ],
};
