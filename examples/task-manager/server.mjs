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
  instructions: `A family task manager for Alex's household (members: Alex, Sam, Mia, Leo). Use these tools to look up, create, and manage to-do items for the whole family. To see what's on someone's plate (their tasks), use list_tasks with the assignee filter.

Read tools: list_tasks (filtered listing — use assignee filter to find a person's tasks), get_task (single task detail), search_tasks (text keyword search), get_stats (aggregate counts only).
Write tools: create_task, update_task, delete_task.

list_tasks: omit filters to get all tasks. Most filters accept one value — to get tasks across multiple statuses (e.g. todo + in_progress), either omit the status filter and filter from the response, or make separate calls. Exception: the tag filter accepts comma-separated values with OR logic — e.g. tag: "health,family" returns tasks with either tag in one call. Use this when the user mentions multiple categories.
Overdue tasks: call list_tasks with overdue set to true. This returns only non-completed tasks past their due date — the server computes today's date automatically. Combine with assignee to find one person's overdue tasks. One call is enough.
Incomplete tasks: omit the status filter entirely, then keep only tasks where status is "todo" or "in_progress" from the response. Do NOT make separate calls per status.
search_tasks: full-text search of title/description/tags — returns summaries (same fields as list_tasks). Best for finding a specific known task by keyword (e.g. "electric", "garden"). For broad topic queries (e.g. "anything related to cooking or meals"), do NOT call search_tasks many times with different synonyms — one list_tasks call without filters is more complete than 5+ search attempts, because search only matches exact substrings and will miss tasks using different wording. Limit search_tasks to at most 2 calls per user request; if those don't cover it, switch to list_tasks. IMPORTANT: search_tasks matches text content, NOT ownership. A task titled "Help Mia with X" assigned to Alex will match a search for "Mia" even though it's Alex's task. To find a person's tasks (tasks assigned to them), use list_tasks with the assignee filter — do NOT use search_tasks with their name.
get_task: only needed when you require the description or completedAt fields. list_tasks and search_tasks already return id, title, status, priority, assignee, dueDate, and tags.
get_stats: returns aggregate counts only (total, by status, overdue count, completion rate). To see individual overdue tasks, use list_tasks with overdue set to true instead.

"[Person]'s tasks" means tasks where assignee = that person. Always use list_tasks with the assignee filter for this — never search_tasks with the person's name, because search matches any mention in title/description (e.g. "Help Mia with X" assigned to Alex is NOT Mia's task).

When the user asks to DO something (mark complete, reassign, change priority, delete, create), you MUST call the appropriate write tool. Reading tasks is not enough — execute the change with update_task, create_task, or delete_task. For batch updates (e.g. "mark Mia's school tasks as completed", "reassign all of Sam's errands to Alex"): (1) call list_tasks with the right filters (assignee, tag, etc.) to find matching tasks, (2) call update_task once per task with the desired changes. Do NOT stop after the list step — the update is not done until you call update_task on each task. For delete requests: (1) search/list to find the task ID — search results include assignee so you can verify ownership in one step, (2) call delete_task with the ID. Do not stop after step 1 — the task is not deleted until you call delete_task. When search returns exactly one result with a closely matching title, proceed with the delete — do NOT ask for confirmation even if the assignee differs from the requesting user (the user may have created a task for someone else, or it may have been reassigned). Only ask for confirmation when multiple tasks match and it is genuinely unclear which one the user means. Do NOT silently skip the delete or make extra read calls. One search call is enough to find candidates.

Relative date interpretation: "next [weekday]" always means the occurrence of that day in the FOLLOWING week, not the nearest upcoming one. For example, if today is Monday April 6, "next Wednesday" = April 15 (Wednesday of next week), NOT April 8. The nearest upcoming occurrence would be "this Wednesday". Similarly, "next Monday" said on a Monday means the Monday 7 days later. Always compute dates carefully using this rule before passing YYYY-MM-DD to tools.

Mixed read+write requests (e.g. "show me X tasks and assign the unassigned ones to me"): search_tasks and list_tasks results already include assignee, status, and priority — use those summary fields to identify which tasks need modification, then call update_task immediately with the IDs from the results. Do NOT wait until you have called get_task on every result before starting writes. The writes are the primary goal; get_task is only for extra detail like descriptions.`,
});

// --- Read Tools ---

