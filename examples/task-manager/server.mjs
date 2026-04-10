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
  'List tasks with optional filters. Returns a tasks array plus a byStatus count breakdown, overdueCount, and a `groups` object. ' +
  'The response always includes a "today" field (YYYY-MM-DD) with the current server date — use it to compute ' +
  'date ranges for relative expressions. Examples: for "next month" set dueAfter to the first day and dueBefore ' +
  'to the last day of next month; for "this week" use today through today+6 days; for "next 30 days" use today ' +
  'through today+30 days. Always compute and pass explicit YYYY-MM-DD dates — do not ask the user to clarify. ' +
  'Filters: status (todo | in-progress | completed; comma-separated for multiple, e.g. "todo,in-progress"), ' +
  'assignee (person\'s name; comma-separated for multiple, e.g. "Mia,Leo"), ' +
  'priority (low | medium | high | urgent), dueBefore / dueAfter (YYYY-MM-DD), ' +
  'overdue (boolean true) — pass overdue:true to get ONLY overdue tasks; this is the correct filter to use when ' +
  'the user asks "what\'s overdue?", "what\'s past due?", "what\'s late?", or "what hasn\'t been done on time?". ' +
  'completedAfter / completedBefore (YYYY-MM-DD) — filter by WHEN a task was actually completed (completedAt), ' +
  'NOT by the due date. Use completedAfter to answer "what was finished this week / recently / since X". ' +
  'unassigned (true = only tasks with no assignee). ' +
  'IMPORTANT — "unassigned" means no owner/person assigned, NOT status=todo. ' +
  'Use unassigned:true when the user asks what\'s unclaimed, hasn\'t been picked up by anyone, has no owner, or nobody\'s claimed. ' +
  'Do NOT use status:"todo" for ownership questions — status tracks progress (todo/in-progress/completed), assignee tracks who owns it. ' +
  'ASSIGNEE FILTER RULE — Only apply the assignee filter when the user explicitly names a specific person (e.g. "show Mia\'s tasks", "what does Leo have?"). ' +
  'Do NOT add an assignee filter based on who is making the request — the task list is shared across all household members. ' +
  'If the assignee you filtered by is not a known household member, the response will include a hint with the correct member names. ' +
  'CRITICAL — AVOID DOUBLE-COUNTING: `isOverdue` is a boolean flag on each task, NOT a separate status value. ' +
  'An overdue task still has status "todo" or "in-progress". ' +
  'The response includes a `groups` object with pre-computed MUTUALLY EXCLUSIVE buckets: ' +
  '`groups.overdue` (past due, not completed), `groups["in-progress"]` (active, on track), `groups.todo` (not started, on track), `groups.completed`. ' +
  'Each task appears in EXACTLY ONE group. When displaying results in sections, use `groups` directly — ' +
  'NEVER show the same task in both an Overdue section AND an In-Progress or To-Do section.',
  {
    status: z.string().optional().describe('Filter by progress status (todo | in-progress | completed). Comma-separate for multiple. Do NOT use this for "who owns it" questions — use unassigned instead.'),
    assignee: z.string().optional().describe('Filter by assignee name. Comma-separate for multiple, e.g. "Mia,Leo".'),
    priority: z.string().optional().describe('Filter by priority (low | medium | high | urgent).'),
    dueBefore: z.string().optional().describe('Only tasks due on or before this date (YYYY-MM-DD). Filters by dueDate, NOT completion date.'),
    dueAfter: z.string().optional().describe('Only tasks due on or after this date (YYYY-MM-DD). Filters by dueDate, NOT completion date.'),
    completedAfter: z.string().optional().describe('Only tasks actually completed on or after this date (YYYY-MM-DD). Filters by completedAt. Use this (not dueAfter) when the user asks what was finished/completed since a date or "this week".'),
    completedBefore: z.string().optional().describe('Only tasks actually completed on or before this date (YYYY-MM-DD). Filters by completedAt.'),
    overdue: z.boolean().optional().describe('If true, return ONLY overdue tasks (past their due date and not yet completed). Use when the user asks "what is overdue?", "what\'s past due?", "what\'s late?", or "what hasn\'t been done on time?". Can be combined with assignee to get one person\'s overdue tasks.'),
    unassigned: z.boolean().optional().describe('If true, return only tasks with NO assignee (owner). Use when user asks: "what\'s unclaimed", "hasn\'t been picked up by anyone", "no one has taken", "what\'s left for grabs", "has no owner". This is about OWNERSHIP, not progress status.'),
  },
  async ({ status, assignee, priority, dueBefore, dueAfter, completedAfter, completedBefore, overdue, unassigned }) => {
    const result = api.listTasks({ status, assignee, priority, dueBefore, dueAfter, completedAfter, completedBefore, overdue, unassigned });
    // Add pre-computed breakdown so the model never needs to count manually
    const byStatus = {};
    let overdueCount = 0;
    for (const t of result.tasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      if (t.isOverdue) overdueCount++;
    }
    // When multiple assignees are queried, add a per-person breakdown so the model
    // never needs to count individual rows (mis-counting is a common model error)
    let byAssignee;
    if (assignee && assignee.includes(',')) {
      byAssignee = {};
      for (const t of result.tasks) {
        const key = t.assignee || 'unassigned';
        if (!byAssignee[key]) byAssignee[key] = { total: 0, todo: 0, 'in-progress': 0, completed: 0, overdue: 0 };
        byAssignee[key].total++;
        byAssignee[key][t.status] = (byAssignee[key][t.status] || 0) + 1;
        if (t.isOverdue) byAssignee[key].overdue++;
      }
    }

    // Pre-computed mutually exclusive groups — each task appears in EXACTLY ONE bucket.
    // Overdue takes priority: an overdue task goes into groups.overdue, NOT into todo/in-progress.
    // Use these groups when presenting results in sections to avoid double-counting.
    const groups = { overdue: [], 'in-progress': [], todo: [], completed: [] };
    for (const t of result.tasks) {
      if (t.status === 'completed') groups.completed.push(t);
      else if (t.isOverdue) groups.overdue.push(t);
      else if (t.status === 'in-progress') groups['in-progress'].push(t);
      else groups.todo.push(t);
    }

    // If an assignee filter returned no results, hint at the known household members
    let hint;
    if (assignee && result.tasks.length === 0) {
      const allTasks = api.listTasks({}).tasks;
      const members = [...new Set(allTasks.map(t => t.assignee).filter(Boolean))].sort();
      hint = `No tasks found for assignee "${assignee}". Known household members: ${members.join(', ')}. Check spelling or use one of these names.`;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...result,
          byStatus,
          overdueCount,
          groups,
          ...(byAssignee ? { byAssignee } : {}),
          ...(hint ? { hint } : {}),
        }, null, 2),
      }],
    };
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
  'Search tasks by keyword across title, description, tags, AND assignee name. ' +
  'Use this to find a task by a word in its name or description, or to find tasks belonging to someone by name. ' +
  'Combine with dueAfter/dueBefore to answer questions like "garden work due this week" or "house tasks coming up this month". ' +
  'Optionally narrow results further with assignee, status, priority, or date range filters. ' +
  'ASSIGNEE FILTER RULE — Only pass assignee when the user explicitly requests a specific person\'s tasks. ' +
  'Do NOT add an assignee filter based on who is asking — all household tasks are visible to everyone. ' +
  'If the named assignee is not a household member, results will be empty and a hint with known member names will be returned.',
  {
    query: z.string().describe('Search keyword(s) — matched against title, description, tags, and assignee name.'),
    assignee: z.string().optional().describe('Also filter by assignee name.'),
    status: z.string().optional().describe('Also filter by status (todo | in-progress | completed).'),
    priority: z.string().optional().describe('Also filter by priority.'),
    dueAfter: z.string().optional().describe('Only include tasks due on or after this date (YYYY-MM-DD). Use with dueBefore to narrow to a week/month window.'),
    dueBefore: z.string().optional().describe('Only include tasks due on or before this date (YYYY-MM-DD). Use with dueAfter to narrow to a week/month window.'),
  },
  async ({ query, assignee, status, priority, dueAfter, dueBefore }) => {
    const result = api.searchTasks(query, { assignee, status, priority, dueAfter, dueBefore });

    // If an assignee filter returned no results, hint at the known household members
    let hint;
    if (assignee && result.tasks.length === 0) {
      const allTasks = api.listTasks({}).tasks;
      const members = [...new Set(allTasks.map(t => t.assignee).filter(Boolean))].sort();
      hint = `No tasks found for assignee "${assignee}". Known household members: ${members.join(', ')}. Check spelling or use one of these names.`;
    }

    return { content: [{ type: 'text', text: JSON.stringify({ ...result, ...(hint ? { hint } : {}) }, null, 2) }] };
  },
);

