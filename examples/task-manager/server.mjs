#!/usr/bin/env node

/**
 * Task Manager MCP server.
 * Family to-do list for Alex's household.
 *
 * Read:  list_tasks, get_task, search_tasks, get_stats
 * Write: create_task, update_task, delete_task
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TASKS_PATH = join(new URL('.', import.meta.url).pathname, 'tasks.json');

/**
 * Normalize status strings to canonical values used in the data store.
 * Canonical statuses: "todo", "in_progress", "completed".
 * Accepts common synonyms and formatting variations.
 */
function normalizeStatus(status) {
  if (status === undefined) return undefined;
  const s = status.toLowerCase().trim();
  const map = {
    'todo': 'todo',
    'to_do': 'todo',
    'to-do': 'todo',
    'pending': 'todo',
    'open': 'todo',
    'not_started': 'todo',
    'not-started': 'todo',
    'in_progress': 'in_progress',
    'in-progress': 'in_progress',
    'in progress': 'in_progress',
    'inprogress': 'in_progress',
    'active': 'in_progress',
    'started': 'in_progress',
    'doing': 'in_progress',
    'completed': 'completed',
    'done': 'completed',
    'finished': 'completed',
    'complete': 'completed',
  };
  return map[s] ?? status;  // pass through unknown values as-is
}

function loadTasks() {
  try {
    return JSON.parse(readFileSync(TASKS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function saveTasks(tasks) {
  writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2) + '\n');
}

const server = new McpServer({
  name: 'task-manager',
  version: '0.1.0',
}, {
  instructions: `A family task manager for Alex's household. Manage to-do items for the whole family.

Key conventions:
- Statuses: "todo", "in_progress", "completed" (aliases like "pending", "done" are accepted).
- Priorities: "low", "medium", "high", "urgent".
- Assignees: Alex, Sam, Mia, Leo, or unassigned.
- Tags: home, health, finance, errands, kids, garden, family, car, school.

Important usage patterns:
- To find OVERDUE tasks, use list_tasks with overdue=true. Do NOT use dueBefore for this — dueBefore returns tasks of all statuses including completed.
- Combine filters in a single list_tasks call (e.g. assignee + status) rather than making multiple calls.
- For quick overdue counts or status breakdowns, use get_stats instead of listing all tasks.
- search_tasks only matches against task titles. Use list_tasks with filters for tag/assignee/status queries.
- Always base your answer on the actual data returned by tools. If a tool returns an empty array, report that — do not infer or fabricate tasks.`,
});

// --- Read Tools ---

server.tool(
  'list_tasks',
  'List tasks with optional filters. Filters can be combined in a single call (e.g. assignee + status). Returns paginated results (default limit=50); check "hasMore" in response to know if more pages exist. For "what is overdue?" questions, you MUST use overdue=true — do NOT use dueBefore (it includes completed tasks).',
  {
    overdue: z.boolean().optional().describe('**Use this for overdue queries.** Set to true to return ONLY tasks that are past due AND not completed. This is the correct way to answer "what is overdue?" — do NOT use dueBefore for overdue queries.'),
    status: z.string().optional().describe('Filter by status. Canonical values: "todo", "in_progress", "completed". Aliases accepted: "pending"→todo, "in-progress"→in_progress, "done"→completed.'),
    assignee: z.string().optional().describe('Filter by person assigned. Known assignees: Alex, Sam, Mia, Leo. Case-sensitive.'),
    priority: z.string().optional().describe('Filter by priority level: "low", "medium", "high", or "urgent".'),
    dueBefore: z.string().optional().describe('Due date upper bound (YYYY-MM-DD). WARNING: Returns tasks of ALL statuses including completed — NOT suitable for finding overdue tasks. Use "overdue=true" instead.'),
    dueAfter: z.string().optional().describe('Due date lower bound (YYYY-MM-DD). Returns tasks of ALL statuses including completed.'),
    limit: z.number().optional().describe('Max results per page (default 50). Response includes "hasMore" boolean — if true, increase offset to get next page.'),
    offset: z.number().optional().describe('Skip N tasks for pagination (default 0). Use when "hasMore" is true in a previous response.'),
  },
  async ({ status, assignee, priority, dueBefore, dueAfter, overdue, limit, offset }) => {
    let tasks = loadTasks();
    const normalizedStatus = normalizeStatus(status);

    if (overdue === true) {
      const now = new Date().toISOString().slice(0, 10);
      tasks = tasks.filter(t => t.status !== 'completed' && t.dueDate && t.dueDate < now);
    }
    if (normalizedStatus !== undefined) {
      tasks = tasks.filter(t => t.status === normalizedStatus);
    }
    if (assignee !== undefined) {
      tasks = tasks.filter(t => t.assignee === assignee);
    }
    if (priority !== undefined) {
      tasks = tasks.filter(t => t.priority === priority);
    }
    if (dueBefore !== undefined) {
      tasks = tasks.filter(t => t.dueDate && t.dueDate <= dueBefore);
    }
    if (dueAfter !== undefined) {
      tasks = tasks.filter(t => t.dueDate && t.dueDate >= dueAfter);
    }

    const totalFiltered = tasks.length;
    const effectiveOffset = offset ?? 0;
    const effectiveLimit = limit ?? 50;
    tasks = tasks.slice(effectiveOffset, effectiveOffset + effectiveLimit);

    const summaries = tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee: t.assignee,
      dueDate: t.dueDate,
      tags: t.tags,
    }));

    const result = {
      tasks: summaries,
      total: totalFiltered,
      offset: effectiveOffset,
      limit: effectiveLimit,
      hasMore: effectiveOffset + effectiveLimit < totalFiltered,
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_task',
  'Get full details of a single task by its ID (e.g. "task-001"). Returns all fields including description, createdAt, and completedAt. Use list_tasks first to find task IDs.',
  { id: z.string().describe('Task ID, e.g. "task-042". Format: "task-NNN".') },
  async ({ id }) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === id);
    if (!task) {
      return { content: [{ type: 'text', text: `Error: No task found with ID "${id}". Use list_tasks to find valid task IDs.` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
  },
);

server.tool(
  'search_tasks',
  'Search tasks by keyword in title, description, and tags. Returns matching task summaries. For filtering by status, assignee, priority, or date, use list_tasks instead.',
  { query: z.string().describe('Search keyword (case-insensitive). Matches against task title, description, and tags.') },
  async ({ query }) => {
    const tasks = loadTasks();
    const q = query.toLowerCase();
    const matches = tasks.filter(t =>
      t.title.toLowerCase().includes(q) ||
      (t.description && t.description.toLowerCase().includes(q)) ||
      (t.tags && t.tags.some(tag => tag.toLowerCase().includes(q)))
    );

    const summaries = matches.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee: t.assignee,
      dueDate: t.dueDate,
      tags: t.tags,
    }));

    return { content: [{ type: 'text', text: JSON.stringify(summaries, null, 2) }] };
  },
);

