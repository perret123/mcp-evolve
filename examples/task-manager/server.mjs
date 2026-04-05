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
- Statuses: "todo", "in_progress", "completed" (aliases like "pending", "done" are accepted but always normalized internally). These are the ONLY statuses — there are no "blocked", "waiting", or "on_hold" statuses.
- Priorities (ranked low → urgent): "low" < "medium" < "high" < "urgent". list_tasks results are sorted highest priority first.
- Assignees: Alex, Sam, Mia, Leo, or unassigned.
- Tags: home, health, finance, errands, kids, garden, family, car, school.

Critical rules:
1. **GROUND ANSWERS IN TOOL DATA ONLY.** Never include task names, dates, or details that don't appear in tool results. If a tool returns an empty array or zero results, say "no matching tasks found" — do NOT guess, fabricate, or extrapolate tasks that might exist. This applies even when the user expects a certain answer (e.g. "fun stuff coming up" → if no fun tasks exist, say so honestly). If results are truncated, make additional calls (with offset) to get the remaining data before answering.
2. **"All active tasks" → use excludeStatus="completed".** When asked for everything someone is working on, what's on their plate, or tasks that aren't done, use excludeStatus="completed" to get all non-completed tasks regardless of specific status.
3. **OVERDUE queries → overdue=true.** To find overdue tasks, use list_tasks with overdue=true. NEVER use dueBefore — it returns tasks of ALL statuses including completed.
4. **Tag filtering → list_tasks(tag=...), NOT search_tasks.** Known tags are: home, health, finance, errands, kids, garden, family, car, school. If the user asks about any of these, use list_tasks with the tag filter — do NOT call search_tasks. search_tasks is ONLY for freeform keyword lookups when you don't know which field to filter by (e.g. "cooking", "birthday", or other words that aren't known tags/assignees/statuses).
5. **search_tasks is substring-based.** "cook" matches "cooking", "meal" matches "meals". Start with a broad root word. If few/no results, try synonyms — e.g. "cook" then "meal" then "food".
6. **Batch updates → update ALL matching items.** When asked to update "all tasks that match X", first list ALL matches, then update_task once for EACH. The task is NOT done until the write calls are made.
7. **Ties → acknowledge and explain.** When asked for "the highest priority" and multiple tasks tie, say so.
8. **ACTION REQUESTS require thorough search before giving up.** When asked to update/move/delete tasks and your first query returns 0 results, you MUST broaden the search before concluding no tasks exist:
   - Drop the assignee filter (tasks "about" Mia may be assigned to Alex)
   - Drop the tag filter (school tasks might not be tagged "school")
   - Try search_tasks with the person's name or keyword
   - Check the "hint" field in list_tasks responses — it flags tasks that mention the person by name
   Only after 2-3 search strategies return nothing can you report "no matching tasks found". A single narrow query returning 0 is NOT sufficient for action requests.
9. **Filters can be combined** in a single list_tasks call (e.g. assignee + excludeStatus + tag).
10. **Use get_stats for counting/comparison questions** — "who has the most tasks?", "what's the completion rate?", "how many are overdue?", "workload breakdown", "task distribution". It returns byStatus, overdue count, completionRate, and topAssignees without listing individual tasks. Do NOT call list_tasks per-person to count tasks when get_stats already provides this.
11. **list_tasks priority filter is single-value.** It accepts ONE priority at a time. To get tasks across 2 priority levels (e.g. "high and urgent"), make 2 calls — one per priority. This is the correct approach.
12. **CATEGORY queries → use TAG filters, NOT assignee.** "Kids' school tasks", "garden stuff", "health-related tasks" are CATEGORY queries — use list_tasks({tag: 'school'}), list_tasks({tag: 'garden'}), etc. Do NOT filter by assignee for these. Tasks ABOUT kids/school may be assigned to any family member (e.g. "Help Mia with science project" is assigned to Alex, not Mia). Only use assignee filter when the user asks about a SPECIFIC PERSON's workload (e.g. "what's on Sam's plate?").
13. **"Can we…", "Let's…", "I want to…" = ACTION REQUESTS — execute writes.** When the user says "Can we bump up the priority?", "Let's move these to next week", or "I want to reassign these" — they are asking you to DO IT. Find the matching tasks, then call update_task for EACH one. Do NOT just list tasks and ask "shall I proceed?" — the user already gave you the go-ahead.`,
});

// --- Read Tools ---

server.tool(
  'list_tasks',
  `List tasks with optional filters. Filters can be combined (e.g. assignee + excludeStatus + tag).

