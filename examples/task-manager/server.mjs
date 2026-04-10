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
  instructions: 'A family task manager for Alex\'s household. Family members: Alex (parent), Sam (partner/parent), Mia (teen daughter), Leo (young son). The "kids" are Mia and Leo. For any request to find a task and change it (reassign, reschedule, rename, complete), use find_and_update_task — it searches and updates in one step. If you need a relative date ("next week", "tomorrow", "last month"), call get_current_date first — it returns pre-computed fields like nextWeekStart, thisWeekStart, lastMonthStart/End that you can use directly. After calling get_current_date, IMMEDIATELY proceed to the write — do NOT stop or ask the user for clarification.',
});

// --- Read Tools ---

server.tool(
  'list_tasks',
  'Get tasks. All filters are optional and combine freely — e.g. assignee="Alex" + priority="urgent" for Alex\'s urgent tasks, or status="completed" + completedAfter/completedBefore for tasks finished in a date range. Family roles: Alex=parent, Sam=parent, Mia=kid (teen daughter), Leo=kid (young son). "The kids" always means Mia and Leo only.',
  {
    status: z.string().optional().describe('Filter by status. Valid values: todo, in-progress, completed, overdue. Comma-separate to match multiple. For "still to do", "not yet done", "pending", or "unfinished" tasks — use status="todo,in-progress" (these are the two non-completed statuses). Do NOT use "overdue" for this — "overdue" is a due-date filter, not a completion filter. Use "overdue" only when the user explicitly asks what is late or past-due. IMPORTANT: tasks returned by the "overdue" filter will still show status "todo" or "in-progress" as their stored value — they are overdue because their dueDate is in the past. Check the isOverdue:true field to confirm. Prefer the get_overdue_tasks tool for pure overdue queries with no priority or assignee filtering needed. NOTE: to find tasks completed within a date range (e.g. "what did I finish last month"), use status="completed" with completedAfter/completedBefore — do NOT use dueAfter/dueBefore for this purpose.'),
    assignee: z.string().optional().describe('Filter by assignee name (exact, case-insensitive). Comma-separate to match multiple: e.g. "Mia,Leo". Known family members: Alex (parent), Sam (parent), Mia (kid/teen daughter), Leo (kid/young son). IMPORTANT — when to add this filter: ONLY add it when the user uses "I", "my", or "me" as the OWNER/SUBJECT of the tasks (e.g. "my tasks", "what I finished", "tasks assigned to me", "what did I finish"). Do NOT add it when "show me" is simply a display request — "show me all health tasks" means ALL family health tasks, not just the current user\'s ("show me" = "display for me", not "my"). Do NOT add it when the user says "all X tasks" — "all" always means all family tasks. When you DO add it, always use the current user\'s exact name, even if that name is not in the known family list above (e.g. "Grandma Ruth" → assignee="Grandma Ruth"). Only omit the filter entirely when the user is asking about all family tasks (e.g. "show me everything", "what\'s left for the family", "all health tasks", "all high priority tasks").'),
    priority: z.string().optional().describe('Filter by priority. Valid values: urgent, high, medium, low. Comma-separate to match multiple priorities: e.g. priority="urgent,high" returns both urgent and high priority tasks in one call. Use "urgent" for urgent tasks. Combine with assignee to get a specific person\'s urgent tasks (e.g. assignee="Alex" + priority="urgent"). NOTE: "urgent" is a priority level — it is NOT the same as overdue. When a user asks for someone\'s urgent tasks, use priority="urgent" here, NOT get_overdue_tasks. Also: "show me X\'s tasks today" means show their current active tasks — do NOT add any due-date filters for the word "today" unless the user explicitly says "due today".'),
    dueBefore: z.string().optional().describe('Due date upper bound (YYYY-MM-DD). Returns tasks with dueDate <= this value. For "tasks coming up this month" or any future date range, combine with dueAfter using different dates (e.g. dueAfter=2026-04-01 + dueBefore=2026-04-30). For "due today or overdue", pass today\'s date and omit dueAfter — that returns all tasks with dueDate <= today, including past-due ones. Do NOT use the same date for both dueBefore and dueAfter — that only matches tasks due on exactly that date.'),
    dueAfter: z.string().optional().describe('Due date lower bound (YYYY-MM-DD). Returns tasks with dueDate >= this value. For "coming up this month" or any future date range, pair with dueBefore using different dates (e.g. dueAfter=first-of-month + dueBefore=last-of-month). Do not use the same value as dueBefore — use dueBefore alone for "due today or overdue".'),
    completedAfter: z.string().optional().describe('Completion date lower bound (YYYY-MM-DD). Returns tasks where completedAt >= this date. Use with status="completed" + completedBefore to find tasks finished in a specific period. When the user says "I" or "me" as the owner of the work (e.g. "what did I finish last month", "show me what I finished"), ALWAYS also set assignee to the current user\'s name — use whatever name the current user has, even if they are not in the known family list. Example: if the current user is "Grandma Ruth" and they ask "what did I finish last month" → status="completed", completedAfter="2026-03-01", completedBefore="2026-03-31", assignee="Grandma Ruth". Each result includes a completedAt field showing when it was finished.'),
    completedBefore: z.string().optional().describe('Completion date upper bound (YYYY-MM-DD). Returns tasks where completedAt <= this date. Pair with completedAfter and status="completed" to scope to a date range.'),
    tag: z.string().optional().describe('Filter by tag (exact match, case-insensitive). Use this whenever the user mentions a task category or tag — e.g. "home tasks" → tag="home", "school tasks" → tag="school", "errands" → tag="errands". This is exact match only: tag="home" returns only tasks that have the "home" tag, not tasks that merely mention "home" in their title. Call list_tags first if you are unsure which tags exist.'),
  },
  async ({ status, assignee, priority, dueBefore, dueAfter, completedAfter, completedBefore, tag }) => {
    const result = api.listTasks({ status, assignee, priority, dueBefore, dueAfter, completedAfter, completedBefore, tag });
    if (result.count === 0) {
      const activeFilters = [];
      if (assignee) activeFilters.push(`assignee="${assignee}"`);
      if (priority) activeFilters.push(`priority="${priority}"`);
      if (status) activeFilters.push(`status="${status}"`);
      if (tag) activeFilters.push(`tag="${tag}"`);
      if (dueBefore) activeFilters.push(`dueBefore="${dueBefore}"`);
      if (dueAfter) activeFilters.push(`dueAfter="${dueAfter}"`);
      const filterDesc = activeFilters.length > 0 ? ` with filters: ${activeFilters.join(', ')}` : '';
      return { content: [{ type: 'text', text: JSON.stringify({ ...result, message: `No tasks found${filterDesc}. Tell the user there are no matching tasks — do NOT re-run with different filters, drop the assignee filter, or show tasks belonging to other family members as a substitute.` }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ...result, _note: 'IMPORTANT: Each task has a unique id field. When reporting results, always copy each task\'s id exactly as it appears in this response — do not reuse or guess IDs, especially when multiple tasks share the same assignee, tag, or due date.' }, null, 2) }] };
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
  'Full-text search across task titles, descriptions, tags, and assignees. Use this to find a task by name before updating it. If the search returns no results, the task does not exist under that name — tell the user the task was not found rather than creating a new one. IMPORTANT: When you find a matching task and its current state already satisfies the user\'s request (e.g., status is already "completed" when the user asks to mark it done), tell the user it is already done and do NOT update any other task. Never skip past the best-matching result to update a different, less-relevant task.',
  { query: z.string().describe('Search query — searches title, description, tags, and assignee') },
  async ({ query }) => {
    const result = api.searchTasks(query);
    if (result.tasks.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ found: false, count: 0, tasks: [], message: `No tasks found matching "${query}". This search is exhaustive — it scans ALL tasks in the system. If nothing is returned, the task does not exist under this name. Stop searching and tell the user the task was not found.` }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ found: true, count: result.tasks.length, tasks: result.tasks }) }] };
  },
);

