# mcp-evolve

Self-improving test harness for MCP servers.

Simulates diverse user personas against your MCP tools, detects failures, fixes tool descriptions automatically, escalates difficulty when everything passes, and grows a golden regression set.

**Your MCP server gets better every time you run it.**

## How it works

```
SEED (prepare test environment)
  │
  v
DESCRIBE STATE + PREFETCH (what data exists + live IDs)
  │
  v
GENERATE (Sonnet) ──> ANSWER (Opus) ──> GRADE (Sonnet) ──> SCORE
persona questions      uses MCP tools    semantic check      action detection
state-aware            name-only user    full tool results   stuck detection
  │                                                              │
  │                     ┌─── pass <─────────────────────────────┘
  │                     │                                        │
  │                     v                                  fail ─v
  │              baseline saved              FIX (parallel, git worktrees)
  │                     │                           │
  │                     │                    MERGE (Claude combines all)
  │                     │                           │
  │                     │                    REPLAY ──> FIXED? → golden set
  │                     │
  │              REVIEW (Opus)
  │              cross-question improvements
  │                     │
  │              STREAK CHECK
  │                     │
  │              3x 100% ──> ESCALATE (reads source, relative dates)
  │                               │
  │              6x 100% ──> FEATURE COMPETITION
  │                            3 persona groups propose features
  │                            cross-vote (can't rubber-stamp own)
  │                            winner → golden set + knowledge base
  │
  v
RESET (clean environment)
```

## Quickstart

```bash
# Scaffold config in your project
cd your-mcp-server
npx mcp-evolve init

# Edit evolve.config.mjs — add your personas, MCP config, write tools

# Dry run — see what questions would be generated
npx mcp-evolve --dry-run

# Full run
npx mcp-evolve

# Check status
npx mcp-evolve status
```

## What makes this different

Most MCP testing tools **evaluate and stop**. mcp-evolve closes the loop:

1. **Personas generate questions** — diverse cognitive styles (MBTI-typed) produce different edge cases
2. **Questions are state-aware** — the generator knows what data exists in your test environment
3. **LLM answers using your MCP tools** — authentic testing, because LLMs ARE your users
4. **Answers are graded semantically** — a grader LLM checks if the answer is actually correct, catching silent bugs that "succeed" but return wrong data
5. **Failures get fixed in parallel** — each error gets its own git worktree, all fix simultaneously, Claude merges the results
6. **Fixes are verified** — replay the failing question, confirm it passes
7. **Fixed questions become permanent** — promoted to the golden set for regression protection
8. **When everything passes, it gets harder** — the escalator reads your source to find untested capabilities
9. **When THAT passes too, personas propose features** — 3 groups propose new capabilities, cross-vote, and only features the other groups prefer get built
10. **Blocked questions escalate** — after 3 consecutive failures, questions are blocked and flagged for deeper investigation
11. **No new questions until existing ones pass** — golden-only mode focuses on fixing before exploring
12. **Metrics track everything** — per-persona productivity, per-tool coverage, fix success rates, competition results

The key insight: **fix the tool, not the model**. Everyone else fine-tunes models to work around bad tools. mcp-evolve makes the tools better so every LLM benefits.

## Configuration

`evolve.config.mjs` in your project root:

```js
export default {
  // -- MCP Server --
  mcpConfig: './mcp-evolve.json',        // MCP server connection config
  mcpToolPrefix: 'mcp__my-server__',     // stripped for clean metric names
  answererTools: 'mcp__my-server__*',    // tool pattern for the answerer
  systemDescription: 'a project management platform',

  // -- Source code (for the fixer) --
  srcDirs: ['./src'],
  buildCommand: 'npm run build',

  // -- Action detection --
  writeTools: ['create_*', 'update_*', 'delete_*'],  // write/mutation tools

  // -- Environment hooks (all optional) --
  seed: async (config) => { ... },            // prepare test environment
  reset: async (config) => { ... },           // clean up after run
  describeState: (config) => '...',           // static description of test data
  prefetch: async (claude, config) => '...',  // fetch live IDs/names

  // -- Personas --
  personas: [
    {
      id: 'admin',
      group: 'train',        // 'train' = fixer can fix, 'eval' = hold-out
      name: 'System Admin',
      role: 'Admin',
      mbti: 'INTJ',          // cognitive style — affects question patterns
      cluster: 'management', // no two in a cluster share the same MBTI
      description: 'You are Alex, a system admin who...',
      concerns: ['user management', 'audit logs', ...],
      questionStyle: 'Direct and technical.',
    },
    // ...
  ],
};
```

