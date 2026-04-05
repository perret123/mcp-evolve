# mcp-evolve

Self-improving test harness for MCP servers.

Simulates diverse user personas against your MCP tools, detects failures, fixes tool descriptions and code automatically, escalates difficulty when everything passes, and grows a golden regression set.

**Your MCP server gets better every time you run it.**

## How it works

```
 100% x 3 --> ESCALATE (reads source code) --> golden set (will fail)
                                                      |
    .----------------------------------------------------'
    v
 PREFETCH --> GENERATE (Sonnet) --> ANSWER (Opus) -----> SCORE
 real data    persona questions     uses MCP tools       action detection
                                                         stuck detection
                                                              |
                                   .---- pass <--------------+
                                   |                          |
                                   v                    fail -v
                             baseline saved         FIX (Opus edits source)
                                   |                      |
                                   |                REBUILD + REPLAY
                                   |                      |
                                   |               FIXED? -> golden set
                                   |
                             REVIEW (Opus)
                             cross-question improvements
```

## Quickstart

```bash
# Install
npm install -g mcp-evolve
# or use npx

# Scaffold config in your project
cd your-mcp-server
mcp-evolve init

# Edit evolve.config.mjs — add your personas, MCP config, write tools

# Dry run — see what questions would be generated
mcp-evolve --dry-run

# Full run
mcp-evolve

# Check status
mcp-evolve status
```

## What makes this different

Most MCP testing tools **evaluate and stop**. mcp-evolve closes the loop:

1. **Personas generate questions** — diverse cognitive styles (MBTI-typed) produce different edge cases
2. **LLM answers using your MCP tools** — authentic testing, because LLMs ARE your users
3. **Failures get fixed automatically** — the fixer reads your source code and edits tool descriptions/handlers
4. **Fixes are verified** — rebuild, replay the failing question, confirm it passes
5. **Fixed questions become permanent** — promoted to the golden set for regression protection
6. **When everything passes, it gets harder** — the escalator reads your source to find untested capabilities
7. **Metrics track everything** — per-persona productivity, per-tool coverage, fix success rates, plateau detection

The key insight: **fix the tool, not the model**. Everyone else fine-tunes models to work around bad tools. mcp-evolve makes the tools better so every LLM benefits.

## Configuration

`evolve.config.mjs` in your project root:

```js
export default {
  // Your MCP server
  mcpConfig: './mcp-evolve.json',
  mcpToolPrefix: 'mcp__my-server__',
  answererTools: 'mcp__my-server__*',
  systemDescription: 'a project management platform',
  
  // Where to find and fix source code
  srcDirs: ['./src'],
  buildCommand: 'npm run build',
  
  // Which tools mutate state (for action detection)
  writeTools: ['create_*', 'update_*', 'delete_*'],
  
  // Your personas
  personas: [
    {
      id: 'admin',
      group: 'train',       // 'train' = fixer can fix, 'eval' = hold-out
      name: 'System Admin',
      role: 'Admin',
      mbti: 'INTJ',         // Cognitive style — affects question patterns
      cluster: 'management', // Personas in same cluster share context
      description: 'You are Alex, a system admin who...',
      concerns: ['user management', 'audit logs', ...],
      questionStyle: 'Direct and technical.',
    },
    // ... more personas
  ],

  // Optional: pre-fetch real data for realistic questions
  prefetch: async (claude, config) => { ... },
};
```

## CLI

```
mcp-evolve                        Full run — all personas, fixer, reviewer, escalation
mcp-evolve init                   Scaffold starter config
mcp-evolve status                 Show metrics, persona map, golden set

mcp-evolve --persona admin        Single persona
mcp-evolve --limit 5              5 questions per persona
mcp-evolve --dry-run              Generate questions only
mcp-evolve --skip-fixer           Don't auto-fix failures
mcp-evolve --skip-reviewer        Don't run cross-question review
mcp-evolve --train                Train personas only (with fixer)
mcp-evolve --eval                 Eval personas only (hold-out, no fixer)
mcp-evolve --escalate             Force escalation
mcp-evolve --no-escalate          Disable auto-escalation
mcp-evolve --regression           Replay baseline questions, compare scores
mcp-evolve --answerer-model <m>   Cross-model testing (e.g. sonnet)
mcp-evolve --streak-threshold 5   Require 5x 100% before escalation
```

## Personas

Personas are the core of mcp-evolve. Each one simulates a different type of user with distinct:

- **Concerns** — what they care about (drives question topics)
- **Question style** — how they communicate (direct commands vs analytical queries)
- **MBTI type** — cognitive style that produces different edge cases
- **Cluster** — group of related personas (no two in a cluster share the same MBTI)

Train vs eval split:
- **Train personas**: the fixer can fix failures from these — this is where the system learns
- **Eval personas**: hold-out set — no fixes applied, pure measurement of generalization

## Metrics

mcp-evolve tracks persistent metrics across runs in `.mcp-evolve/metrics.json`:

- **Per-persona**: success rate history, staleness (runs since last failure), fixes generated
- **Per-tool**: call counts, error rates, which personas exercise each tool
- **System**: fix success rate, escalation productivity, plateau detection
- **Apparatus**: tracking of prompt/scoring changes (for the meta-improvement loops)

```bash
mcp-evolve status  # Quick view of all metrics
```

## Data files

All stored in `.mcp-evolve/`:

```
.mcp-evolve/
  logs/              Raw run logs (one JSON per run)
  baselines/         Score snapshots for regression comparison
  golden-set.json    Permanent regression questions
  metrics.json       Accumulated metrics across runs
```

## The story

mcp-evolve was born from testing the [Pubman](https://github.com/mperret/pubmanager) restaurant POS MCP server. In two sessions:

1. **Session 1**: Built the harness, ran 3 train cycles. Everything showed 100%. Celebrated.

2. **Session 2**: Discovered the scorer had a bug — `ACTION_PATTERN.test(undefined)` always returned `false`, making action failures invisible. The "100%" was fake.

   After fixing the scorer, the real problems surfaced: hallucinated product names (the question generator invented "Hefeweizen" but the emulator had "Appenzeller Weissbier"), auth paths that diverged between read and write tools, and tool descriptions too vague for LLMs to construct correct parameters.

   Each problem was fixed by the loop itself. The final insight came when the escalator started generating questions by reading the source code — **"generate a harder test" and "identify the next feature" are the same operation**. A test that fails IS a feature gap. The fix cycle IS the implementation.

See `examples/restaurant-pos/` for the full Pubman configuration.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed (`claude` command available)
- Node.js 20+
- Your MCP server running (locally or via emulator)

## License

MIT