server.tool(
  'get_stats',
  'Get overall task statistics: total count, breakdown by status, overdue count, completion rate, and task count per family member (topAssignees sorted highest to lowest). Use this to answer questions about workload distribution, who handles the most or fewest tasks, who is the busiest or most available, overall progress, or completion rates. For "someone else" reassignments, call this first to find the family member with the fewest tasks.',
  {},
  async () => {
    const stats = api.getStats();
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  },
);

server.tool(
  'get_overdue_tasks',
  'Get all tasks that are past their due date and not yet completed, grouped by assignee. Use this ONLY for questions about tasks that are late/past-due (e.g. "what\'s overdue?", "what did we miss?", "what\'s late?"). Do NOT use this for priority="urgent" queries — "urgent" is a priority level, not the same as overdue. This tool has no filter parameters and always returns every overdue task for all family members. When you need to filter by assignee or priority (e.g. "Alex\'s urgent tasks"), use list_tasks with assignee and priority filters instead. Returns totalOverdue count and each overdue task with its title, assignee, dueDate, and priority.',
  {},
  async () => {
    const result = api.getOverdueSummary();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_current_date',
  'Get today\'s date plus pre-computed date ranges for common relative expressions. Returns today, yesterday, tomorrow, thisWeekStart/End (Mon–Sun), nextWeekStart/End, thisMonthStart/End, and lastMonthStart/End — all in YYYY-MM-DD. Call this before any relative date expression ("next week", "this week", "last month", "tomorrow"). Then use the returned values directly in update_task/create_task or as dueAfter/dueBefore filters — no manual arithmetic needed. Examples: "next week" → use nextWeekStart as dueDate; "this week" filter → dueAfter=thisWeekStart + dueBefore=thisWeekEnd; "last month completed" → completedAfter=lastMonthStart + completedBefore=lastMonthEnd + status=completed.',
  {},
  async () => {
    const d = new Date();
    function fmt(date) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }
    const today = fmt(d);

    const yesterday = new Date(d); yesterday.setDate(d.getDate() - 1);
    const tomorrow = new Date(d); tomorrow.setDate(d.getDate() + 1);

    // Week boundaries: Monday=start, Sunday=end
    const dayOfWeek = d.getDay(); // 0=Sun,1=Mon,...,6=Sat
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(d); weekStart.setDate(d.getDate() - daysFromMonday);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);

    const nextWeekStart = new Date(weekStart); nextWeekStart.setDate(weekStart.getDate() + 7);
    const nextWeekEnd = new Date(nextWeekStart); nextWeekEnd.setDate(nextWeekStart.getDate() + 6);

    const thisMonthStart = new Date(d.getFullYear(), d.getMonth(), 1);
    const thisMonthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const lastMonthStart = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const lastMonthEnd = new Date(d.getFullYear(), d.getMonth(), 0);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          today,
          yesterday: fmt(yesterday),
          tomorrow: fmt(tomorrow),
          thisWeekStart: fmt(weekStart),
          thisWeekEnd: fmt(weekEnd),
          nextWeekStart: fmt(nextWeekStart),
          nextWeekEnd: fmt(nextWeekEnd),
          thisMonthStart: fmt(thisMonthStart),
          thisMonthEnd: fmt(thisMonthEnd),
          lastMonthStart: fmt(lastMonthStart),
          lastMonthEnd: fmt(lastMonthEnd),
        }),
      }],
    };
  },
);

