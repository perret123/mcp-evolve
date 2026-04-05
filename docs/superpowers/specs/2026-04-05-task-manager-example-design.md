# Task Manager Example for mcp-evolve

A self-contained demo project that proves mcp-evolve works. A family task manager MCP server with seeded data, deliberate bugs, and sloppy tool descriptions — designed to be improved by mcp-evolve's feedback loop.

## Location

`examples/task-manager/` in the mcp-evolve repo.

## File Structure

```
examples/task-manager/
  server.mjs          # MCP server (7 tools)
  seed-data.json      # 120 tasks: 100 completed, 10 active, 10 future
  evolve.config.mjs   # mcp-evolve config
  mcp.json            # MCP server config for Claude CLI
```

## Storage

Single `tasks.json` file — read/written by the MCP server at runtime.

- `seed()` copies `seed-data.json` to `tasks.json`, shifting dates so active tasks are always near "now"
- `reset()` deletes `tasks.json`
- Every run starts from known state

## Task Schema

```json
{
  "id": "task-001",
  "title": "Buy birthday present for Mom",
  "description": "She mentioned wanting a new cookbook. Check that Italian one.",
  "status": "completed",
  "priority": "high",
  "assignee": "Alex",
  "tags": ["family", "errands"],
  "dueDate": "2025-11-15",
  "createdAt": "2025-11-01T09:00:00Z",
  "completedAt": "2025-11-14T16:30:00Z"
}
```

Valid statuses: `todo`, `in_progress`, `completed`.
Valid priorities: `low`, `medium`, `high`, `urgent`.

## MCP Tools

### Read Tools

**`list_tasks`**
- Filters: status, assignee, priority, date range
- Deliberate sloppiness: description says "get tasks" without explaining available filters. Status enum missing from schema — just says `string`.

**`get_task`**
- Single task by ID
- Deliberate sloppiness: returns `null` on missing ID instead of a helpful error message.

**`search_tasks`**
- Full-text search across title, description, and tags
- **Planted bug:** implementation only searches `title`. Description claims "searches all fields."

**`get_stats`**
- Returns counts by status, overdue count, completion rate, top assignees
- Deliberate sloppiness: description says "get statistics" without listing what stats are available.

### Write Tools

**`create_task`**
- Creates a new task with title, description, assignee, due date, priority, tags
- Deliberate sloppiness: priority accepts any string in schema but only `low`/`medium`/`high`/`urgent` are valid — undocumented.

**`update_task`**
- Updates any field on an existing task
- **Planted bug:** setting status to `completed` does not set `completedAt` timestamp.

**`delete_task`**
- Removes a task by ID
- **Planted bug:** returns `{ success: true }` even when the task ID doesn't exist.

### Summary of Planted Issues

| Type | Tool | Issue |
|------|------|-------|
| Bug | `search_tasks` | Only searches title, not description/tags |
| Bug | `update_task` | Completing a task doesn't set `completedAt` |
| Bug | `delete_task` | Returns success for nonexistent IDs |
| Schema | `list_tasks` | Missing status enum, vague description |
| Schema | `get_stats` | Doesn't describe available statistics |
| Schema | `create_task` | Priority values undocumented |
| Error UX | `get_task` | Returns null instead of error on missing ID |

## Seed Data

120 tasks for "Alex" and family. Thematically: everyday household/family life.

**Assignees:** Alex, Sam (partner), Mia (teen daughter), Leo (young son), unassigned.

**Tags:** `home`, `health`, `finance`, `errands`, `kids`, `garden`, `family`, `car`, `school`.

### 100 Completed Tasks (past 6 months)

Realistic mix: "Buy birthday present for Mom", "Renew car insurance", "Fix bathroom shelf", "Schedule flu shots", "File tax return", "Clean out garage", "Book summer campsite", "Return library books", etc.

Spread across all assignees, priorities, and tags.

### 10 Active Tasks (due within ~2 weeks)

- "Buy groceries for the week" (Alex, medium, errands)
- "Schedule dentist for Mia" (Sam, high, health/kids)
- "Fix leaky kitchen faucet" (Alex, high, home)
- "Plan Leo's birthday party" (Sam, urgent, family/kids)
- "Renew passport" (Alex, medium, errands)
- "Help Mia with science project" (Alex, high, school/kids)
- "Order new vacuum cleaner" (Sam, low, home)
- "Mow the lawn" (Leo, low, garden)
- "Drop off donation bags" (Mia, medium, errands)
- "Call plumber about water heater" (Alex, urgent, home)

