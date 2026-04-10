# mcp-evolve

Self-improving test harness for MCP servers.

Simulates diverse user personas against your MCP tools, detects failures, fixes tool descriptions and handlers automatically, escalates difficulty when everything passes, and grows a golden regression set.

**Your MCP server gets better every time you run it.**

## How it works

```
SEED (prepare test environment)
  │
  v
GENERATE prompts (persona-driven, state-aware)
  │
  v
RUN (LLM + MCP tools, name-only user context)
  │
  v
GRADE (semantic verification + metamorphic probes)
  │
  v
SCORE ──────────────────────────────────────────┐
  │                                              │
  ├── server errors ──> FIX (parallel worktrees) │
  │                       │                      │
  │                  REVIEWER MERGE              │
  │                       │                      │
  │                  REPLAY → FIXED? → golden    │
  │                                              │
  ├── model errors (3+) ──> MODEL-ERROR FIXER    │
  │                    pattern detection          │
  │                    MCP improvements           │
  │                                              │
  ├── obsolete prompts ──> REMOVE from set       │
  │                    escalation fills gaps      │
  │                                              │
  └── STREAK CHECK                               │
        3x 100% → ESCALATE (harder prompts)      │
        6x 100% → FEATURE COMPETITION            │
                   3 groups propose, cross-vote   │
                   winner gets built              │
```

## What makes this different

Most MCP testing tools **evaluate and stop**. mcp-evolve closes the loop:

1. **Personas generate prompts** — diverse cognitive styles produce different edge cases
2. **Prompts are state-aware** — the generator knows what data exists in your test environment
3. **LLM responds using your MCP tools** — authentic testing, because LLMs ARE your users
4. **Responses are graded semantically** — a grader LLM checks correctness, catching silent bugs that "succeed" but return wrong data
5. **Metamorphic probes** — before/after state checks catch side effects and invariant violations
6. **Two fixers** — server-error fixer fixes bugs; model-error fixer improves descriptions and creates convenience tools
7. **Fixes are verified** — replay the failing prompt, confirm it passes
8. **Fixed prompts become permanent** — promoted to the golden set for regression protection
9. **Obsolete prompts are removed** — data drifts, prompts that no longer apply are deleted and replaced by escalation
10. **When everything passes, it gets harder** — escalation generates prompts testing different interaction patterns
11. **When THAT passes too, personas propose features** — 3 groups propose new capabilities, cross-vote, winner gets built
12. **Adversarial prompts** — configurable rate of prompts with wrong names, nonexistent IDs, or contradictions

The key insight: **fix the tool, not the model**. Everyone else fine-tunes models to work around bad tools. mcp-evolve makes the tools better so every LLM benefits.

## Proven results

Tested across 7 rounds (~250 runs) on a family task manager with planted bugs and sloppy descriptions:

| What happened | How |
|---------------|-----|
| 2/3 planted bugs found blind | No hint comments, no targeted prompts |
| 7 → 12 MCP tools | Fixer created convenience tools wrapping existing API |
| One-line → 500-word descriptions | Each addition driven by actual model failure |
| 70% → 90%+ success rate | Converges within 20-30 runs |
| Works with local models | Qwen 3.5 35B on Ollama (zero API cost except fixer) |
| Works without reset | Obsolete prompt removal handles evolving data |

The model-error fixer is the key innovation — it sees patterns in model failures and makes MCP improvements (better descriptions, new convenience tools) that help the LLM succeed. In Round 6, it fired 16 times across 50 runs.

## Quickstart

```bash
# Scaffold config in your project
cd your-mcp-server
npx mcp-evolve init

# Edit evolve.config.mjs — add your personas, MCP config, write tools

# Dry run — see what prompts would be generated
npx mcp-evolve --dry-run

# Full run
npx mcp-evolve

# Check status
npx mcp-evolve status
```

## Architecture

### Roles

| Role | What it does | Model |
|------|-------------|-------|
| **Prompt generator** | Creates diverse, persona-driven test prompts | Any (local OK) |
| **Answerer** | Runs prompts against MCP tools — no system prompt, just tools | Any (local OK) |
| **Grader** | Semantic verification + probe invariant checks | Any (local OK) |
| **Fixer** | Fixes specific server errors in MCP code (parallel worktrees) | Claude (needs Edit/Read) |
| **Model-error fixer** | Analyzes 3+ model errors for MCP improvement patterns | Claude (needs Edit/Read) |
| **Reviewer** | Merges parallel fixer branches intelligently | Claude (needs Edit/Read) |
| **Escalator** | Generates harder prompts testing different interaction patterns | Any (local OK) |
| **Auto-dev** | Feature development for blocked golden prompts (changes API code) | Claude (needs Edit/Read) |
| **Proposer/Voter** | Feature competition — persona groups propose and cross-vote | Any (local OK) |