server.tool(
  'get_stats',
  'Get aggregate statistics for the whole household: total task count, breakdown by status, overdue count, completion rate, unassigned task count (tasks with no owner), and per-person task counts (topAssignees). ' +
  'Use this to answer questions like "who has the most tasks?", "how many tasks are overdue overall?", or "how many tasks have no owner?"',
  {},
  async () => {
    const stats = api.getStats();
    // Add unassigned count so models can answer ownership questions without a separate list_tasks call
    const allTasks = api.listTasks({}).tasks;
    const unassignedCount = allTasks.filter(t => !t.assignee).length;
    return { content: [{ type: 'text', text: JSON.stringify({ ...stats, unassignedCount }, null, 2) }] };
  },
);

server.tool(
  'get_workload',
  'Get a detailed workload summary for one person: total tasks assigned, count by status (todo / in-progress / completed), ' +
  'list of overdue tasks, and tasks due within the next 7 days. ' +
  'Use the optional priority filter to narrow results to a specific urgency level (e.g. "urgent", "high"). ' +
  'Use this to answer questions like "what does Mia have on her plate?", "how busy is Alex?", or "what urgent things does Leo have?"',
  {
    assignee: z.string().describe('Name of the person whose workload to retrieve (e.g. "Alex", "Mia").'),
    priority: z.string().optional().describe(
      'Only include tasks at this priority level: low | medium | high | urgent. ' +
      'Set this when the user asks about urgent/high/specific-priority tasks for a person.'
    ),
  },
  async ({ assignee, priority }) => {
    const workload = api.getAssigneeWorkload(assignee, { priority });
    return { content: [{ type: 'text', text: JSON.stringify(workload, null, 2) }] };
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
  'Update any field of an existing task. Use this to: reassign a task to someone else (set assignee), ' +
  'mark a task complete (set status to "completed"), change priority, update the due date, rename it, or edit its description/tags. ' +
  'Only supply the fields you want to change — omitted fields are left unchanged. ' +
  'Identify the task by id (exact task ID) OR by query (words from the task title — the best match is used). ' +
  'Prefer query when you only know the task name; prefer id only when you have already confirmed the exact ID from a prior search result.',
  {
    id: z.string().optional().describe('Task ID to update. Use this OR query — not both. Only use if you already have the confirmed task ID from a prior search result.'),
    query: z.string().optional().describe(
      'Words from the task title to find the task (e.g. "passport renewal", "grocery run", "lawn mowing"). ' +
      'The best-matching task is updated. Use this instead of id when you only know the task name. ' +
      'If the search returns a completed task when you expected an open one, the response will include a warning — check it.'
    ),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description'),
    status: z.string().optional().describe('New status'),
    priority: z.string().optional().describe('New priority'),
    assignee: z.string().optional().describe('New assignee'),
    dueDate: z.string().optional().describe('New due date'),
    tags: z.array(z.string()).optional().describe('New tags'),
  },
  async ({ id, query, title, description, status, priority, assignee, dueDate, tags }) => {
    // Resolve task by query if id not provided
    if (!id && query) {
      const searchResult = api.searchTasks(query, {});
      if (!searchResult.tasks.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `No task found matching: "${query}"` }) }],
          isError: true,
        };
      }
      // Prefer the first non-completed match so we don't accidentally update a closed task
      const openMatch = searchResult.tasks.find(t => t.status !== 'completed');
      const matched = openMatch || searchResult.tasks[0];
      id = matched.id;
    }

    if (!id) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Provide either id or query to identify the task to update.' }) }],
        isError: true,
      };
    }

    const existing = api.getTask(id);
    if (!existing.found) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Task not found: ${id}` }) }], isError: true };
    }

    const fields = { title, description, status, priority, assignee, dueDate, tags };
    const changes = {};
    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) changes[key] = val;
    }

    const result = api.updateTask(id, changes);

    // Surface a warning when the caller unknowingly updated an already-completed task
    const warnings = [];
    if (existing.status === 'completed' && !changes.status) {
      warnings.push(`WARNING: Task "${existing.title}" (${id}) was already completed before this update. If you meant a different task, search again with a more specific query.`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ ...result, ...(warnings.length ? { warnings } : {}) }, null, 2),
      }],
    };
  },
);

server.tool(
  'reassign_task',
  'Reassign a task to a different household member. ' +
  'Identify the task by id (task ID) OR by query (words from the task title — the best match is used automatically). ' +
  'If no assignee is given, automatically selects the household member with the fewest open (non-completed) tasks — ' +
  'excluding the current assignee. ' +
  'Use this for: "transfer X to Y", "give X to Y", "X should do Y instead of Z", ' +
  '"Y shouldn\'t have to do X", "can someone else do X", "take X off my plate", or any reassignment with or without a named person. ' +
  'You do NOT need to call search_tasks first — pass query to search and reassign in one step.',
  {
    id: z.string().optional().describe('Task ID to reassign. Use this OR query (not both).'),
    query: z.string().optional().describe(
      'Search words from the task title (e.g. "lawn mowing", "groceries", "dishes"). ' +
      'The best-matching task is reassigned. Use this instead of id when you only know the task name.'
    ),
    assignee: z.string().optional().describe(
      'Who to reassign the task to. Omit to auto-assign to the least-busy household member.'
    ),
  },
  async ({ id, query, assignee }) => {
    // Resolve task by query if id not provided
    if (!id && query) {
      const searchResult = api.searchTasks(query, {});
      if (!searchResult.tasks.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `No task found matching: "${query}"` }) }],
          isError: true,
        };
      }
      id = searchResult.tasks[0].id;
    }

    if (!id) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Provide either id or query to identify the task.' }) }],
        isError: true,
      };
    }

    const task = api.getTask(id);
    if (!task.found) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Task not found: ${id}` }) }], isError: true };
    }

    let newAssignee = assignee;
    if (!newAssignee) {
      // Auto-pick: household member with fewest open tasks (excluding current assignee)
      const allTasks = api.listTasks({}).tasks;
      const openCounts = {};
      for (const t of allTasks) {
        if (t.assignee && t.status !== 'completed') {
          openCounts[t.assignee] = (openCounts[t.assignee] || 0) + 1;
        }
        // Ensure members with 0 open tasks still appear if they have any tasks at all
        else if (t.assignee && !openCounts[t.assignee]) {
          openCounts[t.assignee] = 0;
        }
      }
      const currentAssignee = (task.assignee || '').toLowerCase();
      const candidates = Object.entries(openCounts)
        .filter(([name]) => name.toLowerCase() !== currentAssignee)
        .sort((a, b) => a[1] - b[1]);
      if (candidates.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'No other household members found to reassign to.' }) }],
          isError: true,
        };
      }
      newAssignee = candidates[0][0];
    }

    const result = api.updateTask(id, { assignee: newAssignee });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ ...result, previousAssignee: task.assignee, reassignedTo: newAssignee }, null, 2),
      }],
    };
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