Some should be overdue by 1-3 days so stats are interesting.

### 10 Future Tasks (1-3 months out)

- "Plan summer vacation" (unassigned, medium, family)
- "Replace living room curtains" (Sam, low, home)
- "Research new family car" (Alex, medium, car)
- "Sign kids up for swim lessons" (Sam, medium, kids)
- "Paint garden fence" (Alex, low, garden)
- "Organize family photo albums" (unassigned, low, family)
- "Get Mia's school supplies for fall" (Sam, medium, school/kids)
- "Service the car before road trip" (Alex, high, car)
- "Deep clean the basement" (unassigned, low, home)
- "Plan neighborhood BBQ" (Alex, medium, family)

### Date Shifting

The `seed()` function calculates an offset between the seed data's "anchor date" and today, then shifts all dates by that offset. This keeps active tasks always near "now" and completed tasks always in the recent past.

## Personas

| ID | Name | MBTI | Cluster | Group | Description |
|----|------|------|---------|-------|-------------|
| `alex` | Alex (Owner) | ESTJ | management | train | Direct and results-oriented. "What's overdue?" "Show me this week's tasks." Asks about status, priorities, deadlines. |
| `sam` | Sam (Partner) | INFP | planning | train | Collaborative and thoughtful. "Can we move the dentist to next week?" "What's on my plate?" Manages and reorganizes. |
| `mia` | Mia (Teen) | ESFP | casual | eval | Casual, impatient, informal. "do i have anything to do today" "whats leos party plan". Tests sloppy input. |
| `grandma` | Grandma Ruth | ISFJ | support | train | Helpful but not tech-savvy. "I'd like to see what Alex needs help with." "How do I add something?" Discovery questions. |
| `neighbor` | Neighbor Dave | ENTP | external | eval | Friendly and analytical. Asks about stats, patterns, search. "How many tasks do you guys finish per month?" Read-heavy. |

3 train / 2 eval split. All 5 MBTI types in different clusters — passes diversity validation.

## Config (evolve.config.mjs)

```javascript
export default {
  mcpConfig: './mcp.json',
  mcpToolPrefix: 'mcp__task-manager__',
  answererTools: 'mcp__task-manager__*',

  systemDescription: "a family task manager — Alex's household to-do list with tasks for the whole family",

  srcDirs: ['examples/task-manager'],

  writeTools: ['create_task', 'update_task', 'delete_task'],

  questionsPerPersona: 2,
  language: 'English',

  describeState: () => `Alex's family task manager with 120 tasks.
100 completed tasks from the past 6 months (household chores, errands, appointments).
10 active tasks due within the next 2 weeks (some overdue).
10 future tasks due 1-3 months from now.
Assignees: Alex, Sam (partner), Mia (teen daughter), Leo (young son), or unassigned.
Tags: home, health, finance, errands, kids, garden, family, car, school.
Priorities: low, medium, high, urgent.
Statuses: todo, in_progress, completed.`,

  seed: async (config) => {
    // 1. Read seed-data.json
    // 2. Calculate offset: today minus the anchor date in seed data
    // 3. Shift all dueDate, createdAt, completedAt by that offset
    // 4. Write result to tasks.json in examples/task-manager/
  },

  reset: async (config) => {
    // Delete tasks.json from examples/task-manager/
    // Idempotent — no error if file doesn't exist
  },

  personas: [/* 5 personas as defined above */],
};
```

## How to Run

```bash
node bin/cli.mjs -c examples/task-manager/evolve.config.mjs
```

## Expected mcp-evolve Behavior

**Run 1-2:** Generates questions, hits sloppy descriptions. Fixer improves tool schemas (adds status enum to list_tasks, documents priority values, improves get_stats description).

**Run 3-4:** Personas trigger the planted bugs. search_tasks fails when someone searches by tag/description. update_task completions lack timestamps. Fixer patches the implementation.

**Run 5+:** With bugs fixed and descriptions sharpened, success rate climbs. After 3 consecutive 100% runs, escalation kicks in — reads server.mjs source, generates harder edge-case questions.

The demo proves mcp-evolve works: watch tool descriptions improve, bugs get found and fixed, and test difficulty escalate — all automatically.