server.tool(
  'list_tags',
  'List all tags used across the task list, sorted by frequency. Use this to discover available tags before filtering with list_tasks(tag=...), or to answer questions like "what categories of tasks do we have?" or "how many home/school/errands tasks exist?".',
  {},
  async () => {
    const result = api.getTagSummary();
    return { content: [{ type: 'text', text: JSON.stringify({ tags: result }) }] };
  },
);

server.tool(
  'find_and_update_task',
  'Find a task by title keywords and immediately apply an update — search + update in one step. Use this for any "find task X and change Y" request: "transfer car maintenance to Sam" (query="car maintenance", assignee="Sam"), "move Leo\'s birthday party to next week" (query="Leo birthday party", dueDate="<nextWeekStart from get_current_date>"), "mark the dentist appointment done" (query="dentist", status="completed"), "transfer the car maintenance task due this week to Sam" (query="car maintenance", searchDueAfter=thisWeekStart, searchDueBefore=thisWeekEnd, assignee="Sam"). Use searchDueAfter/searchDueBefore whenever the prompt qualifies the task by when it\'s due — these narrow the search to the right task when multiple results match the query. IMPORTANT: When the search returns multiple matching tasks, this tool will NOT update any of them — it returns the full list so you can identify the correct one and call again with taskId. When only one task matches, it updates immediately. If no task is found in the date range, the tool also searches without date filters and suggests similar tasks. Returns the updated task on success. IMPORTANT: For dueDate, call get_current_date first to get pre-computed values (nextWeekStart, etc.) — do NOT pass relative strings like "next week".',
  {
    query: z.string().describe('Keywords to find the task by title (e.g. "car maintenance", "Leo birthday party", "dentist appointment"). Use the most specific keywords from the user\'s request to minimize ambiguous matches.'),
    taskId: z.string().optional().describe('If you already know the task ID (e.g. from a previous call that returned multiple matches), pass it here to skip the search and update that specific task directly. Takes precedence over query/search filters.'),
    assignee: z.string().optional().describe('New assignee — use this for "transfer to X", "reassign to X", "hand off to X"'),
    dueDate: z.string().optional().describe('New due date in YYYY-MM-DD. Call get_current_date first and use its pre-computed fields (nextWeekStart, tomorrow, etc.). Note: nextWeekStart is the MONDAY of next week — using it moves the task to that specific Monday regardless of its current date.'),
    status: z.string().optional().describe('New status: todo, in-progress, or completed'),
    priority: z.string().optional().describe('New priority: urgent, high, medium, or low'),
    title: z.string().optional().describe('New title (rename the task)'),
    searchDueAfter: z.string().optional().describe('Narrow the search to tasks due on or after this date (YYYY-MM-DD). Use when the prompt says "due this week", "due next week", "due tomorrow", etc. Call get_current_date first for pre-computed values (thisWeekStart, nextWeekStart, tomorrow, etc.). Combine with searchDueBefore to match a specific week or range.'),
    searchDueBefore: z.string().optional().describe('Narrow the search to tasks due on or before this date (YYYY-MM-DD). Pair with searchDueAfter to scope to a week or date range (e.g. searchDueAfter=thisWeekStart + searchDueBefore=thisWeekEnd to find the task due this week).'),
  },
  async ({ query, taskId, assignee, dueDate, status, priority, title, searchDueAfter, searchDueBefore }) => {
    let task;

    if (taskId) {
      // Direct update by ID — skip search entirely
      const found = api.getTask(taskId);
      if (!found || !found.found) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ found: false, updated: false, message: `No task found with ID "${taskId}". Cannot update. Tell the user the task ID was not recognized.` }) }],
        };
      }
      task = found;
    } else {
      const result = api.searchTasks(query, {
        ...(searchDueAfter ? { dueAfter: searchDueAfter } : {}),
        ...(searchDueBefore ? { dueBefore: searchDueBefore } : {}),
      });

      if (result.tasks.length === 0) {
        // Fallback 1: search without date filters (same AND query)
        const fallback = api.searchTasks(query);
        const dateRange = [searchDueAfter && `after ${searchDueAfter}`, searchDueBefore && `before ${searchDueBefore}`].filter(Boolean).join(' and ');
        const dateMsg = dateRange ? ` due ${dateRange}` : '';
        if (fallback.tasks.length > 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              found: false, updated: false,
              message: `No task matching "${query}"${dateMsg}. However, ${fallback.tasks.length} similar task(s) exist outside that date range — shown below. If one of these is correct, call again with its taskId to update it. Otherwise tell the user the task was not found in that time period.`,
              suggestions: fallback.tasks.slice(0, 5),
            }) }],
          };
        }
        // Fallback 2: search by individual tokens (partial match) to surface close-but-not-exact tasks
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        const seen = new Set();
        const partialMatches = [];
        for (const token of tokens) {
          const tokenResult = api.searchTasks(token);
          for (const t of tokenResult.tasks) {
            if (!seen.has(t.id)) { seen.add(t.id); partialMatches.push(t); }
          }
        }
        if (partialMatches.length > 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              found: false, updated: false,
              message: `No task found matching "${query}"${dateMsg}. No exact match exists anywhere in the system. However, tasks containing some of those keywords are shown below — one of them may be what the user meant. If so, call again with that task's taskId to update it. Otherwise tell the user the task was not found.`,
              partialMatches: partialMatches.slice(0, 5),
            }) }],
          };
        }
        // Nothing at all — return a clear not-found result (not isError, so the model can respond gracefully)
        return {
          content: [{ type: 'text', text: JSON.stringify({ found: false, updated: false, message: `No task found matching "${query}"${dateMsg}. This search is exhaustive — no task with those keywords exists anywhere in the system. Stop searching and tell the user the task was not found.` }) }],
        };
      }

      if (result.tasks.length > 1) {
        // Multiple matches — return all and require the model to pick one via taskId
        return {
          content: [{ type: 'text', text: JSON.stringify({
            found: true, updated: false, multipleFound: true,
            count: result.tasks.length,
            tasks: result.tasks,
            message: `Found ${result.tasks.length} tasks matching "${query}" — cannot update without knowing which one. Review the list, identify the correct task, then call find_and_update_task again with that task's taskId plus the same update fields.`,
          }) }],
        };
      }

      task = result.tasks[0];
    }

    const changes = {};
    if (assignee !== undefined) changes.assignee = assignee;
    if (dueDate !== undefined) changes.dueDate = dueDate;
    if (status !== undefined) changes.status = status;
    if (priority !== undefined) changes.priority = priority;
    if (title !== undefined) changes.title = title;

    if (Object.keys(changes).length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ found: true, updated: false, task, message: 'Task found but no changes specified.' }) }],
      };
    }
    const updated = api.updateTask(task.id, changes);
    return { content: [{ type: 'text', text: JSON.stringify({ found: true, updated: true, task: updated }) }] };
  },
);

