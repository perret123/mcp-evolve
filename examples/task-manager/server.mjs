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
import * as api from './task-api.mjs';

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
    status: z.string().optional().describe('Filter by status'),
    assignee: z.string().optional().describe('Filter by person'),
    priority: z.string().optional().describe('Filter by priority'),
    dueBefore: z.string().optional().describe('Due date upper bound'),
    dueAfter: z.string().optional().describe('Due date lower bound'),
  },
  async ({ status, assignee, priority, dueBefore, dueAfter }) => {
    const result = api.listTasks({ status, assignee, priority, dueBefore, dueAfter });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_task',
  'Get a single task by its ID.',
  { id: z.string().describe('Task ID') },
  async ({ id }) => {
    const task = api.getTask(id);
    return { content: [{ type: 'text', text: JSON.stringify(task) }] };
  },
);

server.tool(
  'search_tasks',
  'Search tasks across all fields.',
  { query: z.string().describe('Search query') },
  async ({ query }) => {
    const tasks = api.listTasks({});
    const q = query.toLowerCase();
    const matches = tasks.tasks.filter(t => t.title.toLowerCase().includes(q));
    return { content: [{ type: 'text', text: JSON.stringify(matches, null, 2) }] };
  },
);

server.tool(
  'get_stats',
  'Get statistics.',
  {},
  async () => {
    const stats = api.getStats();
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
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
    const task = api.createTask({ title, description, assignee, dueDate, priority, tags });
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
    const tasks = api.listTasks({}).tasks;
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) {
      return { content: [{ type: 'text', text: `Task not found: ${id}` }], isError: true };
    }

    const fields = { title, description, status, priority, assignee, dueDate, tags };
    const changes = {};
    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) changes[key] = val;
    }

    const result = api.updateTask(id, changes);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'delete_task',
  'Delete a task.',
  { id: z.string().describe('Task ID to delete') },
  async ({ id }) => {
    api.deleteTask(id);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, id }) }] };
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