server.tool(
  'get_stats',
  'Get statistics.',
  {},
  async () => {
    const tasks = loadTasks();
    const now = new Date().toISOString().slice(0, 10);

    const byStatus = {};
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    }

    const overdue = tasks.filter(t =>
      t.status !== 'completed' && t.dueDate && t.dueDate < now
    ).length;

    const completed = tasks.filter(t => t.status === 'completed').length;
    const completionRate = tasks.length > 0
      ? `${(completed / tasks.length * 100).toFixed(1)}%`
      : '0%';

    // Top assignees by task count
    const assigneeCounts = {};
    for (const t of tasks) {
      if (t.assignee) {
        assigneeCounts[t.assignee] = (assigneeCounts[t.assignee] || 0) + 1;
      }
    }
    const topAssignees = Object.entries(assigneeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total: tasks.length,
          byStatus,
          overdue,
          completionRate,
          topAssignees,
        }, null, 2),
      }],
    };
  },
);

// --- Write Tools ---

server.tool(
  'create_task',
  'Create a new task.',
  {
    title: z.string().describe('Task title'),
    description: z.string().optional().describe('Task description'),
    assignee: z.string().optional().describe('Person assigned to the task'),
    dueDate: z.string().optional().describe('Due date (YYYY-MM-DD)'),
    priority: z.string().optional().describe('Task priority'),
    tags: z.array(z.string()).optional().describe('Tags for the task'),
  },
  async ({ title, description, assignee, dueDate, priority, tags }) => {
    const tasks = loadTasks();

    // Generate next ID by finding max existing task number + 1
    const maxNum = tasks.reduce((max, t) => {
      const num = parseInt(t.id.replace(/\D/g, ''), 10);
      return isNaN(num) ? max : Math.max(max, num);
    }, 0);
    const id = `task-${String(maxNum + 1).padStart(3, '0')}`;

    const task = {
      id,
      title,
      description: description || null,
      status: 'todo',
      priority: priority || 'medium',
      assignee: assignee || null,
      dueDate: dueDate || null,
      tags: tags || [],
      completedAt: null,
      createdAt: new Date().toISOString(),
    };

    tasks.push(task);
    saveTasks(tasks);

    return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
  },
);

server.tool(
  'update_task',
  'Update a task.',
  {
    id: z.string().describe('Task ID to update'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description'),
    status: z.string().optional().describe('New status'),
    priority: z.string().optional().describe('New priority'),
    assignee: z.string().optional().describe('New assignee'),
    dueDate: z.string().optional().describe('New due date'),
    tags: z.array(z.string()).optional().describe('New tags'),
  },
  async ({ id, title, description, status, priority, assignee, dueDate, tags }) => {
    const tasks = loadTasks();
    const idx = tasks.findIndex(t => t.id === id);

    if (idx === -1) {
      return { content: [{ type: 'text', text: `Task not found: ${id}` }], isError: true };
    }

    const task = tasks[idx];
    const fields = { title, description, status, priority, assignee, dueDate, tags };

    // PLANTED BUG: generic field update loop — does NOT set completedAt when status → "completed"
    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) {
        task[key] = val;
      }
    }

    tasks[idx] = task;
    saveTasks(tasks);

    return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
  },
);

server.tool(
  'delete_task',
  'Delete a task.',
  { id: z.string().describe('Task ID to delete') },
  async ({ id }) => {
    const tasks = loadTasks();
    // PLANTED BUG: filters and saves regardless of whether task existed — always returns success
    const filtered = tasks.filter(t => t.id !== id);
    saveTasks(filtered);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, id }) }] };
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
