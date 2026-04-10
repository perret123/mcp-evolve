/**
 * mcp-evolve config for the task-manager example.
 *
 * A family task manager with seeded data, deliberately sloppy
 * tool descriptions, and planted bugs — designed to be improved
 * by mcp-evolve's feedback loop.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const EXAMPLE_DIR = new URL('.', import.meta.url).pathname;
const SEED_PATH = join(EXAMPLE_DIR, 'seed-data.json');
const TASKS_PATH = join(EXAMPLE_DIR, 'tasks.json');

function shiftDate(dateStr, offsetDays) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr);
  d.setDate(d.getDate() + offsetDays);
  // Preserve format: if original was date-only (YYYY-MM-DD), return date-only
  if (dateStr.length === 10) return d.toISOString().slice(0, 10);
  return d.toISOString();
}

export default {
  mcpConfig: join(EXAMPLE_DIR, 'mcp.json'),
  mcpToolPrefix: 'mcp__task-manager__',
  answererTools: 'mcp__task-manager__*',

  systemDescription: "a family task manager — Alex's household to-do list with tasks for the whole family",

  srcDirs: [EXAMPLE_DIR],

  writeTools: ['create_task', 'update_task', 'delete_task'],

  dataDir: join(EXAMPLE_DIR, '.mcp-evolve'),

  // --- Model configuration ---
  // Local model for most roles, Claude for fixing (needs Edit/Read tools).
  answererModel: 'ollama:qwen3.5:35b-a3b-coding-nvfp4',
  graderModel: 'ollama:qwen3.5:35b-a3b-coding-nvfp4',
  promptModel: 'ollama:qwen3.5:35b-a3b-coding-nvfp4',
  fixerModel: 'sonnet',
  reviewerModel: 'sonnet',
  escalatorModel: 'ollama:qwen3.5:35b-a3b-coding-nvfp4',
  proposalModel: 'ollama:qwen3.5:35b-a3b-coding-nvfp4',
  voterModel: 'ollama:qwen3.5:35b-a3b-coding-nvfp4',
  probeModel: 'ollama:qwen3.5:35b-a3b-coding-nvfp4',

  maxTrainPerRun: 10,
  maxGoldenPerRun: 10,

  localContextWindow: 64000,
  localMaxPredict: 16384,

  initPrompts: 10,
  promptsPerPersona: 2,
  language: 'English',

  describeState: () => [
    "Alex's family task manager with 120 tasks.",
    '100 completed tasks from the past 6 months (household chores, errands, appointments).',
    '10 active tasks due within the next 2 weeks (some are overdue by a few days).',
    '10 future tasks due 1-3 months from now.',
    'Assignees: Alex, Sam (partner), Mia (teen daughter), Leo (young son), or unassigned.',
    'Tags: home, health, finance, errands, kids, garden, family, car, school.',
    'Priorities: low, medium, high, urgent.',
    'Statuses: todo, in_progress, completed.',
  ].join('\n'),

  seed: async () => {
    const raw = JSON.parse(readFileSync(SEED_PATH, 'utf-8'));
    const anchor = new Date(raw.anchorDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const offsetDays = Math.round((today - anchor) / (1000 * 60 * 60 * 24));

    const tasks = raw.tasks.map(t => ({
      ...t,
      dueDate: shiftDate(t.dueDate, offsetDays),
      createdAt: shiftDate(t.createdAt, offsetDays),
      completedAt: shiftDate(t.completedAt, offsetDays),
    }));

    writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2) + '\n');
  },

  reset: async () => {
    try { unlinkSync(TASKS_PATH); } catch { /* ok if missing */ }
  },

  personas: [
    {
      id: 'alex',
      group: 'train',
      name: 'Alex (Owner)',
      mbti: 'ESTJ',
      cluster: 'management',
      description: 'You are Alex, the household organizer. You manage the family to-do list and want to stay on top of deadlines. You speak in direct, short commands.',
      concerns: [
        'Overdue tasks and upcoming deadlines',
        'Tasks assigned to specific family members',
        'Creating and updating tasks',
        'Checking task completion status',
      ],
      questionStyle: 'Direct and results-oriented. "What\'s overdue?" "Show me this week\'s tasks." "Mark the faucet fix as done."',
    },
    {
      id: 'sam',
      group: 'train',
      name: 'Sam (Partner)',
      mbti: 'INFP',
      cluster: 'planning',
      description: 'You are Sam, Alex\'s partner. You help manage the family calendar and kids\' activities. You\'re collaborative and like to reorganize priorities.',
      concerns: [
        'Kids\' tasks and schedules',
        'Rescheduling and reprioritizing tasks',
        'Planning upcoming family events',
        'Checking what\'s on your plate',
      ],
      questionStyle: 'Collaborative and thoughtful. "Can we move the dentist to next week?" "What\'s on my plate?" "What tasks do the kids have?"',
    },
    {
      id: 'mia',
      group: 'eval',
      name: 'Mia (Teen)',
      mbti: 'ESFP',
      cluster: 'casual',
      description: 'You are Mia, 15-year-old daughter. You check your tasks reluctantly and type casually with no capitalization.',
      concerns: [
        'Your own assigned tasks',
        'What\'s happening with birthday parties or fun stuff',
        'Avoiding chores if possible',
      ],
      questionStyle: 'Casual and impatient. "do i have anything to do today" "whats leos party plan" "can someone else mow the lawn"',
    },
    {
      id: 'grandma',
      group: 'train',
      name: 'Grandma Ruth',
      mbti: 'ISFJ',
      cluster: 'support',
      description: 'You are Ruth, Alex\'s mother. You want to help but aren\'t very tech-savvy. You ask how things work and offer to take on tasks.',
      concerns: [
        'Understanding how to use the system',
        'Seeing what Alex or the kids need help with',
        'Adding yourself to tasks she can help with',
        'Finding tasks by searching for topics',
      ],
      questionStyle: 'Helpful but unsure. "I\'d like to see what Alex needs help with." "How do I add something to the list?" "Can you search for anything related to cooking?"',
    },
    {
      id: 'neighbor',
      group: 'eval',
      name: 'Neighbor Dave',
      mbti: 'ENTP',
      cluster: 'external',
      description: 'You are Dave, the next-door neighbor. You\'re nosy but friendly. You ask about stats and patterns, always curious how organized the family is.',
      concerns: [
        'Overall statistics and completion rates',
        'Search for specific topics',
        'How many tasks each person handles',
        'Overdue patterns and productivity trends',
      ],
      questionStyle: 'Friendly and analytical. "How many tasks do you guys finish per month?" "Who\'s the busiest person in the family?" "Search for anything garden-related."',
    },
  ],
};