Tips:
• Use excludeStatus="completed" for "all active/current/not-done tasks".
• Use overdue=true for overdue tasks (not dueBefore, which includes completed).
• Use tag filter for known tags (garden, school, etc.) — more reliable than search_tasks.
• For CATEGORY queries ("kids' school tasks", "garden stuff"), use the TAG filter — NOT the assignee filter. Tasks about kids/school/garden may be assigned to ANY family member. Example: "kids' school tasks" → list_tasks({tag: 'school', excludeStatus: 'completed'}) finds ALL school tasks regardless of who's assigned.

Results sorted by priority (urgent→low), then due date. Paginated (default limit=50, check "hasMore").

💡 "Someone's tasks" can mean tasks ASSIGNED to them OR tasks ABOUT them (mentioned in title/description but assigned to another family member). When assignee + other filters return 0 results, the response may include a "hint" field listing tasks that mention the person — follow the hint to broaden your search before concluding no tasks exist.`,
  {
    overdue: z.boolean().optional().describe('**Use this for overdue queries.** Set to true to return ONLY tasks that are past due AND not completed. This is the correct way to answer "what is overdue?" — do NOT use dueBefore for overdue queries.'),
    status: z.string().optional().describe('Filter by status: "todo", "in_progress", or "completed". Aliases accepted (e.g. "pending"→todo, "done"→completed).'),
    excludeStatus: z.string().optional().describe('Exclude a status. Use excludeStatus="completed" for all active/non-done tasks. Aliases accepted.'),
    assignee: z.string().optional().describe('Filter by person assigned. Known assignees: Alex, Sam, Mia, Leo. Case-sensitive.'),
    priority: z.string().optional().describe('Filter by priority: "low", "medium", "high", or "urgent". Single-value — for multiple priorities, make one call per priority.'),
    tag: z.string().optional().describe('Filter by tag: home, health, finance, errands, kids, garden, family, car, school. Case-sensitive.'),
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

    // When an assignee filter is used with other filters, check if there are
    // additional matching tasks assigned to other people — "kids' school tasks"
    // may be assigned to any family member, not just the kids themselves.
    if (assignee !== undefined) {
      const hasOtherFilters = tag !== undefined || normalizedStatus !== undefined || normalizedExcludeStatus !== undefined || priority !== undefined || dueBefore !== undefined || dueAfter !== undefined || overdue === true;
      if (hasOtherFilters) {
        // Re-apply all non-assignee filters to find the full set of matching tasks
        const allTasks = loadTasks();
        let broader = allTasks;
        if (overdue === true) {
          const now = new Date().toISOString().slice(0, 10);
          broader = broader.filter(t => t.status !== 'completed' && t.dueDate && t.dueDate < now);
        }
        if (normalizedStatus !== undefined) broader = broader.filter(t => t.status === normalizedStatus);
        if (normalizedExcludeStatus !== undefined) broader = broader.filter(t => t.status !== normalizedExcludeStatus);
        if (priority !== undefined) broader = broader.filter(t => t.priority === priority);
        if (tag !== undefined) broader = broader.filter(t => t.tags && t.tags.includes(tag));
        if (dueBefore !== undefined) broader = broader.filter(t => t.dueDate && t.dueDate <= dueBefore);
        if (dueAfter !== undefined) broader = broader.filter(t => t.dueDate && t.dueDate >= dueAfter);

        const otherAssigneeTasks = broader.filter(t => t.assignee !== assignee);

        if (totalFiltered === 0) {
          // Zero results with assignee filter — check for name mentions and guide broadening
          const nameLower = assignee.toLowerCase();
          const mentionMatches = broader.filter(t =>
            t.assignee !== assignee && (
              t.title.toLowerCase().includes(nameLower) ||
              (t.description && t.description.toLowerCase().includes(nameLower))
            )
          );
          if (mentionMatches.length > 0) {
            result.hint = `No tasks are directly ASSIGNED to "${assignee}" matching these filters, but ${mentionMatches.length} task(s) mention "${assignee}" in their title/description: ${mentionMatches.map(t => `${t.id} "${t.title}" (assigned to ${t.assignee})`).join(', ')}. The user may be referring to these — try removing the assignee filter or using search_tasks("${assignee}") to find tasks ABOUT this person.`;
          } else {
            // No mention-matches either — guide the LLM to broaden further
            const filterDesc = [
              tag && `tag="${tag}"`,
              normalizedStatus && `status="${normalizedStatus}"`,
              normalizedExcludeStatus && `excludeStatus="${normalizedExcludeStatus}"`,
              priority && `priority="${priority}"`,
            ].filter(Boolean).join(' + ');
            result.hint = `Zero results for assignee="${assignee}" with ${filterDesc}. Before concluding no tasks exist: (1) try dropping the assignee filter to see if matching tasks are assigned to someone else, (2) try dropping the tag filter — the task may not be tagged as expected, (3) try search_tasks("${assignee}") or search_tasks with the topic keyword to find tasks by content rather than structured filters.`;
          }
        } else if (otherAssigneeTasks.length > 0) {
          // Some results found, but MORE matching tasks exist under other assignees.
          // Alert the LLM so it doesn't assume the assignee-filtered view is complete.
          result.hint = `Showing ${totalFiltered} task(s) assigned to "${assignee}", but ${otherAssigneeTasks.length} additional task(s) match these filters under OTHER assignees: ${otherAssigneeTasks.map(t => `${t.id} "${t.title}" (assigned to ${t.assignee || 'unassigned'})`).join(', ')}. ⚠️ The assignee filter may be too narrow — for a COMPLETE view of all matching tasks (e.g. all "school" tasks regardless of who's assigned), call list_tasks WITHOUT the assignee filter.`;
        }
      }
    }

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
  `Freeform substring search across task titles, descriptions, and tags. Case-insensitive — "cook" matches "cooking class" and "cookbook". Try synonyms if the first search returns few results.

Returns paginated results (default limit=50, check "hasMore"). Fetch ALL pages before acting on results.

⚠️ Do NOT use for structured filtering. If the user asks about a KNOWN TAG (garden, home, health, finance, errands, kids, family, car, school), KNOWN ASSIGNEE (Alex, Sam, Mia, Leo), or status/priority — use list_tasks filters instead. search_tasks is for freeform keywords like "cooking", "birthday", "dentist" that don't map to a filter field.`,
  {
    query: z.string().describe('Search keyword (case-insensitive substring match). Matches against title, description, and tags. Use broad root words: "cook" matches "cooking", "meal" matches "meals". Try synonyms if the first search returns few results.'),
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
  `Get summary statistics — use this INSTEAD of list_tasks when the question is about counts, comparisons, or overviews. Returns: total count, breakdown by status (byStatus), overdue count, completion rate (%), and top assignees ranked by task count.

★ Use get_stats for: "who has the most tasks?", "what's the completion rate?", "how many tasks are overdue?", "workload breakdown", "task count by person", "overall status". Do NOT loop through list_tasks per-assignee to count tasks — get_stats already provides topAssignees.

No parameters needed.`,
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
  `Update one task by ID. Only include fields you want to change — omitted fields stay unchanged.

★ WORKFLOW for batch updates ("move ALL of X's tasks to Y", "set priority on all matching", "bump up the priority on school tasks"):
1. First call list_tasks with TAG or other filters to find ALL matching task IDs. For category queries like "kids' school tasks", use tag='school' — NOT assignee filters (tasks about kids may be assigned to parents).
2. If 0 results: DO NOT stop here for action requests. Try broader filters — drop assignee, drop tag, or use search_tasks. "Mia's school tasks" might be assigned to Alex but about Mia, or tagged differently than expected.
3. Once you have task IDs, call update_task ONCE PER matching task. Do not skip the writes.

⚠️ "Can we bump up…", "Let's change…", "I want to move…" are ACTION REQUESTS — you MUST execute the update_task calls. Do NOT just list tasks and ask for confirmation; the user already asked you to do it.

Statuses: "todo", "in_progress", "completed" (aliases accepted). Priorities: "low", "medium", "high", "urgent".`,
  {
    id: z.string().describe('Task ID to update, e.g. "task-042". Get IDs from list_tasks or search_tasks first.'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description'),
    status: z.string().optional().describe('New status: "todo", "in_progress", or "completed" (aliases like "done", "pending" accepted)'),
    priority: z.string().optional().describe('New priority: "low", "medium", "high", or "urgent"'),
    assignee: z.string().optional().describe('New assignee. Known: Alex, Sam, Mia, Leo.'),
    dueDate: z.string().optional().describe('New due date (YYYY-MM-DD)'),
    tags: z.array(z.string()).optional().describe('New tags (replaces all existing tags)'),
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