### Environment hooks

The hooks let you control the test environment without mcp-evolve knowing anything about your infrastructure:

| Hook | Signature | Purpose |
|------|-----------|---------|
| `seed(config)` | async | Prepare environment before run (import snapshot, start services) |
| `reset(config)` | async | Clean up after run (restart emulator, clear data) |
| `describeState(config)` | sync, returns string | Static description of test data — fed to question generator so it knows what exists |
| `prefetch(claude, config)` | async, returns string | Fetch live entity names/IDs from the running system |

`describeState` is the critical one for realistic testing. It tells the question generator what data exists so it generates answerable questions:

```js
describeState: () => `
  ACTIVE: 3 users (admin, editor, viewer), 5 projects, 12 tasks
  COMPLETED: 8 tasks closed this week
  EMPTY: no notifications, no comments on project "Alpha"
  DO NOT ASK ABOUT: billing (not implemented yet)
`,
```

### Smart question gating

- **Golden questions failing?** Skip new question generation — focus on fixing existing failures first
- **Question blocked (3+ consecutive fails)?** Skip it, flag for manual investigation
- **Blocked questions exist?** No escalation — fix what's broken before generating harder tests
- **3x 100% streak?** Escalate — read source code to find untested capabilities

## CLI

```
npx mcp-evolve                       Full run — all personas, fixer, reviewer
npx mcp-evolve init                  Scaffold starter config
npx mcp-evolve status                Show metrics, persona map, golden set

npx mcp-evolve --persona admin       Single persona
npx mcp-evolve --limit 5             5 questions per persona
npx mcp-evolve --dry-run             Generate questions only
npx mcp-evolve --skip-fixer          Don't auto-fix failures
npx mcp-evolve --skip-reviewer       Don't run cross-question review
npx mcp-evolve --skip-auto-dev       Don't auto-investigate blocked questions
npx mcp-evolve --train               Train personas only (with fixer)
npx mcp-evolve --eval                Eval personas only (hold-out, no fixer)
npx mcp-evolve --escalate            Force escalation
npx mcp-evolve --no-escalate         Disable auto-escalation
npx mcp-evolve --regression          Replay baseline questions, compare scores
npx mcp-evolve --answerer-model <m>  Cross-model testing (e.g. sonnet)
npx mcp-evolve --skip-grading       Skip semantic answer grading
npx mcp-evolve --fixer-retries 2    Max fix attempts per question (default 1)
npx mcp-evolve --streak-threshold 5  Require 5x 100% before escalation
npx mcp-evolve --compete            Force feature competition
npx mcp-evolve --no-compete         Disable feature competition
npx mcp-evolve -c <path>             Use custom config file
npx mcp-evolve -v                    Verbose output
```

## Personas

Personas simulate different types of users. Each has:

- **Concerns** — what they care about (drives question topics)
- **Question style** — how they communicate (direct commands vs analytical queries)
- **MBTI type** — cognitive style that produces different edge cases
- **Cluster** — group of related personas (no two in a cluster share the same MBTI)

### Train vs eval split

- **Train personas**: when their questions fail, the fixer edits tool code. This is where the system learns.
- **Eval personas**: no fixes applied. Pure measurement of whether improvements generalize to unseen users.

### MBTI diversity

Each persona gets an MBTI type. Rule: **no two personas in the same cluster may share the same MBTI**. This ensures cognitive diversity — an ISTP operator and an ENFJ coordinator ask fundamentally different questions about the same tools.