server.tool(
  'list_tasks',
  'Look up family household tasks (to-dos). This is the primary tool for finding what\'s on someone\'s plate — use assignee filter to see all tasks belonging to a specific person (e.g. assignee="Alex" for Alex\'s tasks). Returns summaries (id, title, status, priority, assignee, dueDate, tags). Omit all filters to get every task. Filters combine with AND logic. Most filters accept a single value; the tag filter accepts comma-separated values for OR matching (e.g. tag: "health,family" returns tasks with either tag). To find overdue tasks: set overdue to true — this automatically finds non-completed tasks past their due date (no need to know today\'s date or do any client-side filtering). Combine overdue with assignee to find a specific person\'s overdue tasks (e.g. list_tasks(overdue: true, assignee: "Alex")). To find all incomplete tasks for a person: set assignee and omit status, then keep todo/in_progress from the response. Combine assignee + tag to find a person\'s tasks in a category — e.g. list_tasks(assignee: "Mia", tag: "school") returns all of Mia\'s school tasks. Add a status filter for a specific status, or omit status to get all statuses (then filter the response). To find unassigned tasks (not given to anyone): set assignee to "none" or "unassigned". This is a read-only tool — after finding tasks, call update_task with each task\'s ID to modify them (e.g. mark complete, reassign, change priority). CRITICAL: "my tasks" always means tasks assigned to the CURRENT USER (the person asking), even when someone else performed an action on them. Example: if Mia says "Alex marked my tasks done", search assignee="Mia" (the owner), NOT assignee="Alex" (who changed them). The assignee field is the task OWNER, not who last modified it.',
  {
    status: z.string().optional().describe('Filter by a single status: "todo", "in_progress", or "completed". Omit to return all statuses — then filter the response client-side. For incomplete tasks, omit this and keep todo/in_progress from the response (do NOT make separate calls per status).'),
    assignee: z.string().optional().describe('Filter by a single person name (e.g. "Alex", "Sam", "Mia", "Leo"), or "none" (or "unassigned") to find tasks not given to anyone. Omit to return all assignees.'),
    priority: z.string().optional().describe('Filter by a single priority: "low", "medium", "high", or "urgent". Omit to return all priorities.'),
    dueBefore: z.string().optional().describe('Due date upper bound (YYYY-MM-DD). Tasks with dueDate on or before this date. For date range queries, combine with dueAfter.'),
    dueAfter: z.string().optional().describe('Due date lower bound (YYYY-MM-DD). Use with dueBefore to get a date range.'),
    tag: z.string().optional().describe('Filter by tag(s). Pass a single tag (e.g. "school") or multiple comma-separated tags for OR matching (e.g. "health,family" returns tasks tagged with health OR family). Tasks must have at least one of the specified tags in their tags array.'),
    overdue: z.boolean().optional().describe('Set to true to find overdue tasks — non-completed tasks whose due date is before today. The server computes today\'s date automatically. Combine with assignee to find a specific person\'s overdue tasks. When true, the status filter is ignored (overdue tasks are always non-completed).'),
  },
  async ({ status, assignee, priority, dueBefore, dueAfter, tag, overdue }) => {
    let tasks = loadTasks();

    if (overdue) {
      const today = new Date().toISOString().slice(0, 10);
      tasks = tasks.filter(t => t.status !== 'completed' && t.dueDate && t.dueDate < today);
    } else if (status !== undefined) {
      tasks = tasks.filter(t => t.status === status);
    }
    if (assignee !== undefined) {
      const a = assignee.toLowerCase();
      if (a === 'none' || a === 'unassigned') {
        tasks = tasks.filter(t => !t.assignee);
      } else {
        tasks = tasks.filter(t => t.assignee && t.assignee.toLowerCase() === assignee.toLowerCase());
      }
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
    if (tag !== undefined) {
      const tagList = tag.split(',').map(t => t.trim().toLowerCase());
      tasks = tasks.filter(t => t.tags && t.tags.some(tt => tagList.includes(tt.toLowerCase())));
    }

    const summaries = tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee: t.assignee,
      dueDate: t.dueDate,
      tags: t.tags,
    }));

    // Build a status breakdown for the summary header
    const statusBreakdown = {};
    for (const t of summaries) {
      statusBreakdown[t.status] = (statusBreakdown[t.status] || 0) + 1;
    }

    const header = {
      totalResults: summaries.length,
      statusBreakdown,
    };

    return { content: [{ type: 'text', text: JSON.stringify({ summary: header, tasks: summaries }, null, 2) }] };
  },
);

