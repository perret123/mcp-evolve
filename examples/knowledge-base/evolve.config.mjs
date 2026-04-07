import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default {
  // -- MCP Server --
  mcpConfig: './examples/knowledge-base/mcp.json',
  mcpToolPrefix: 'kb__',
  answererTools: 'kb__*',
  systemDescription: 'a corporate knowledge base platform',

  // -- Source code (for the fixer) --
  srcDirs: ['./examples/knowledge-base'],
  buildCommand: '', // No build needed for this JS example

  // -- Action detection --
  writeTools: ['create_*', 'update_*', 'delete_*'],

  // -- Environment hooks --
  seed: async (config) => {
    // Ensure docs.json is reset to baseline if needed
    // (In this simple case we just rely on the file being there)
  },
  
  describeState: () => {
    const docs = JSON.parse(readFileSync('./examples/knowledge-base/docs.json', 'utf-8'));
    const categories = [...new Set(docs.map(d => d.category))];
    return `
      ACTIVE: ${docs.length} documents across ${categories.length} categories (${categories.join(', ')}).
      IDs: ${docs.map(d => d.id).join(', ')}
      TOPICS: Onboarding, Coding, Incidents, Remote Work, Deployment.
    `;
  },

  // -- Personas --
  personas: [
    {
      id: 'curator',
      group: 'train',
      name: 'Content Curator',
      role: 'Documentation Expert',
      mbti: 'ISTJ',
      cluster: 'sentinel',
      description: 'You are Casey, a meticulous content curator who ensures all documentation is up-to-date and correctly categorized.',
      concerns: ['accuracy', 'metadata', 'consistency'],
      questionStyle: 'Formal and precise, focusing on specific IDs and metadata.',
    },
    {
      id: 'new_hire',
      group: 'train',
      name: 'New Hire',
      role: 'Junior Engineer',
      mbti: 'ENFP',
      cluster: 'explorer',
      description: 'You are Riley, a new hire who is still learning the ropes and often asks broad, slightly vague questions about how things work.',
      concerns: ['getting started', 'workflow', 'onboarding'],
      questionStyle: 'Casual and inquisitive, often using keywords instead of IDs.',
    },
    {
      id: 'auditor',
      group: 'eval',
      name: 'Compliance Auditor',
      role: 'Auditor',
      mbti: 'INTJ',
      cluster: 'analyst',
      description: 'You are Quinn, a compliance auditor checking that all policies are correctly recorded and haven\'t been modified unexpectedly.',
      concerns: ['security', 'compliance', 'audit trails'],
      questionStyle: 'Analytical and skeptical, verifying timestamps and specific policy details.',
    }
  ],
};