### API/MCP separation

mcp-evolve works best when your MCP server wraps an API:

```
task-api.mjs (full backend)  ←  server.mjs (MCP wrapper)
                                    ↑
                              mcp-evolve fixes this layer
```

The fixer improves the MCP wrapper (descriptions, schemas, new tools wrapping existing API methods). Auto-dev can modify the API itself for deeper feature work.

### Metamorphic testing

Every prompt gets a probe — a simple read-only check run before AND after:

- **Action probes**: "How many tasks exist?" before creating one → count should increase by 1
- **Read probes**: "How many tasks exist?" before a read query → count should stay the same

If the invariant is violated, it's a FAIL — even if the response looks correct. This catches silent side effects, missing fields, and state corruption.

## Configuration

`evolve.config.mjs` in your project root:

```js
export default {
  // -- MCP Server --
  mcpConfig: './mcp-evolve.json',
  mcpToolPrefix: 'mcp__my-server__',
  answererTools: 'mcp__my-server__*',
  systemDescription: 'a project management platform',

  // -- Source code (for the fixer) --
  srcDirs: ['./src'],
  buildCommand: 'npm run build',

  // -- Action detection --
  writeTools: ['create_*', 'update_*', 'delete_*'],

  // -- Environment hooks (all optional) --
  seed: async (config) => { ... },
  reset: async (config) => { ... },
  describeState: (config) => '...',
  prefetch: async (claude, config) => '...',

  // -- Personas --
  personas: [
    {
      id: 'admin',
      group: 'train',
      name: 'System Admin',
      mbti: 'INTJ',
      cluster: 'management',
      description: 'You are a system admin who...',
      concerns: ['user management', 'audit logs'],
      questionStyle: 'Direct and technical.',
    },
  ],

  // -- Prompt generation --
  promptsPerPersona: 2,
  initPrompts: 10,
  adversarialRate: 0.1,    // 10% prompts with wrong names/nonexistent IDs

  // -- Models (all default to sonnet) --
  answererModel: 'ollama:qwen3.5:35b-a3b',  // local = free
  graderModel: 'ollama:qwen3.5:35b-a3b',
  promptModel: 'ollama:qwen3.5:35b-a3b',
  fixerModel: 'sonnet',                      // needs Claude for Edit/Read
  reviewerModel: 'sonnet',

  // -- Local model tuning --
  localContextWindow: 64000,
  localMaxPredict: 16384,
};
```

### Environment hooks

| Hook | Purpose |
|------|---------|
| `seed(config)` | Prepare environment before run (import snapshot, start services) |
| `reset(config)` | Clean up after run (optional — system works without reset) |
| `describeState(config)` | Static description of test data for the prompt generator |
| `prefetch(claude, config)` | Fetch live entity names/IDs from the running system |

`reset` is optional. Without it, data accumulates naturally. Obsolete prompts (referencing deleted/changed entities) are automatically removed and replaced by escalation.

### Working without reset

mcp-evolve handles evolving data:

- **Read prompts** work forever — "what's overdue?" adapts to whatever state exists
- **Action prompts** may go obsolete after mutating state — "reassign X from Mia" fails if Mia is no longer the assignee
- **Obsolete prompts are deleted** from the prompt set automatically
- **Escalation generates replacements** based on current state
- **Metamorphic probes are relative** — before/after within a single run, not across runs

### Model providers

Models can be prefixed with a provider:
- `sonnet`, `opus`, `haiku` — Claude via CLI (default)
- `ollama:<model>` — Ollama (localhost:11434)
- `lmstudio:<model>` — LM Studio (localhost:1234)

Local models use the OpenAI-compatible API. For tool-calling roles (answerer, probes), local models connect to MCP servers directly.

Fixer/reviewer must stay on Claude — they need Claude Code's built-in Edit/Read tools.