// --- Write Tools ---

server.tool(
  'create_task',
  'Create a brand-new task that does not yet exist. When the user refers to themselves or requests a reminder ("for me", "I need to", "add to my list", "remind me", "add a reminder", "set a reminder"), always set assignee to the current user\'s name — note that "add a reminder for [event]" means the reminder is for the current user about the event, not that the event is the assignee. IMPORTANT: Only use this when the user explicitly says "add a task", "create a task", or "add/set a reminder". If the user asks to reschedule, rename, mark done, or otherwise modify a task — even if you cannot find it — do NOT create a new task. Instead, tell the user the task was not found and ask them to clarify.',
  {
    title: z.string().describe('Task title'),
    description: z.string().optional().describe('Task description'),
    assignee: z.string().optional().describe('Person assigned to the task'),
    dueDate: z.string().optional().describe('Due date (YYYY-MM-DD)'),
    priority: z.string().optional().describe('Task priority'),
    tags: z.array(z.string()).optional().describe('Tags for the task. Call list_tags first to see which tags already exist in the system, then apply the relevant ones to this task. Reuse established tags (e.g. "garden", "school", "errands", "home", "kids", "health", "finance") when they match the task content — do not invent new tags when an existing one fits. Using established tags ensures the task appears in tag-filtered list queries.'),
  },
  async ({ title, description, assignee, dueDate, priority, tags }) => {
    const task = api.createTask({ title, description, assignee, dueDate, priority, tags });
    return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
  },
);