server.tool(
  'get_task',
  'Get full details for a single family household task by its ID. Returns all fields including description and completedAt. Only needed when you require the description or completedAt — list_tasks and search_tasks already return id, title, status, priority, assignee, dueDate, and tags.',
  { id: z.string().describe('Task ID (e.g. "task-001")') },
  async ({ id }) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === id);
    if (!task) {
      return { content: [{ type: 'text', text: `Task not found: ${id}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
  },
);

server.tool(
  'search_tasks',
  'Search family household tasks by keyword. Full-text search across task title, description, and tags. Returns matching task summaries with the same fields as list_tasks (id, title, status, priority, assignee, dueDate, tags) — no need to call list_tasks after searching. Matches a single substring per call (case-insensitive). Use short, single-word keywords for best results (e.g. "electric" not "pay electric bill", "garden" not "garden project tasks"). If search returns no results, the task likely doesn\'t exist or uses different wording — do NOT retry with variations. Instead, try list_tasks without filters and scan the full list, or inform the user. For broad/conceptual queries (e.g. "anything about cooking", "tasks related to health"): prefer list_tasks without filters over multiple search calls. Scanning the full list catches tasks that use unexpected wording; repeated search calls with synonyms will miss them. Limit yourself to at most 2 search_tasks calls per user request — if those are insufficient, switch to list_tasks. IMPORTANT: this searches text content, NOT ownership. Searching for a person\'s name (e.g. "Mia") returns tasks that MENTION that name anywhere in the title or description — these are NOT necessarily assigned to that person. For example, "Help Mia with science project" assigned to Alex would match a search for "Mia" even though it is Alex\'s task. To find tasks belonging to / assigned to a specific person, use list_tasks with the assignee filter instead. For filtering by specific fields (status, assignee, priority, date range), use list_tasks instead. For destructive actions (delete, reassign): if search returns exactly one result with a closely matching title, proceed with the action — do NOT ask for confirmation even if the assignee differs from the requesting user (the user may have created a task for someone else, or it may have been reassigned). Only ask for confirmation when multiple tasks match and it is genuinely unclear which one the user means. Do NOT silently skip the action or make extra read calls to "confirm". Compound filter workflow — to find a person\'s tasks matching a keyword AND a specific status (e.g. "Mia\'s completed school tasks"): (1) search_tasks("school"), (2) filter results where assignee === "Mia" AND status === "completed", (3) use matching task IDs for update_task calls. This two-step pattern (search then filter) is the standard way to combine text search with field filters.',
  { query: z.string().describe('Search query (case-insensitive substring match)') },
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

    // Build a status breakdown for the summary header
    const statusBreakdown = {};
    for (const t of summaries) {
      statusBreakdown[t.status] = (statusBreakdown[t.status] || 0) + 1;
    }

    const header = {
      totalResults: summaries.length,
      statusBreakdown,
    };

    return { content: [{ type: 'text', text: JSON.stringify({ summary: header, tasks: summaries }, null, 2) }] };
  },
);

server.tool(
  'get_stats',
  'Get aggregate statistics for the family household task list: total tasks, counts by status, overdue count, completion rate, and top 5 assignees by task count.',
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
  'Create a new task with auto-generated ID. Returns the full task object. IMPORTANT — relative dates: before passing dueDate, compute the exact YYYY-MM-DD. "Next [weekday]" = that day in the FOLLOWING week (7-13 days away), never the nearest occurrence (1-6 days away). Step-by-step: (1) find what day of the week today is, (2) "next Wednesday" from Monday = skip this Wednesday, go to NEXT week\'s Wednesday. Example: Monday April 6 → "next Wednesday" = April 15, NOT April 8.',
  {
    title: z.string().describe('Task title'),
    description: z.string().optional().describe('Task description'),
    assignee: z.string().optional().describe('Person assigned to the task'),
    dueDate: z.string().optional().describe('Due date in YYYY-MM-DD format. STOP and compute carefully for relative dates. "next [weekday]" = the FOLLOWING week (7-13 days ahead), NOT the nearest upcoming occurrence (1-6 days). "This [weekday]" or just "[weekday]" = nearest upcoming. Example: today is Monday April 6 → "next Wednesday" = April 15 (skip this week\'s Wed), "this Wednesday" = April 8. Count the days to verify before calling.'),
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
  'Update a task. Use this to modify any task field. You can change multiple fields in a single call. Common actions: assign or reassign a task (set assignee), mark complete (status: "completed"), REOPEN/undo a completed task (set status back to "todo" — this clears completedAt automatically), change priority, update due dates, edit tags. Only provide fields you want to change — omitted fields stay the same. Call once per task you need to update. Example — mark complete: {"id": "task-042", "status": "completed"}. Example — reopen: {"id": "task-042", "status": "todo", "dueDate": "2026-04-10"}. BATCH MARK COMPLETE — step by step (e.g. "mark Mia\'s school tasks as completed", "mark all of Sam\'s errands done"): STEP 1: call list_tasks with assignee and tag filters to find the tasks — e.g. list_tasks(assignee: "Mia", tag: "school"). Omit the status filter to get all of them, then keep only tasks where status is "todo" or "in_progress" (skip already-completed ones). STEP 2: collect all non-completed task IDs from the results. STEP 3: call update_task ONCE PER TASK with status: "completed" — e.g. {"id": "task-073", "status": "completed"}. Repeat for every task that isn\'t already completed. There is no batch endpoint — call update_task once per task. Do NOT skip any matched task. BATCH REOPEN + RESCHEDULE — step by step (e.g. "someone marked my school tasks done but I didn\'t finish them, set them back to todo with new due dates"): CRITICAL: "my tasks" = tasks assigned to the CURRENT USER, even if someone else marked them done. If Mia says "Alex marked my tasks done", search assignee="Mia" NOT "Alex". STEP 1: call list_tasks with the CURRENT USER as assignee, status "completed", and the relevant tag — e.g. list_tasks(assignee: "Mia", status: "completed", tag: "school"). STEP 2: collect all task IDs from the results. STEP 3: call update_task ONCE PER TASK with BOTH status and dueDate in the same call — e.g. {"id": "task-078", "status": "todo", "dueDate": "2026-04-10"}. Repeat for every matched task. IMPORTANT: when looking for tasks by assignee, the filter is case-insensitive — "mia" matches "Mia".',
  {
    id: z.string().describe('Task ID to update (e.g. "task-042")'),
    title: z.string().optional().describe('New title for the task'),
    description: z.string().optional().describe('New description text'),
    status: z.string().optional().describe('New status: "todo", "in_progress", or "completed"'),
    priority: z.string().optional().describe('New priority: "low", "medium", "high", or "urgent"'),
    assignee: z.string().optional().describe('Person name to assign the task to (e.g. "Ruth", "Alex"). Set this to assign unassigned tasks or reassign existing ones.'),
    dueDate: z.string().optional().describe('New due date in YYYY-MM-DD format. STOP and compute carefully for relative dates. "next [weekday]" = the FOLLOWING week (7-13 days ahead), NOT the nearest upcoming occurrence (1-6 days). "This [weekday]" or just "[weekday]" = nearest upcoming. Example: today is Monday April 6 → "next Wednesday" = April 15 (skip this week\'s Wed), "this Wednesday" = April 8. Count the days to verify before calling.'),
    tags: z.array(z.string()).optional().describe('New set of tags (replaces existing tags)'),
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

    // Set completedAt timestamp when task is marked as completed
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
  'Permanently delete a task by ID. Workflow: (1) search_tasks or list_tasks to find the task ID, (2) call delete_task with that ID. Do NOT stop after step 1 — the deletion is not done until you call this tool. When search returns exactly one result with a closely matching title, proceed with the deletion — do NOT ask for confirmation, even if the assignee differs from the requesting user. The user may have created a task assigned to someone else, or the task may have been reassigned since. Only ask for confirmation when multiple tasks match and it is genuinely unclear which one the user means. If no match at all is found, inform the user — but do NOT make additional read calls beyond the initial search/list.',
  { id: z.string().describe('Task ID to delete (e.g. "task-001")') },
  async ({ id }) => {
    const tasks = loadTasks();
    const exists = tasks.some(t => t.id === id);
    if (!exists) {
      return { content: [{ type: 'text', text: `Task not found: ${id}` }], isError: true };
    }
    const filtered = tasks.filter(t => t.id !== id);
    saveTasks(filtered);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, id }) }] };
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