**Tip:** Set `OLLAMA_NUM_PARALLEL` via `launchctl setenv` (macOS) and restart the Ollama app. With thinking models (Qwen 3.5), use `localMaxPredict: 16384` — thinking tokens share the output budget.

## CLI

```
npx mcp-evolve                       Full run
npx mcp-evolve init                  Scaffold starter config
npx mcp-evolve status                Show metrics, persona map, golden set

npx mcp-evolve --persona admin       Single persona
npx mcp-evolve --limit 5             5 prompts per persona
npx mcp-evolve --dry-run             Generate prompts only
npx mcp-evolve --skip-fixer          Don't auto-fix failures
npx mcp-evolve --skip-auto-dev       Don't auto-investigate blocked prompts
npx mcp-evolve --train               Train personas only (with fixer)
npx mcp-evolve --eval                Eval personas only (hold-out, no fixer)
npx mcp-evolve --escalate            Force escalation
npx mcp-evolve --compete             Force feature competition
npx mcp-evolve --regression          Replay baseline prompts, compare scores
npx mcp-evolve --answerer-model <m>  Cross-model testing
npx mcp-evolve --streak-threshold 5  Require 5x 100% before escalation
npx mcp-evolve -c <path>             Custom config file
npx mcp-evolve -v                    Verbose output
```

## Personas

Personas simulate different types of users. Each has:

- **Concerns** — what they care about (drives prompt topics)
- **Question style** — how they communicate (casual, direct, analytical)
- **MBTI type** — cognitive style that produces different edge cases
- **Cluster** — group of related personas (no two in a cluster share the same MBTI)

### Train vs eval split

- **Train personas**: when their prompts fail, the fixer edits tool code. This is where the system learns.
- **Eval personas**: no fixes applied. Pure measurement of whether improvements generalize.

## Scoring

A prompt **passes** when: response is complete AND action requirement met AND not stuck AND zero errors.

| Metric | What it measures |
|--------|-----------------|
| `completed` | Did the LLM produce a substantial response? |
| `isActionRequest` | Does the prompt ask for a mutation? (context-aware) |
| `writeToolCalled` | For actions, did the LLM call a write tool? |
| `actionRequirementMet` | Action: write tool called or valid no-op explained |
| `stuck` | Action + no write tool + 5+ reads = stuck in read loop |
| `errorsFound` | MCP tool errors during the response |

## Data files

```
.mcp-evolve/
  logs/              Raw run logs (one JSON per run)
  baselines/         Score snapshots for regression comparison
  prompt-set.json    Active prompt set (train + golden)
  golden-set.json    Permanent regression prompts (legacy mode)
  metrics.json       Accumulated metrics across runs
```

## Examples

### Task Manager

`examples/task-manager/` — a family task manager with 180 seeded tasks, a backend API (`task-api.mjs`), and a deliberately sloppy MCP wrapper (`server.mjs`) with planted bugs. 5 personas test it.

```bash
node bin/cli.mjs -c examples/task-manager/evolve.config.mjs -v
```

See `docs/RESULTS-ROUND-*.md` for detailed results across 7 rounds.

### Restaurant POS (Pubman)

See `examples/restaurant-pos/` for the Pubman configuration.

## The story

mcp-evolve was born from testing a restaurant POS MCP server. Key discoveries:

1. **The scorer lied.** `ACTION_PATTERN.test(undefined)` returned `false`, making action failures invisible. Three "100% success" runs were fake.

2. **LLMs hallucinate test data.** The prompt generator invented "Hefeweizen" but the real product was "Appenzeller Weissbier". Fix: prefetch real entity names.

3. **Fix the tool, not the model.** Bad tool descriptions cause the same failures across all models. Improving the MCP description helps every LLM.

4. **Model errors ARE MCP bugs.** If 3+ prompts fail because the model can't figure out the tools, the tools are confusing. The model-error fixer creates convenience tools and clearer descriptions.

5. **Escalation is feature development.** A test that consistently fails IS a feature gap. The fix cycle IS the implementation.

6. **Date handling is unnecessary.** Anchor-relative seed data + obsolete prompt removal handles stale dates. No date context injection needed.

7. **Don't reset if you don't need to.** Evolving data is fine — obsolete prompts get replaced, probes are relative.

## Prerequisites

- [Claude Code CLI](https://claude.ai/code) installed (`claude` command available)
- Node.js 20+
- Your MCP server running (locally or via emulator)

## License

MIT