```
Analysts:  INTJ INTP ENTJ ENTP  — logic, patterns, edge cases
Diplomats: INFJ INFP ENFJ ENFP  — user experience, clarity
Sentinels: ISTJ ISFJ ESTJ ESFJ  — concrete details, process
Explorers: ISTP ISFP ESTP ESFP  — hands-on, action-first
```

## Scoring

Each question is scored on:

| Metric | What it measures |
|--------|-----------------|
| `completed` | Did the LLM produce a substantial answer? |
| `isActionRequest` | Does the question ask for a mutation? (context-aware — "how does adding work?" is NOT an action) |
| `writeToolCalled` | For action requests, did the LLM actually call a write tool? |
| `stuck` | Action request + no write tool + 5+ reads = stuck in read loop |
| `errorsFound` | MCP tool errors during the answer |

A question **passes** when: completed AND not stuck AND zero errors.

## Metrics

Persistent metrics across runs in `.mcp-evolve/metrics.json`:

- **Per-persona**: success rate history, staleness (runs since last failure), fixes generated
- **Per-tool**: call counts, error rates, which personas exercise each tool
- **System**: fix success rate, escalation productivity, plateau detection

```bash
npx mcp-evolve status  # Quick view of all metrics
```

## Data files

```
.mcp-evolve/
  logs/              Raw run logs (one JSON per run)
  baselines/         Score snapshots for regression comparison
  golden-set.json    Permanent regression questions
  metrics.json       Accumulated metrics across runs
```

## Self-test

mcp-evolve can test itself. The `self-test/` directory contains:

- An MCP server (`server.mjs`) that wraps mcp-evolve's own data as MCP tools
- 5 personas (QA lead, DevOps, Architect, New Contributor, Curator)
- A knowledge base about mcp-evolve concepts

```bash
cd /path/to/mcp-evolve
npx mcp-evolve -c self-test/evolve.config.mjs --dry-run
```

## The story

mcp-evolve was born from testing the [Pubman](https://github.com/mperret/pubmanager) restaurant POS MCP server. Key discoveries along the way:

1. **The scorer lied.** `ACTION_PATTERN.test(undefined)` returned `false`, making action failures invisible. Three "100% success" cycles were fake. Lesson: score what matters.

2. **LLMs hallucinate test data.** The question generator invented "Hefeweizen" but the real product was "Appenzeller Weissbier". The LLM searched 10+ times and never found it. Fix: prefetch real entity names from the system.

3. **Auth paths diverge silently.** Read tools worked in dev mode, write tools didn't — different code paths. Only caught when the full pipeline reached a write call.

4. **Escalation is feature development.** "Generate a harder test" and "identify the next feature" are the same operation. A test that fails IS a feature gap. The fix cycle IS the implementation.

5. **Context-aware action detection matters.** "How does the system add a product?" is a question, not a command. Naive verb matching (`/\badd\b/`) produces false positives. mcp-evolve uses context patterns to distinguish.

6. **Don't escalate until you've fixed what's broken.** Adding harder questions while existing ones fail just drags scores down. Golden-only mode: fix first, explore later.

## Examples

### Task Manager (proof of concept)

`examples/task-manager/` — a family task manager with 120 seeded tasks, deliberately sloppy tool descriptions, and 3 planted bugs. 5 personas (Alex, Sam, Mia, Grandma Ruth, Neighbor Dave) test it.

```bash
node bin/cli.mjs -c examples/task-manager/evolve.config.mjs -v
```

Round 1 (35 runs) showed mcp-evolve improving the server from 70% → 100%, adding normalizeStatus, overdue filtering, tag filters, priority sorting, pagination, and a cross-assignee hint system — all automatically. See `docs/RESULTS-ROUND-1.md`.

### Restaurant POS (Pubman)

See `examples/restaurant-pos/` for the full Pubman configuration.

## Prerequisites

- [Claude Code CLI](https://claude.ai/code) installed (`claude` command available)
- Node.js 20+
- Your MCP server running (locally or via emulator)

## License

MIT
