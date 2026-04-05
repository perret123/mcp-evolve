# Task Manager Example Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a family task manager MCP server in `examples/task-manager/` with seeded data, deliberate bugs, and sloppy descriptions — then run mcp-evolve ~20 times to prove the self-improvement loop works, fixing mcp-evolve bugs along the way.

**Architecture:** Standalone MCP server using `@modelcontextprotocol/sdk` + `zod`, reading/writing a `tasks.json` file. Config uses mcp-evolve's `seed`/`reset` hooks with date-shifting. No build step, no extra dependencies.

**Tech Stack:** Node.js 20+, `@modelcontextprotocol/sdk`, `zod` (both already in the repo's dependency tree)

---

## File Structure

```
examples/task-manager/
  server.mjs          # MCP server with 7 tools (~250 lines)
  seed-data.json      # 120 tasks with anchor date
  evolve.config.mjs   # mcp-evolve config: personas, seed/reset, describeState
  mcp.json            # MCP server config pointing to server.mjs
```

No new files outside `examples/task-manager/`. No changes to mcp-evolve core for this phase.

---

### Task 1: Create mcp.json

**Files:**
- Create: `examples/task-manager/mcp.json`

- [ ] **Step 1: Write mcp.json**

```json
{
  "mcpServers": {
    "task-manager": {
      "command": "node",
      "args": ["examples/task-manager/server.mjs"]
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add examples/task-manager/mcp.json
git commit -m "feat(task-manager): add MCP server config"
```

---

### Task 2: Create seed-data.json

**Files:**
- Create: `examples/task-manager/seed-data.json`

- [ ] **Step 1: Write the seed data file**

JSON file with this structure:

```json
{
  "anchorDate": "2026-04-05",
  "tasks": [ /* 120 task objects */ ]
}
```

`anchorDate` is the date the seed data was authored. The `seed()` function in the config will calculate `today - anchorDate` and shift all dates by that offset.

Each task follows this schema:

```json
{
  "id": "task-001",
  "title": "string",
  "description": "string",
  "status": "todo|in_progress|completed",
  "priority": "low|medium|high|urgent",
  "assignee": "Alex|Sam|Mia|Leo|null",
  "tags": ["string"],
  "dueDate": "YYYY-MM-DD",
  "createdAt": "ISO-8601",
  "completedAt": "ISO-8601|null"
}
```

**100 completed tasks** — IDs `task-001` through `task-100`. Spread across past 6 months (relative to anchor date). Mix of assignees (Alex ~40%, Sam ~25%, Mia ~15%, Leo ~10%, null ~10%), priorities, and tags. Realistic family tasks: grocery runs, appointments, home repairs, school things, errands, finance, garden work.

**10 active tasks** — IDs `task-101` through `task-110`. Status `todo` or `in_progress`. Due dates within 2 weeks of anchor date. 3 should be overdue (due date before anchor date by 1-3 days). Use the exact tasks from the spec:

| ID | Title | Assignee | Priority | Tags | Status |
|----|-------|----------|----------|------|--------|
| task-101 | Buy groceries for the week | Alex | medium | errands | todo |
| task-102 | Schedule dentist for Mia | Sam | high | health, kids | todo |
| task-103 | Fix leaky kitchen faucet | Alex | high | home | in_progress |
| task-104 | Plan Leo's birthday party | Sam | urgent | family, kids | in_progress |
| task-105 | Renew passport | Alex | medium | errands | todo |
| task-106 | Help Mia with science project | Alex | high | school, kids | in_progress |
| task-107 | Order new vacuum cleaner | Sam | low | home | todo |
| task-108 | Mow the lawn | Leo | low | garden | todo |
| task-109 | Drop off donation bags | Mia | medium | errands | todo |
| task-110 | Call plumber about water heater | Alex | urgent | home | todo |

Make task-101, task-102, and task-105 overdue (dueDate = anchorDate minus 1-3 days).

**10 future tasks** — IDs `task-111` through `task-120`. Due 1-3 months after anchor date. Use the exact tasks from the spec:

| ID | Title | Assignee | Priority | Tags |
|----|-------|----------|----------|------|
| task-111 | Plan summer vacation | null | medium | family |
| task-112 | Replace living room curtains | Sam | low | home |
| task-113 | Research new family car | Alex | medium | car |
| task-114 | Sign kids up for swim lessons | Sam | medium | kids |
| task-115 | Paint garden fence | Alex | low | garden |
| task-116 | Organize family photo albums | null | low | family |
| task-117 | Get Mia's school supplies for fall | Sam | medium | school, kids |
| task-118 | Service the car before road trip | Alex | high | car |
| task-119 | Deep clean the basement | null | low | home |
| task-120 | Plan neighborhood BBQ | Alex | medium | family |

- [ ] **Step 2: Validate the JSON**

```bash
node -e "const d = JSON.parse(require('fs').readFileSync('examples/task-manager/seed-data.json','utf-8')); console.log('Tasks:', d.tasks.length, '| Completed:', d.tasks.filter(t=>t.status==='completed').length, '| Active:', d.tasks.filter(t=>t.status!=='completed'&&t.id<='task-110').length, '| Future:', d.tasks.filter(t=>t.id>='task-111').length)"
```

Expected: `Tasks: 120 | Completed: 100 | Active: 10 | Future: 10`

- [ ] **Step 3: Commit**

```bash
git add examples/task-manager/seed-data.json
git commit -m "feat(task-manager): add seed data — 120 family tasks"
```

---

### Task 3: Create server.mjs — MCP server with 7 tools

**Files:**
- Create: `examples/task-manager/server.mjs`

- [ ] **Step 1: Write the server boilerplate and helpers**

```javascript
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
```

- [ ] **Step 2: Add list_tasks tool (deliberately sloppy description)**

```javascript
server.tool(
  'list_tasks',
  'Get tasks.',  // deliberately vague — no mention of filters
  {
    status: z.string().optional().describe('Filter by status'),  // no enum
    assignee: z.string().optional().describe('Filter by person'),
    priority: z.string().optional().describe('Filter by priority'),
    dueBefore: z.string().optional().describe('Due date upper bound'),
    dueAfter: z.string().optional().describe('Due date lower bound'),
  },
  async ({ status, assignee, priority, dueBefore, dueAfter }) => {
    let tasks = loadTasks();

    if (status) tasks = tasks.filter(t => t.status === status);
    if (assignee) tasks = tasks.filter(t => t.assignee === assignee);
    if (priority) tasks = tasks.filter(t => t.priority === priority);
    if (dueBefore) tasks = tasks.filter(t => t.dueDate && t.dueDate <= dueBefore);
    if (dueAfter) tasks = tasks.filter(t => t.dueDate && t.dueDate >= dueAfter);

    const result = tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee: t.assignee,
      dueDate: t.dueDate,
      tags: t.tags,
    }));

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);
```

- [ ] **Step 3: Add get_task tool (returns null on missing ID)**

```javascript
server.tool(
  'get_task',
  'Get a single task by its ID.',
  { id: z.string().describe('Task ID') },
  async ({ id }) => {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === id);
    // BUG: returns null instead of helpful error
    return { content: [{ type: 'text', text: JSON.stringify(task || null, null, 2) }] };
  },
);
```

- [ ] **Step 4: Add search_tasks tool (planted bug: only searches title)**

```javascript
server.tool(
  'search_tasks',
  'Search tasks across all fields.',  // LIE: only searches title
  { query: z.string().describe('Search query') },
  async ({ query }) => {
    const tasks = loadTasks();
    const q = query.toLowerCase();

    // BUG: only searches title, not description or tags
    const matches = tasks.filter(t =>
      t.title.toLowerCase().includes(q)
    );

    const result = matches.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assignee: t.assignee,
      tags: t.tags,
    }));

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);
```

- [ ] **Step 5: Add get_stats tool (deliberately vague description)**

```javascript
server.tool(
  'get_stats',
  'Get statistics.',  // deliberately vague
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

    const completionRate = tasks.length > 0
      ? ((byStatus.completed || 0) / tasks.length * 100).toFixed(1) + '%'
      : '0%';

    const assigneeCounts = {};
    for (const t of tasks) {
      if (t.assignee) assigneeCounts[t.assignee] = (assigneeCounts[t.assignee] || 0) + 1;
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
```

- [ ] **Step 6: Add create_task tool (undocumented priority values)**

```javascript
server.tool(
  'create_task',
  'Create a new task.',
  {
    title: z.string().describe('Task title'),
    description: z.string().optional().describe('Task description'),
    assignee: z.string().optional().describe('Who is responsible'),
    dueDate: z.string().optional().describe('Due date'),
    priority: z.string().optional().describe('Priority level'),  // no enum, no hint
    tags: z.array(z.string()).optional().describe('Tags'),
  },
  async ({ title, description, assignee, dueDate, priority, tags }) => {
    const tasks = loadTasks();

    const maxNum = tasks.reduce((max, t) => {
      const n = parseInt(t.id.replace('task-', ''), 10);
      return n > max ? n : max;
    }, 0);

    const task = {
      id: `task-${String(maxNum + 1).padStart(3, '0')}`,
      title,
      description: description || '',
      status: 'todo',
      priority: priority || 'medium',
      assignee: assignee || null,
      tags: tags || [],
      dueDate: dueDate || null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    tasks.push(task);
    saveTasks(tasks);

    return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
  },
);
```

- [ ] **Step 7: Add update_task tool (planted bug: no completedAt on completion)**

```javascript
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
  async ({ id, ...updates }) => {
    const tasks = loadTasks();
    const idx = tasks.findIndex(t => t.id === id);

    if (idx === -1) {
      return { content: [{ type: 'text', text: `Task "${id}" not found.` }], isError: true };
    }

    // BUG: does NOT set completedAt when status changes to 'completed'
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) tasks[idx][key] = value;
    }

    saveTasks(tasks);
    return { content: [{ type: 'text', text: JSON.stringify(tasks[idx], null, 2) }] };
  },
);
```

- [ ] **Step 8: Add delete_task tool (planted bug: success on nonexistent ID)**

```javascript
server.tool(
  'delete_task',
  'Delete a task.',
  { id: z.string().describe('Task ID to delete') },
  async ({ id }) => {
    const tasks = loadTasks();
    const filtered = tasks.filter(t => t.id !== id);
    saveTasks(filtered);

    // BUG: returns success even if nothing was deleted
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, id }) }] };
  },
);
```

- [ ] **Step 9: Add transport startup**

```javascript
const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 10: Test the server starts**

```bash
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}},"id":1}' | node examples/task-manager/server.mjs 2>/dev/null | head -c 500
```

Expected: JSON response containing `"name":"task-manager"` and `"version":"0.1.0"`.

- [ ] **Step 11: Commit**

```bash
git add examples/task-manager/server.mjs
git commit -m "feat(task-manager): MCP server with 7 tools and planted bugs"
```

---

### Task 4: Create evolve.config.mjs

**Files:**
- Create: `examples/task-manager/evolve.config.mjs`

- [ ] **Step 1: Write the config**

```javascript
/**
 * mcp-evolve config for the task-manager example.
 *
 * A family task manager with seeded data, deliberately sloppy
 * tool descriptions, and planted bugs — designed to be improved
 * by mcp-evolve's feedback loop.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const EXAMPLE_DIR = new URL('.', import.meta.url).pathname;
const SEED_PATH = join(EXAMPLE_DIR, 'seed-data.json');
const TASKS_PATH = join(EXAMPLE_DIR, 'tasks.json');

function shiftDate(dateStr, offsetDays) {
  if (!dateStr) return dateStr;
  const d = new Date(dateStr);
  d.setDate(d.getDate() + offsetDays);
  // Preserve format: if original was date-only (YYYY-MM-DD), return date-only
  if (dateStr.length === 10) return d.toISOString().slice(0, 10);
  return d.toISOString();
}

export default {
  mcpConfig: join(EXAMPLE_DIR, 'mcp.json'),
  mcpToolPrefix: 'mcp__task-manager__',
  answererTools: 'mcp__task-manager__*',

  systemDescription: "a family task manager — Alex's household to-do list with tasks for the whole family",

  srcDirs: [EXAMPLE_DIR],

  writeTools: ['create_task', 'update_task', 'delete_task'],

  questionsPerPersona: 2,
  language: 'English',

  describeState: () => [
    "Alex's family task manager with 120 tasks.",
    '100 completed tasks from the past 6 months (household chores, errands, appointments).',
    '10 active tasks due within the next 2 weeks (some are overdue by a few days).',
    '10 future tasks due 1-3 months from now.',
    'Assignees: Alex, Sam (partner), Mia (teen daughter), Leo (young son), or unassigned.',
    'Tags: home, health, finance, errands, kids, garden, family, car, school.',
    'Priorities: low, medium, high, urgent.',
    'Statuses: todo, in_progress, completed.',
  ].join('\n'),

  seed: async () => {
    const raw = JSON.parse(readFileSync(SEED_PATH, 'utf-8'));
    const anchor = new Date(raw.anchorDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const offsetDays = Math.round((today - anchor) / (1000 * 60 * 60 * 24));

    const tasks = raw.tasks.map(t => ({
      ...t,
      dueDate: shiftDate(t.dueDate, offsetDays),
      createdAt: shiftDate(t.createdAt, offsetDays),
      completedAt: shiftDate(t.completedAt, offsetDays),
    }));

    writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2) + '\n');
  },

  reset: async () => {
    try { unlinkSync(TASKS_PATH); } catch { /* ok if missing */ }
  },

  personas: [
    {
      id: 'alex',
      group: 'train',
      name: 'Alex (Owner)',
      mbti: 'ESTJ',
      cluster: 'management',
      description: 'You are Alex, the household organizer. You manage the family to-do list and want to stay on top of deadlines. You speak in direct, short commands.',
      concerns: [
        'Overdue tasks and upcoming deadlines',
        'Tasks assigned to specific family members',
        'Creating and updating tasks',
        'Checking task completion status',
      ],
      questionStyle: 'Direct and results-oriented. "What\'s overdue?" "Show me this week\'s tasks." "Mark the faucet fix as done."',
    },
    {
      id: 'sam',
      group: 'train',
      name: 'Sam (Partner)',
      mbti: 'INFP',
      cluster: 'planning',
      description: 'You are Sam, Alex\'s partner. You help manage the family calendar and kids\' activities. You\'re collaborative and like to reorganize priorities.',
      concerns: [
        'Kids\' tasks and schedules',
        'Rescheduling and reprioritizing tasks',
        'Planning upcoming family events',
        'Checking what\'s on your plate',
      ],
      questionStyle: 'Collaborative and thoughtful. "Can we move the dentist to next week?" "What\'s on my plate?" "What tasks do the kids have?"',
    },
    {
      id: 'mia',
      group: 'eval',
      name: 'Mia (Teen)',
      mbti: 'ESFP',
      cluster: 'casual',
      description: 'You are Mia, 15-year-old daughter. You check your tasks reluctantly and type casually with no capitalization.',
      concerns: [
        'Your own assigned tasks',
        'What\'s happening with birthday parties or fun stuff',
        'Avoiding chores if possible',
      ],
      questionStyle: 'Casual and impatient. "do i have anything to do today" "whats leos party plan" "can someone else mow the lawn"',
    },
    {
      id: 'grandma',
      group: 'train',
      name: 'Grandma Ruth',
      mbti: 'ISFJ',
      cluster: 'support',
      description: 'You are Ruth, Alex\'s mother. You want to help but aren\'t very tech-savvy. You ask how things work and offer to take on tasks.',
      concerns: [
        'Understanding how to use the system',
        'Seeing what Alex or the kids need help with',
        'Adding yourself to tasks she can help with',
        'Finding tasks by searching for topics',
      ],
      questionStyle: 'Helpful but unsure. "I\'d like to see what Alex needs help with." "How do I add something to the list?" "Can you search for anything related to cooking?"',
    },
    {
      id: 'neighbor',
      group: 'eval',
      name: 'Neighbor Dave',
      mbti: 'ENTP',
      cluster: 'external',
      description: 'You are Dave, the next-door neighbor. You\'re nosy but friendly. You ask about stats and patterns, always curious how organized the family is.',
      concerns: [
        'Overall statistics and completion rates',
        'Search for specific topics',
        'How many tasks each person handles',
        'Overdue patterns and productivity trends',
      ],
      questionStyle: 'Friendly and analytical. "How many tasks do you guys finish per month?" "Who\'s the busiest person in the family?" "Search for anything garden-related."',
    },
  ],
};
```

- [ ] **Step 2: Verify config loads**

```bash
node -e "import('./examples/task-manager/evolve.config.mjs').then(m => { const c = m.default; console.log('Personas:', c.personas.length, '| Write tools:', c.writeTools.length, '| Prefix:', c.mcpToolPrefix) })"
```

Expected: `Personas: 5 | Write tools: 3 | Prefix: mcp__task-manager__`

- [ ] **Step 3: Test seed and reset**

```bash
node -e "import('./examples/task-manager/evolve.config.mjs').then(async m => { await m.default.seed(); const tasks = JSON.parse(require('fs').readFileSync('examples/task-manager/tasks.json','utf-8')); console.log('Seeded:', tasks.length, 'tasks'); console.log('First active due:', tasks.find(t=>t.id==='task-103')?.dueDate); await m.default.reset(); console.log('Reset: tasks.json exists?', require('fs').existsSync('examples/task-manager/tasks.json')); })"
```

Expected: `Seeded: 120 tasks`, a due date near today, and `Reset: tasks.json exists? false`.

- [ ] **Step 4: Commit**

```bash
git add examples/task-manager/evolve.config.mjs
git commit -m "feat(task-manager): add evolve config with personas and seed/reset"
```

---

### Task 5: Smoke test — dry run

**Files:** None (validation only)

- [ ] **Step 1: Run a dry run to verify question generation works**

```bash
node bin/cli.mjs -c examples/task-manager/evolve.config.mjs --dry-run -v
```

Expected: 10 questions generated (2 per persona x 5 personas), no errors. Check that questions make sense for the personas and reference the seed data context.

- [ ] **Step 2: Fix any issues found**

If the dry run fails or produces bad output, fix the config or server before proceeding.

- [ ] **Step 3: Commit any fixes**

---

### Task 6: Run mcp-evolve ~20 times and document results

**Files:**
- Create: `examples/task-manager/RESULTS.md` (after all runs)

This is the proof-of-concept phase. Run the full loop repeatedly and observe mcp-evolve improving the task manager.

- [ ] **Step 1: Run 1 — first full run**

```bash
node bin/cli.mjs -c examples/task-manager/evolve.config.mjs -v
```

Document: success rate, which questions failed, what the fixer changed (if anything). Check `examples/task-manager/server.mjs` for any edits mcp-evolve made.

- [ ] **Step 2: Runs 2-5 — early improvement phase**

Run 4 more times. After each run:
- Check success rate (should be climbing)
- Check `git diff examples/task-manager/server.mjs` for tool description improvements
- Note any mcp-evolve errors or unexpected behavior

If mcp-evolve itself has a bug: **fix it and commit the fix** before continuing.
If something is unclear or ambiguous about mcp-evolve behavior: **note it** for later.

- [ ] **Step 3: Runs 6-10 — bug discovery phase**

By now, personas should be triggering the planted bugs (search_tasks only searching title, update_task not setting completedAt, delete_task returning success for missing IDs). The fixer should start patching these.

After each run, check:
- Did mcp-evolve find and fix a planted bug?
- Are the fixes correct?
- Is the golden set growing?

- [ ] **Step 4: Runs 11-15 — stabilization phase**

Success rate should be near 100%. Watch for:
- Escalation triggering (after 3 consecutive 100% runs)
- Harder questions being generated
- Any regressions from escalated questions

- [ ] **Step 5: Runs 16-20 — escalation phase**

Document:
- What escalated questions look like
- Whether the system handles them
- Final state of tool descriptions and code

- [ ] **Step 6: Write RESULTS.md**

Summarize the 20 runs in `examples/task-manager/RESULTS.md`:
- Run-by-run success rates
- What mcp-evolve fixed (description improvements, bug fixes)
- When escalation triggered
- Any mcp-evolve bugs found and fixed
- Any unclear behaviors noted
- Before/after diff of server.mjs

- [ ] **Step 7: Final commit**

```bash
git add examples/task-manager/RESULTS.md
git add -A  # any mcp-evolve fixes
git commit -m "feat(task-manager): document 20-run proof of concept"
```
