#!/usr/bin/env node

/**
 * Task Manager MCP server.
 * Family to-do list for a household.
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
  instructions: `A family task manager. Call get_stats or list_tasks to discover who the family members are, what tasks exist, and how the system is set up. Do NOT describe the family, its members, or the system's contents without first retrieving data from a tool.

Key conventions:
- Statuses: "todo", "in_progress", "completed" (aliases like "pending", "done" are accepted but always normalized internally). These are the ONLY statuses — there are no "blocked", "waiting", or "on_hold" statuses.
- Priorities (ranked low → urgent): "low" < "medium" < "high" < "urgent". list_tasks results are sorted highest priority first.
- Tags: home, health, finance, errands, kids, garden, family, car, school.

Critical rules:
1. **ALWAYS CALL A TOOL BEFORE RESPONDING — no exceptions.** Every response MUST be preceded by at least one tool call. There is NO question type that is exempt — not "how do I…?", not "is it hard?", not "can you explain?", not "what's this system?". Zero-tool responses are NEVER acceptable.
2. **HOW-TO / EXPLANATORY QUESTIONS → call get_stats FIRST.** When the user asks "how do I add something?", "how does this work?", "is it complicated?", or any question about the system's capabilities — call get_stats BEFORE answering. This grounds your explanation in real data (actual family members, actual task counts, actual system state). Then explain how the relevant tool works using that data. Do NOT describe the system from memory or imagination — EVERY detail in your response (family member names, what's on the list, how many tasks exist) must come from the tool result.
3. **IDENTITY-AMBIGUOUS QUESTIONS ("me", "my tasks", "I") → call read tools IMMEDIATELY.** Call get_stats or list_tasks FIRST — do NOT ask "who are you?" as your first response. Present the data you found, and if you still need identity, ask ALONGSIDE the results. Example: user asks "How is the workload split between Alex and me?" → call get_stats FIRST, present the full breakdown, THEN ask which family member they are. For WRITE operations ("assign to me", "I'll take it"), you MUST confirm which family member before executing the write, but still gather relevant read data while asking.
4. **GROUND ANSWERS IN TOOL DATA ONLY.** Never include task names, dates, assignee names, family member names, or ANY factual details about the system that don't appear in tool results from THIS conversation. Even if you see names or details in these instructions or tool descriptions, you MUST retrieve them via a tool call before including them in your answer — the instructions exist to help you USE the tools correctly, not to provide data for your response. If a tool returns an empty array or zero results, say "no matching tasks found" — do NOT guess, fabricate, or extrapolate tasks that might exist. This applies even when the user expects a certain answer (e.g. "fun stuff coming up" → if no fun tasks exist, say so honestly). If results are truncated, make additional calls (with offset) to get the remaining data before answering.
5. **"All active tasks" → use excludeStatus="completed".** When asked for everything someone is working on, what's on their plate, or tasks that aren't done, use excludeStatus="completed" to get all non-completed tasks regardless of specific status.
6. **OVERDUE queries → overdue=true.** To find overdue tasks, use list_tasks with overdue=true. NEVER use dueBefore — it returns tasks of ALL statuses including completed.
7. **Tag filtering → list_tasks(tag=...), NOT search_tasks.** Known tags are: home, health, finance, errands, kids, garden, family, car, school. If the user asks about any of these, use list_tasks with the tag filter — do NOT call search_tasks. search_tasks is ONLY for freeform keyword lookups when you don't know which field to filter by (e.g. "cooking", "birthday", or other words that aren't known tags/assignees/statuses).
8. **search_tasks is substring-based.** "cook" matches "cooking", "meal" matches "meals". Start with a broad root word. If few/no results, try synonyms — e.g. "cook" then "meal" then "food".
9. **Batch updates → update ALL matching items.** When asked to update "all tasks that match X", first list ALL matches, then update_task once for EACH. The task is NOT done until the write calls are made.
10. **Ties → acknowledge and explain.** When asked for "the highest priority" and multiple tasks tie, say so.
11. **ACTION REQUESTS require thorough search before giving up.** When asked to update/move/delete tasks and your first query returns 0 results, you MUST broaden the search before concluding no tasks exist:
   - Drop the assignee filter (tasks "about" Mia may be assigned to Alex)
   - Drop the tag filter (school tasks might not be tagged "school")
   - Try search_tasks with the person's name or keyword
   - Check the "hint" field in list_tasks responses — it flags tasks that mention the person by name
   Only after 2-3 search strategies return nothing can you report "no matching tasks found". A single narrow query returning 0 is NOT sufficient for action requests.
12. **Filters are AND-combined** in a single list_tasks call (e.g. assignee + excludeStatus + tag = all three must match). For OR logic (e.g. "assigned to Leo OR tagged kids"), make separate calls and merge results.
13. **Use get_stats for counting/comparison/workload questions** — "who has the most tasks?", "what's the completion rate?", "how many are overdue?", "workload breakdown", "workload split", "should we rebalance?", "task distribution". It returns byStatus, overdue count, completionRate, topAssignees (total tasks per person), AND activeTasksByAssignee (per-person breakdown of non-completed tasks with todo/in_progress/overdue counts). Do NOT call list_tasks per-person to count tasks when get_stats already provides this.
14. **list_tasks priority filter is single-value.** It accepts ONE priority at a time. To get tasks across 2 priority levels (e.g. "high and urgent"), make 2 calls — one per priority. This is the correct approach.
15. **CATEGORY queries → use TAG filters, NOT assignee.** "Kids' school tasks", "garden stuff", "health-related tasks" are CATEGORY queries — use list_tasks({tag: 'school'}), list_tasks({tag: 'garden'}), etc. Do NOT filter by assignee for these. Tasks ABOUT kids/school may be assigned to any family member (e.g. "Help Mia with science project" is assigned to Alex, not Mia). Only use assignee filter when the user asks about a SPECIFIC PERSON's workload (e.g. "what's on Sam's plate?"). **Ambiguity: "the kids' tasks"** — if the user means tasks assigned to the children (Mia, Leo), use assignee filters (one call per child). If they mean kid-related tasks as a category, use tag='kids'. Context clues: "Mia and Leo's tasks" → assignee. "Kid-related stuff" → tag.
16. **"Can we…", "Let's…", "I want to…" = ACTION REQUESTS — execute writes.** When the user says "Can we bump up the priority?", "Let's move these to next week", or "I want to reassign these" — they are asking you to DO IT. Find the matching tasks, then call update_task for EACH one. Do NOT just list tasks and ask "shall I proceed?" — the user already gave you the go-ahead. **Exception: if the action requires a value the user hasn't provided** (e.g. "Can we reschedule these?" but no target date, "reassign these" but no target person), list the matching tasks and ask ONLY for the missing value — then execute immediately once you have it. This is asking for missing information, not asking for confirmation.
17. **"Unassigned tasks" → use list_tasks(unassigned=true).** To find tasks with no assignee, use the unassigned=true filter. Do NOT try to pass null or empty string to the assignee parameter.`,
});

// --- Read Tools ---

server.tool(
  'list_tasks',
  `List tasks with optional filters. Filters can be combined (e.g. assignee + excludeStatus + tag).

Tips:
• Use excludeStatus="completed" for "all active/current/not-done tasks".
• Use overdue=true for overdue tasks (not dueBefore, which includes completed).
• Use unassigned=true for tasks with NO assignee. Example: "unassigned urgent tasks" → list_tasks({unassigned: true, priority: 'urgent', excludeStatus: 'completed'}).
• Use tag filter for known tags (garden, school, etc.) — more reliable than search_tasks.
• For CATEGORY queries ("kids' school tasks", "garden stuff"), use the TAG filter — NOT the assignee filter. Tasks about kids/school/garden may be assigned to ANY family member. Example: "kids' school tasks" → list_tasks({tag: 'school', excludeStatus: 'completed'}) finds ALL school tasks regardless of who's assigned.

⚠️ Filters are AND-combined — every specified filter must match. For OR logic (e.g. "tasks assigned to Leo OR tagged kids"), make separate calls: one list_tasks({assignee:'Leo'}) and one list_tasks({tag:'kids'}), then merge the results.

Results sorted by priority (urgent→low), then due date. Paginated (default limit=50, check "hasMore").

Response shape: { tasks: [{ id, title, description, status, priority, assignee, dueDate, tags, **isOverdue** }], total, offset, limit, hasMore, hint? }
• Each task includes an **isOverdue** boolean — true when dueDate is past AND status ≠ completed. Use this to identify overdue items from ANY list_tasks call without needing a separate overdue=true call. Example: "what's on Sam's plate, anything overdue?" → one call: list_tasks({assignee:'Sam', excludeStatus:'completed'}), then check isOverdue on each result.

💡 "Someone's tasks" can mean tasks ASSIGNED to them OR tasks ABOUT them (mentioned in title/description but assigned to another family member). When assignee + other filters return 0 results, the response may include a "hint" field listing tasks that mention the person — follow the hint to broaden your search before concluding no tasks exist.

💡 "The kids' tasks" = tasks assigned to Mia and/or Leo (the children). The tag "kids" is a CATEGORY tag for kid-related tasks that may be assigned to anyone. When the user says "kids' tasks" meaning Mia and Leo specifically, use assignee filters. When they say "kid-related tasks" or "tasks tagged kids", use tag='kids'.`,
  {
    overdue: z.boolean().optional().describe('**Use this for overdue queries.** Set to true to return ONLY tasks that are past due AND not completed. This is the correct way to answer "what is overdue?" — do NOT use dueBefore for overdue queries.'),
    status: z.string().optional().describe('Filter by status: "todo", "in_progress", or "completed". Aliases accepted (e.g. "pending"→todo, "done"→completed).'),
    excludeStatus: z.string().optional().describe('Exclude a status. Use excludeStatus="completed" for all active/non-done tasks. Aliases accepted.'),
    unassigned: z.boolean().optional().describe('Set to true to return ONLY tasks with no assignee. Cannot be combined with "assignee" — use one or the other.'),
    assignee: z.string().optional().describe('Filter by person assigned. Known assignees: Alex, Sam, Mia, Leo. Case-sensitive. To find tasks with NO assignee, use unassigned=true instead.'),
    priority: z.string().optional().describe('Filter by priority: "low", "medium", "high", or "urgent". Single-value — for multiple priorities, make one call per priority.'),
    tag: z.string().optional().describe('Filter by tag: home, health, finance, errands, kids, garden, family, car, school. Case-sensitive.'),
    dueBefore: z.string().optional().describe('Due date upper bound (YYYY-MM-DD). WARNING: Returns tasks of ALL statuses including completed — NOT suitable for finding overdue tasks. Use "overdue=true" instead.'),
    dueAfter: z.string().optional().describe('Due date lower bound (YYYY-MM-DD). Returns tasks of ALL statuses including completed.'),
    limit: z.number().optional().describe('Max results per page (default 50). Response includes "hasMore" boolean — if true, increase offset to get next page.'),
    offset: z.number().optional().describe('Skip N tasks for pagination (default 0). Use when "hasMore" is true in a previous response.'),
  },
  async ({ status, excludeStatus, assignee, unassigned, priority, tag, dueBefore, dueAfter, overdue, limit, offset }) => {
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
    if (unassigned === true) {
      tasks = tasks.filter(t => !t.assignee);
    } else if (assignee !== undefined) {
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

    const now = new Date().toISOString().slice(0, 10);
    const summaries = tasks.map(t => ({
      id: t.id,
      title: t.title,
      description: t.description || null,
      status: t.status,
      priority: t.priority,
      assignee: t.assignee,
      dueDate: t.dueDate,
      tags: t.tags,
      isOverdue: t.status !== 'completed' && !!t.dueDate && t.dueDate < now,
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
            // No mention-matches either — check if broader set has tasks at all
            // to give the LLM a more definitive answer faster.
            const filterDesc = [
              tag && `tag="${tag}"`,
              normalizedStatus && `status="${normalizedStatus}"`,
              normalizedExcludeStatus && `excludeStatus="${normalizedExcludeStatus}"`,
              priority && `priority="${priority}"`,
            ].filter(Boolean).join(' + ');

            if (broader.length > 0) {
              // There ARE tasks matching the non-assignee filters, but none mention this person
              const otherAssignees = [...new Set(broader.map(t => t.assignee || 'unassigned'))].join(', ');
              result.hint = `Zero results for assignee="${assignee}" with ${filterDesc}. ${broader.length} task(s) match the ${filterDesc} filter(s) but are assigned to OTHER people (${otherAssignees}) and NONE mention "${assignee}" in their title/description. This strongly suggests no ${tag || 'matching'} tasks exist for "${assignee}". You may still try search_tasks("${assignee}") as a final check, but it is likely that no matching tasks exist for this person.`;
            } else {
              result.hint = `Zero results for assignee="${assignee}" with ${filterDesc}, and zero tasks match ${filterDesc} across ALL assignees either. No ${tag || 'matching'} tasks exist in the system at all. You can confidently report "no matching tasks found".`;
            }
          }
        } else if (otherAssigneeTasks.length > 0) {
          // Some results found, but MORE matching tasks exist under other assignees.
          // Only mention tasks that actually reference the person by name in title/description —
          // a random task under the same tag assigned to someone else is NOT necessarily "their" task.
          const nameLower = assignee.toLowerCase();
          const mentionTasks = otherAssigneeTasks.filter(t =>
            t.title.toLowerCase().includes(nameLower) ||
            (t.description && t.description.toLowerCase().includes(nameLower))
          );
          if (mentionTasks.length > 0) {
            result.hint = `Showing ${totalFiltered} task(s) assigned to "${assignee}". FYI: ${mentionTasks.length} other task(s) mention "${assignee}" by name but are assigned to SOMEONE ELSE: ${mentionTasks.map(t => `${t.id} "${t.title}" (assigned to ${t.assignee || 'unassigned'})`).join(', ')}. ⚠️ These are NOT "${assignee}'s" tasks — they belong to whoever they are assigned to. Only consider these if the user is asking about a CATEGORY (e.g. "all school tasks") rather than a specific person's task list/assignments.`;
          }
        }
      } else {
        // Assignee-only query (no other filters). Provide context about tasks that
        // MENTION this person by name but are assigned to other family members, along
        // with their tag distribution. This helps the LLM answer topic-specific
        // questions like "Leo mentioned something about school" — Leo's directly
        // assigned tasks may all be garden-related, but school tasks mentioning Leo
        // exist under other assignees.
        const allTasks = loadTasks();
        const nameLower = assignee.toLowerCase();
        const mentionedElsewhere = allTasks.filter(t =>
          t.assignee !== assignee && (
            t.title.toLowerCase().includes(nameLower) ||
            (t.description && t.description.toLowerCase().includes(nameLower))
          )
        );

        if (mentionedElsewhere.length > 0) {
          // Include full task details for mentioned-elsewhere tasks so the LLM
          // doesn't need follow-up calls to discover tasks ABOUT this person.
          const mentionedDetails = mentionedElsewhere.slice(0, 10).map(t =>
            `${t.id} "${t.title}" (assigned to ${t.assignee || 'unassigned'}, status=${t.status}, priority=${t.priority}, due=${t.dueDate || 'none'}, tags=[${(t.tags || []).join(', ')}])`
          ).join('; ');

          result.hint = `Showing ${totalFiltered} task(s) directly ASSIGNED to "${assignee}". Additionally, ${mentionedElsewhere.length} task(s) assigned to OTHER family members mention "${assignee}" by name in their title/description — here are their details: ${mentionedDetails}.${mentionedElsewhere.length > 10 ? ` (showing first 10 of ${mentionedElsewhere.length} — use search_tasks("${assignee}") for the full list.)` : ''} ⚠️ These tasks belong to whoever they are ASSIGNED to — only include them if the user is asking about tasks RELATED TO "${assignee}" (e.g. "tasks for the kids", "what's coming up for Mia") rather than "${assignee}'s assignments/workload".`;
        }
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_task',
  'Get full details of a single task by its ID (e.g. "task-001"). Returns all fields including createdAt and completedAt. Note: list_tasks and search_tasks already include descriptions — use get_task only when you need createdAt/completedAt timestamps.',
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
  `Freeform substring search across task titles, descriptions, and tags. Case-insensitive — "cook" matches "cooking class" and "cookbook". Accepts ONE keyword per call. When the user mentions multiple distinct terms (e.g. "cooking or meals"), make one call per term. Try synonyms if the first search returns few results (e.g. "cook" → "meal" → "food").

Returns paginated results (default limit=50, check "hasMore"). Fetch ALL pages before acting on results.

Response shape: { tasks: [{ id, title, description, status, priority, assignee, dueDate, tags }], total, offset, limit, hasMore }
⚠️ Unlike list_tasks, search_tasks does NOT include an "isOverdue" field. To check if a search result is overdue, inspect its status (≠ completed) and dueDate (< today) manually.

⚠️ Results include tasks of ALL statuses (including completed). Check each task's "status" field when the user only cares about active tasks — filter out completed results mentally before answering.

⚠️ VERIFY TASK IDs CAREFULLY. When combining results from multiple search calls, each result contains an "id" and "title" pair. Always report the EXACT id that was returned alongside each title — do NOT mix up IDs across different result sets. A common mistake is attributing the wrong task-NNN to a task title when juggling multiple search results.

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
      description: t.description || null,
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
  `Get summary statistics — use this INSTEAD of list_tasks when the question is about counts, comparisons, or overviews. Returns: total count, breakdown by status (byStatus), overdue count, completion rate (%), top assignees ranked by total task count, AND activeTasksByAssignee (per-person breakdown of active/non-completed tasks with todo, in_progress, overdue counts, priority breakdown, AND a compact task list with id/title/priority/dueDate/isOverdue).

★ Use get_stats for: "who has the most tasks?", "what's the completion rate?", "how many tasks are overdue?", "workload breakdown", "workload split", "task count by person", "overall status", "how are tasks distributed?", "should we rebalance?". Also use get_stats for HOW-TO and EXPLANATORY questions ("how do I add a task?", "how does this work?", "is it complicated?") — it grounds your explanation in real data (actual family members, task counts, system state) so you never fabricate details. Do NOT loop through list_tasks per-assignee to count tasks — get_stats already provides topAssignees and activeTasksByAssignee WITH full task details.

★ For rebalancing / workload comparison questions, get_stats is SUFFICIENT on its own — it includes each person's active tasks with titles, priorities, due dates, and overdue flags. You do NOT need additional list_tasks calls.

⚠️ ALWAYS call this tool when the user asks about workload, even if they say "me" or "my tasks" and you don't know who they are. get_stats returns data for ALL assignees — no identity needed. Fetch first, clarify identity alongside the results.

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

    // Top assignees by total task count
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

    // Per-assignee active task breakdown (todo + in_progress) for workload questions
    const activeByAssignee = {};
    for (const t of tasks) {
      if (t.assignee && t.status !== 'completed') {
        if (!activeByAssignee[t.assignee]) {
          activeByAssignee[t.assignee] = {
            total: 0, todo: 0, in_progress: 0, overdue: 0,
            byPriority: { urgent: 0, high: 0, medium: 0, low: 0 },
            tasks: [],
          };
        }
        const entry = activeByAssignee[t.assignee];
        entry.total += 1;
        entry[t.status] = (entry[t.status] || 0) + 1;
        if (t.priority && entry.byPriority[t.priority] !== undefined) {
          entry.byPriority[t.priority] += 1;
        }
        const isOverdue = !!t.dueDate && t.dueDate < now;
        if (isOverdue) {
          entry.overdue += 1;
        }
        entry.tasks.push({
          id: t.id,
          title: t.title,
          priority: t.priority,
          dueDate: t.dueDate || null,
          status: t.status,
          isOverdue,
        });
      }
    }

    // Sort each assignee's tasks by priority (urgent first) then due date
    for (const entry of Object.values(activeByAssignee)) {
      entry.tasks.sort((a, b) => {
        const pa = PRIORITY_RANK[a.priority] ?? 0;
        const pb = PRIORITY_RANK[b.priority] ?? 0;
        if (pb !== pa) return pb - pa;
        if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return 0;
      });
    }

    // Count unassigned active tasks
    const unassignedActive = tasks.filter(t => !t.assignee && t.status !== 'completed').length;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total: tasks.length,
          byStatus,
          overdue,
          completionRate,
          topAssignees,
          activeTasksByAssignee: activeByAssignee,
          unassignedActiveTasks: unassignedActive,
        }, null, 2),
      }],
    };
  },
);

// --- Write Tools ---

server.tool(
  'create_task',
  `Add a new task to the family list. This is how anyone adds items — errands, chores, appointments, reminders, or anything else. Only "title" is required; all other fields are optional and have sensible defaults (priority defaults to "medium", status to "todo").

Example: to add a grocery run → create_task({ title: "Pick up groceries from the store", assignee: "Ruth", priority: "low", tags: ["errands"] })

💡 If the user asks "how do I add a task?" or "is it hard to add something?" — call get_stats FIRST to retrieve actual family member names and system state, then explain create_task's capabilities using that real data. NEVER describe the system without grounding in tool results.`,
  {
    title: z.string().describe('Task title'),
    description: z.string().optional().describe('Task description'),
    assignee: z.string().optional().describe('Person assigned to the task'),
    dueDate: z.string().optional().describe('Due date (YYYY-MM-DD)'),
    priority: z.string().optional().describe('Task priority: "low", "medium" (default), "high", or "urgent".'),
    tags: z.array(z.string()).optional().describe('Tags for the task. Known tags: home, health, finance, errands, kids, garden, family, car, school.'),
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

💡 If the target value is missing (e.g. "reschedule these" without a new date, or "reassign" without specifying who), list the tasks and ask for the missing value only — then execute the updates immediately. This is NOT asking for confirmation; it's gathering a required parameter.

Statuses: "todo", "in_progress", "completed" (aliases accepted). Priorities: "low", "medium", "high", "urgent".`,
  {
    id: z.string().describe('Task ID to update, e.g. "task-042". Get IDs from list_tasks or search_tasks first.'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description'),
    status: z.string().optional().describe('New status: "todo", "in_progress", or "completed" (aliases like "done", "pending" accepted)'),
    priority: z.string().optional().describe('New priority: "low", "medium", "high", or "urgent"'),
    assignee: z.string().optional().describe('New assignee. Known: Alex, Sam, Mia, Leo. ⚠️ If user says "assign to me" or "I\'ll take it", you MUST ask which family member they are first — do NOT assume.'),
    dueDate: z.string().optional().describe('New due date (YYYY-MM-DD). Use for rescheduling — e.g. "move to next Monday" → compute the date and pass "2026-04-13". If the user says "reschedule" without specifying a date, ask them for the target date before calling.'),
    tags: z.array(z.string()).optional().describe('New tags (replaces all existing tags). Pass the FULL array — existing tags are overwritten, not merged.'),
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
  'Permanently delete a task by ID. Returns an error if the task does not exist. Get valid task IDs from list_tasks or search_tasks first.',
  { id: z.string().describe('Task ID to delete, e.g. "task-042". Get IDs from list_tasks or search_tasks first.') },
  async ({ id }) => {
    const tasks = loadTasks();
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) {
      return { content: [{ type: 'text', text: `Error: No task found with ID "${id}". Use list_tasks to find valid task IDs.` }], isError: true };
    }
    const deleted = tasks.splice(idx, 1)[0];
    saveTasks(tasks);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, id, deleted: { title: deleted.title, assignee: deleted.assignee } }) }] };
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
