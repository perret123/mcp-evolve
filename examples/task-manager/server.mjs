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

/** Priority ranking — higher number = higher priority. */
const PRIORITY_RANK = { urgent: 4, high: 3, medium: 2, low: 1 };

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
- Statuses: "todo", "in_progress", "completed" (aliases like "pending", "done" are accepted but always normalized internally).
- Priorities (ranked low → urgent): "low" < "medium" < "high" < "urgent". list_tasks results are sorted highest priority first.
- Assignees: Alex, Sam, Mia, Leo, or unassigned.
- Tags: home, health, finance, errands, kids, garden, family, car, school.

Critical rules:
1. **GROUND ANSWERS IN TOOL DATA ONLY.** Never include task names, dates, or details that don't appear in tool results. If a tool returns an empty array or zero results, say so — do NOT guess or fabricate tasks. If results are truncated, make additional calls (with offset) to get the remaining data before answering.
2. **"All active tasks" → ONE call with excludeStatus="completed".** This is the #1 source of wasted calls. When asked for everything someone is working on, all their tasks, what's on their plate, or tasks that aren't done:
   - ✅ CORRECT: list_tasks(assignee="Sam", excludeStatus="completed") → 1 call
   - ❌ WRONG: list_tasks(assignee="Sam", status="todo") + list_tasks(assignee="Sam", status="in_progress") → 2+ calls, AND misses edge-case statuses
   For MULTIPLE people (e.g. "the kids' tasks"), call once PER PERSON with excludeStatus="completed":
   - ✅ CORRECT: list_tasks(assignee="Mia", excludeStatus="completed") + list_tasks(assignee="Leo", excludeStatus="completed") → 2 calls
   - ❌ WRONG: calling per-person per-status → 4-6 calls
3. **OVERDUE queries → overdue=true.** To find overdue tasks, use list_tasks with overdue=true. NEVER use dueBefore — it returns tasks of ALL statuses including completed.
4. **Tag/status/assignee filtering → list_tasks, NOT search_tasks.** search_tasks is ONLY for freeform keyword lookups when you don't know which field to filter by. For known tags/assignees/statuses, list_tasks is faster and more reliable.
5. **search_tasks is substring-based.** "cook" matches "cooking". Use ONE broad query, not multiple narrow variants.
6. **Batch updates → update ALL matching items.** When asked to update "all tasks that match X", first list ALL matches, then update_task once for EACH.
7. **Ties → acknowledge and explain.** When asked for "the highest priority" and multiple tasks tie, say so.
8. **Combine filters** in a single list_tasks call (e.g. assignee + excludeStatus + tag) rather than making multiple calls.
9. **Use get_stats** for quick overdue counts, status breakdowns, or completion rates — it returns byStatus, overdue count, completionRate, and topAssignees without listing individual tasks.`,
});

// --- Read Tools ---

server.tool(
  'list_tasks',
  `List tasks with optional filters. Combine filters in ONE call (e.g. assignee + excludeStatus + tag).

⚠️ MOST IMPORTANT — read before calling:
• "All tasks" / "on their plate" / "current tasks" → ONE call with excludeStatus="completed". NEVER make separate calls for "todo" and "in_progress".
  Example: Mia's active tasks = list_tasks(assignee="Mia", excludeStatus="completed") — ONE call, not two.
  Example: Both kids = TWO calls max (one per child with excludeStatus="completed"), not six.
• "Overdue" → ONE call with overdue=true. Do NOT use dueBefore.
• Tag/assignee/status filtering → use list_tasks filters, not search_tasks.