server.tool(
  'update_task',
  'Update a task\'s fields. When a user asks to reschedule, reassign, transfer, hand off, rename, reprioritize, mark as done/complete/finished, or change a task in any way — call this immediately. Do not ask for confirmation; execute the change directly. "Transfer to X" or "hand off to X" means update assignee to X. For "reassign to someone else": call get_stats first to see task counts per person (topAssignees), pick the family member with the fewest tasks who is not the current assignee, then call this tool to update the assignee — do not ask for confirmation.',
  {
    id: z.string().describe('Task ID to update'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description'),
    status: z.string().optional().describe('New status. Valid values: todo, in-progress, completed. IMPORTANT: use "completed" when the user says done, finished, complete, or check off — do NOT use "done" or "finished" as those are not valid values. Only "completed" marks a task as done.'),
    priority: z.string().optional().describe('New priority. Valid values: urgent, high, medium, low.'),
    assignee: z.string().optional().describe('New assignee (Alex, Sam, Mia, or Leo)'),
    dueDate: z.string().optional().describe('New due date (YYYY-MM-DD). For relative dates ("next week", "tomorrow", "in 3 days"): (1) call get_current_date to get today\'s date, (2) compute the target date yourself (e.g. today + 7 days for "next week"), (3) call update_task with the computed date. CRITICAL: step 3 is mandatory — the task is NOT rescheduled until this tool is called with the new date. Computing the date without calling this tool makes no change.'),
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
