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
  instructions: 'A family task manager for Alex\'s household. Family members: Alex (owner), Sam (partner), Mia (teen daughter), Leo (young son). Tasks may also be unassigned. When asked about tasks by category or topic (e.g. "car", "errands", "finance"), use search_tasks with the relevant keyword. When asked about "the kids", filter by assignee Mia and Leo — call list_tasks once per child and combine the results. When users ask about tasks "this week", set dueAfter to the Monday of the current week (NOT today\'s date) and dueBefore to the Sunday of the current week — this ensures tasks due earlier in the week are not missed. When users ask about tasks "next week", set dueAfter to the Monday of next week and dueBefore to the Sunday of next week. The current date is always included in both list_tasks and search_tasks responses to help calculate these boundaries.',
});

// --- Read Tools ---

server.tool(
  'list_tasks',
  'List and filter tasks. Supports filtering by status, assignee, priority, due date range, and overdue status. Does NOT support keyword, tag, or category filtering — if the query includes a category or topic (e.g. "errands", "home tasks", "finance", "school"), use search_tasks instead. Each result includes an isOverdue field (true when a task\'s deadline has already passed and it is not yet completed). To find tasks due on a specific date, set both dueAfter and dueBefore to that date. When users ask about tasks that need help, need attention, or still need to be done, always specify a status filter to exclude completed tasks — omitting status returns ALL tasks including completed ones. IMPORTANT: Only apply dueAfter/dueBefore when the user explicitly mentions a date range (e.g. "due this week", "due today", "by Friday", "this month"). When the user says "today" in the sense of "right now" or "currently" (e.g. "what does Alex need to do today", "what needs help today"), that means currently outstanding tasks — use status="todo,in_progress" but do NOT add date filters.',
  {
    status: z.string().optional().describe('Filter by status. Accepts a single value or a comma-separated list. Valid values: "todo" (not started), "in_progress" (started but not done), "completed" (done). To find all incomplete tasks (tasks that still need work), use status="todo,in_progress". Never omit this parameter when looking for tasks that need attention — omitting it returns completed tasks too.'),
    assignee: z.string().optional().describe('Filter by exact assignee name. Valid values: "Alex", "Sam", "Mia", "Leo". To get tasks for multiple people (e.g. "the kids" = Mia and Leo), call this tool once per person and combine the results.'),
    priority: z.string().optional().describe('Filter by priority'),
    dueBefore: z.string().optional().describe('Due date upper bound (YYYY-MM-DD, inclusive). For "this month" queries, set to the last day of the month (e.g. "2026-04-30"). Only apply this when the user explicitly mentions a due date or date range — do not infer a date filter from words like "today" when the user means "currently outstanding".'),
    dueAfter: z.string().optional().describe('Due date lower bound (YYYY-MM-DD, inclusive). For "this month" queries, set to the first day of the current month (e.g. "2026-04-01"), NOT today\'s date — otherwise tasks due earlier in the month will be missed. Only apply this when the user explicitly mentions a due date or date range — do not infer a date filter from words like "today" when the user means "currently outstanding".'),
    overdue: z.boolean().optional().describe('Filter by overdue status. When true, return only tasks that are past their due date and not completed. When false, return only tasks that are not past their due date. Omit this parameter entirely to return tasks regardless of whether they are overdue — do not pass false just to see "current" or "active" tasks.'),
  },
  async ({ status, assignee, priority, dueBefore, dueAfter, overdue }) => {
    let tasks = loadTasks();

    if (status !== undefined) {
      const statuses = status.split(',').map(s => s.trim());
      tasks = tasks.filter(t => statuses.includes(t.status));
    }
    if (assignee !== undefined) {
      tasks = tasks.filter(t => t.assignee && t.assignee.toLowerCase() === assignee.toLowerCase());
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

    if (overdue !== undefined) {
      tasks = tasks.filter(t => {
        const isOverdue = t.status !== 'completed' && !!t.dueDate && t.dueDate < now;
        return overdue ? isOverdue : !isOverdue;
      });
    }

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

    const result = { today: now, count: summaries.length, tasks: summaries };
    if (summaries.length === 0) {
      result.message = 'No tasks found matching the given filters.';
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
  'Search tasks by keyword in the title or tags, with optional filters. Use this when a keyword or category is relevant (e.g. "errands", "home tasks", "car", "finance tasks"). Omitting the query applies only the other filters. Supports filtering by status, assignee, priority, and due date range alongside the keyword search. Status accepts a single value or a comma-separated list (e.g. "todo,in_progress" to find all incomplete tasks). When users ask about tasks that still need to be done, still need attention, or are not yet finished, use status="todo,in_progress" to include both not-started and in-progress tasks. The response always includes today\'s date to help confirm date range calculations. When no tasks are found, always tell the user clearly that no matching tasks exist.',
  {
    query: z.string().optional().describe('Keyword or phrase to search for in task titles or tags (e.g. "finance", "home", "school project", "errands"). Multi-word queries match tasks that contain ALL words anywhere in the title or tags. Omit to skip keyword filtering and apply only the other filters.'),
    status: z.string().optional().describe('Filter by status. Accepts a single value or a comma-separated list. Valid values: "todo", "in_progress", "completed". To find all incomplete tasks (tasks that still need work or are still to do), use status="todo,in_progress". Never omit this parameter when looking for tasks that still need attention — omitting it returns completed tasks too.'),
    assignee: z.string().optional().describe('Filter by assignee name'),
    priority: z.string().optional().describe('Filter by priority (low, medium, high, urgent)'),
    dueAfter: z.string().optional().describe('Due date lower bound (YYYY-MM-DD, inclusive). For "this month" queries, set to the first day of the current month (e.g. "2026-04-01"), NOT today\'s date — otherwise tasks due earlier in the month will be missed. Only apply this when the user explicitly mentions a due date or date range.'),
    dueBefore: z.string().optional().describe('Due date upper bound (YYYY-MM-DD, inclusive). For "this month" queries, set to the last day of the month (e.g. "2026-04-30"). Only apply this when the user explicitly mentions a due date or date range.'),
  },
  async ({ query, status, assignee, priority, dueAfter, dueBefore }) => {
    let tasks = loadTasks();
    if (query !== undefined) {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      tasks = tasks.filter(t => {
        const titleLower = t.title.toLowerCase();
        const tagValues = Array.isArray(t.tags) ? t.tags.map(tag => tag.toLowerCase()) : [];
        return tokens.every(token =>
          titleLower.includes(token) ||
          tagValues.some(tag => tag.includes(token))
        );
      });
    }

    if (status !== undefined) {
      const statuses = status.split(',').map(s => s.trim());
      tasks = tasks.filter(t => statuses.includes(t.status));
    }
    if (assignee !== undefined) {
      tasks = tasks.filter(t => t.assignee && t.assignee.toLowerCase() === assignee.toLowerCase());
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

    const result = { today: now, count: summaries.length, tasks: summaries };
    if (summaries.length === 0) {
      result.message = 'No tasks found matching the given query and filters.';
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_stats',
  'Get aggregate statistics across ALL tasks: total task count, count by status (todo, in_progress, completed), number of overdue tasks, overall completion rate as a percentage, and top assignees by task count. Use this tool ONLY for global/overall summaries (e.g. "what is the overall completion rate", "how many tasks are there in total", "how many tasks are overdue overall"). Do NOT use this tool when the question involves a keyword, category, tag, or topic (e.g. "how many finance tasks are completed", "how many errands are done", "how many school tasks are there") — for those, use search_tasks with the relevant query and status filters instead.',
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

    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) {
        task[key] = val;
      }
    }

    if (status === 'completed' && !task.completedAt) {
      task.completedAt = new Date().toISOString();
    } else if (status && status !== 'completed') {
      task.completedAt = null;
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
    const filtered = tasks.filter(t => t.id !== id);
    saveTasks(filtered);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, id }) }] };
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
