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
  instructions: 'A family task manager for Alex\'s household. Manage to-do items for the whole family.',
});

// --- Read Tools ---

server.tool(
  'list_tasks',
  'Get tasks.',
  {
    status: z.string().optional().describe('Filter by exact status. Valid values: "todo" (not started), "in_progress" (started but not done), "completed" (done). To find all incomplete tasks, omit this parameter and exclude completed tasks from the result, or call twice — once for "todo" and once for "in_progress".'),
    assignee: z.string().optional().describe('Filter by person'),
    priority: z.string().optional().describe('Filter by priority'),
    dueBefore: z.string().optional().describe('Due date upper bound'),
    dueAfter: z.string().optional().describe('Due date lower bound'),
  },
  async ({ status, assignee, priority, dueBefore, dueAfter }) => {
    let tasks = loadTasks();

    if (status !== undefined) {
      tasks = tasks.filter(t => t.status === status);
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

    const now = new Date().toISOString().slice(0, 10);
    const summaries = tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee: t.assignee,
      dueDate: t.dueDate,
      isOverdue: t.status !== 'completed' && !!t.dueDate && t.dueDate < now,
      tags: t.tags,
    }));

    return { content: [{ type: 'text', text: JSON.stringify(summaries, null, 2) }] };
  },
);

server.tool(
  'get_task',
  'Get a single task by its ID.',
  { id: z.string().describe('Task ID') },
  async ({ id }) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === id);
    return { content: [{ type: 'text', text: JSON.stringify(task || null) }] };
  },
);

server.tool(
  'search_tasks',
  'Search tasks across all fields.',
  { query: z.string().describe('Search query') },
  async ({ query }) => {
    const tasks = loadTasks();
    const q = query.toLowerCase();
    const matches = tasks.filter(t => t.title.toLowerCase().includes(q));

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
    const wasCompleted = task.status === 'completed';
    const fields = { title, description, status, priority, assignee, dueDate, tags };

    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) {
        task[key] = val;
      }
    }

    tasks[idx] = task;
    saveTasks(tasks);

    const prefix = wasCompleted && status !== 'completed'
      ? `WARNING: This task was already marked as completed (completedAt: ${task.completedAt}). The requested updates were applied, but the user should be informed that this task was already done.\n\n`
      : '';

    return { content: [{ type: 'text', text: prefix + JSON.stringify(task, null, 2) }] };
  },
);

server.tool(
  'delete_task',
  'Delete a task.',
  { id: z.string().describe('Task ID to delete') },
  async ({ id }) => {
    const tasks = loadTasks();
    const filtered = tasks.filter(t => t.id !== id);
    saveTasks(filtered);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, id }) }] };
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