Results sorted by priority (urgent→low), then due date. Paginated (default limit=50, check "hasMore").`,
  {
    overdue: z.boolean().optional().describe('**Use this for overdue queries.** Set to true to return ONLY tasks that are past due AND not completed. This is the correct way to answer "what is overdue?" — do NOT use dueBefore for overdue queries.'),
    status: z.string().optional().describe('Filter to ONE specific status: "todo", "in_progress", or "completed". Aliases accepted (e.g. "pending"→todo, "done"→completed). ⚠️ STOP: If you need "all active tasks", do NOT call once with status="todo" then again with status="in_progress" — use excludeStatus="completed" instead (ONE call).'),
    excludeStatus: z.string().optional().describe('★ PREFERRED for "active tasks" queries. excludeStatus="completed" returns ALL non-completed tasks in ONE call. Use this for: "what\'s on their plate", "current tasks", "tasks that aren\'t done". Values: "todo", "in_progress", "completed" (aliases accepted).'),
    assignee: z.string().optional().describe('Filter by person assigned. Known assignees: Alex, Sam, Mia, Leo. Case-sensitive.'),
    priority: z.string().optional().describe('Filter by priority level: "low", "medium", "high", or "urgent".'),
    tag: z.string().optional().describe('Filter by tag. Known tags: home, health, finance, errands, kids, garden, family, car, school. Returns only tasks that have this tag. Case-sensitive.'),
    dueBefore: z.string().optional().describe('Due date upper bound (YYYY-MM-DD). WARNING: Returns tasks of ALL statuses including completed — NOT suitable for finding overdue tasks. Use "overdue=true" instead.'),
    dueAfter: z.string().optional().describe('Due date lower bound (YYYY-MM-DD). Returns tasks of ALL statuses including completed.'),
    limit: z.number().optional().describe('Max results per page (default 50). Response includes "hasMore" boolean — if true, increase offset to get next page.'),
    offset: z.number().optional().describe('Skip N tasks for pagination (default 0). Use when "hasMore" is true in a previous response.'),
  },
  async ({ status, excludeStatus, assignee, priority, tag, dueBefore, dueAfter, overdue, limit, offset }) => {
    let tasks = loadTasks();
    const normalizedStatus = normalizeStatus(status);
    const normalizedExcludeStatus = normalizeStatus(excludeStatus);

    if (overdue === true) {
      const now = new Date().toISOString().slice(0, 10);
      tasks = tasks.filter(t => t.status !== 'completed' && t.dueDate && t.dueDate < now);
    }
    if (normalizedStatus !== undefined) {
      tasks = tasks.filter(t => t.status === normalizedStatus);
    }
    if (normalizedExcludeStatus !== undefined) {
      tasks = tasks.filter(t => t.status !== normalizedExcludeStatus);
    }
    if (assignee !== undefined) {
      tasks = tasks.filter(t => t.assignee === assignee);
    }
    if (priority !== undefined) {
      tasks = tasks.filter(t => t.priority === priority);
    }
    if (tag !== undefined) {
      tasks = tasks.filter(t => t.tags && t.tags.includes(tag));
    }
    if (dueBefore !== undefined) {
      tasks = tasks.filter(t => t.dueDate && t.dueDate <= dueBefore);
    }
    if (dueAfter !== undefined) {
      tasks = tasks.filter(t => t.dueDate && t.dueDate >= dueAfter);
    }

    // Sort by priority (urgent first) then by due date (earliest first) for deterministic ordering.
    tasks.sort((a, b) => {
      const pa = PRIORITY_RANK[a.priority] ?? 0;
      const pb = PRIORITY_RANK[b.priority] ?? 0;
      if (pb !== pa) return pb - pa;               // higher priority first
      // secondary: earliest due date first (null dates sort last)
      if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    });

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
  `Freeform SUBSTRING search across task titles, descriptions, and tags. The query is matched as a substring (case-insensitive), so "cook" matches "cooking class" and "cookbook". Use broad root words to maximize matches — one call with "cook" is better than separate calls for "cooking" and "meals".

Returns paginated results (default limit=50, check "hasMore"). Fetch ALL pages before acting on results.

⚠️ Do NOT use for structured filtering. If you know the tag, assignee, status, or priority, use list_tasks instead.`,
  {
    query: z.string().describe('Search keyword (case-insensitive substring match). Matches against title, description, and tags. Use broad root words: "cook" matches "cooking", "garden" matches "gardening". One broad query is better than multiple narrow ones.'),
    limit: z.number().optional().describe('Max results per page (default 50). Response includes "hasMore" boolean — if true, increase offset to get next page.'),
    offset: z.number().optional().describe('Skip N results for pagination (default 0). Use when "hasMore" is true in a previous response.'),
  },
  async ({ query, limit, offset }) => {
    const tasks = loadTasks();
    const q = query.toLowerCase();
    const matches = tasks.filter(t =>
      t.title.toLowerCase().includes(q) ||
      (t.description && t.description.toLowerCase().includes(q)) ||
      (t.tags && t.tags.some(tag => tag.toLowerCase().includes(q)))
    );

    // Sort by priority (urgent first) then by due date (earliest first) for deterministic ordering.
    matches.sort((a, b) => {
      const pa = PRIORITY_RANK[a.priority] ?? 0;
      const pb = PRIORITY_RANK[b.priority] ?? 0;
      if (pb !== pa) return pb - pa;
      if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return 0;
    });

    const totalMatches = matches.length;
    const effectiveOffset = offset ?? 0;
    const effectiveLimit = limit ?? 50;
    const page = matches.slice(effectiveOffset, effectiveOffset + effectiveLimit);

    const summaries = page.map(t => ({
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
      total: totalMatches,
      offset: effectiveOffset,
      limit: effectiveLimit,
      hasMore: effectiveOffset + effectiveLimit < totalMatches,
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_stats',
  'Get summary statistics for the entire task list: total count, breakdown by status (byStatus), overdue count, completion rate (%), and top assignees ranked by task count. Use this for quick counts and overviews instead of listing all tasks. No parameters needed.',
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
    const normStatus = status !== undefined ? normalizeStatus(status) : undefined;
    const fields = { title, description, status: normStatus, priority, assignee, dueDate, tags };

    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) {
        task[key] = val;
      }
    }

    // Set completedAt when marking as completed, clear it when moving away
    if (normStatus === 'completed') {
      task.completedAt = new Date().toISOString();
    } else if (normStatus !== undefined && normStatus !== 'completed') {
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
    // PLANTED BUG: filters and saves regardless of whether task existed — always returns success
    const filtered = tasks.filter(t => t.id !== id);
    saveTasks(filtered);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, id }) }] };
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
