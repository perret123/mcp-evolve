# Getting Started

## How do I install and run mcp-evolve for the first time?

1. Install: `npm install -g mcp-evolve` (or use `npx mcp-evolve`)
2. In your MCP server project directory, run: `mcp-evolve init`
3. This creates `evolve.config.mjs` (configuration), `mcp-evolve.json` (MCP server connection), and `.mcp-evolve/` (data directory)
4. Edit `evolve.config.mjs` — add your personas, point to your MCP server, list your write tools
5. Edit `mcp-evolve.json` — configure your MCP server command and environment variables
6. Test with: `mcp-evolve --dry-run` (generates questions but doesn't answer them)
7. Full run: `mcp-evolve`

## What do I need before running?

- **Claude Code CLI** installed and authenticated (`claude` command available in your terminal)
- **Node.js 20+**
- Your **MCP server running** (locally, via emulator, or a development instance)
- A `evolve.config.mjs` file in your project root

## How do I create a new persona?

A persona needs these fields:

| Field | Required | Example | Purpose |
|-------|----------|---------|---------|
| `id` | Yes | `"admin"` | Unique identifier, used in logs and golden set |
| `group` | Yes | `"train"` or `"eval"` | Train = fixer can fix failures. Eval = hold-out measurement |
| `name` | Yes | `"System Admin"` | Human-readable, shown in logs |
| `role` | Yes | `"Admin"` | Access level or job function |
| `mbti` | Recommended | `"INTJ"` | Cognitive style — must be unique within cluster |
| `cluster` | Recommended | `"management"` | Group of related personas |
| `description` | Yes | A paragraph describing who this person is | Drives question generation style |
| `concerns` | Yes | Array of strings | Topics the persona cares about — drives question content |
| `questionStyle` | Recommended | `"Direct and technical."` | How the persona communicates |

Steps:
1. Decide the cluster — does a similar persona exist? Check with `mcp-evolve status`
2. If same cluster: pick a different MBTI type than existing personas in that cluster
3. If new cluster: any MBTI is fine
4. Start with `group: 'train'` so the fixer can learn from failures
5. Move to `group: 'eval'` once the system handles the persona's concerns well

## How do I choose an MBTI type?

Pick based on the **cognitive style** you want the persona to exhibit:

| Want this behavior? | Use this preference | Types |
|--------------------|--------------------|-------|
| Focus on logic, edge cases, correctness | **T** (Thinking) | xNTx, xSTx |
| Focus on user experience, clarity, impact | **F** (Feeling) | xNFx, xSFx |
| Focus on concrete details, what actually happens | **S** (Sensing) | xSxx |
| Focus on patterns, future implications | **N** (Intuition) | xNxx |
| Direct, action-first, minimal words | **I + T** | ISTP, ISTJ, INTJ |
| Curious, exploratory, asks "why" | **E + N + P** | ENFP, ENTP |
| Strategic, systems-thinking | **N + T + J** | INTJ, ENTJ |
| Methodical, careful, by-the-book | **S + J** | ISTJ, ISFJ, ESTJ |

The key rule: **no two personas in the same cluster can have the same MBTI type**. This forces cognitive diversity.

## What are the CLI commands?

| Command | What it does |
|---------|-------------|
| `mcp-evolve` | Full run — all personas, fixer, reviewer, auto-escalation |
| `mcp-evolve init` | Scaffold starter config files |
| `mcp-evolve status` | Show metrics, persona map, golden set, recent runs |
| `mcp-evolve --dry-run` | Generate questions only (no MCP calls) |
| `mcp-evolve --persona <id>` | Run single persona |
| `mcp-evolve --limit <n>` | N questions per persona |
| `mcp-evolve --train` | Train personas only (with fixer) |
| `mcp-evolve --eval` | Eval personas only (no fixer) |
| `mcp-evolve --skip-fixer` | Don't auto-fix failures |
| `mcp-evolve --skip-reviewer` | Don't run review step |
| `mcp-evolve --escalate` | Force escalation |
| `mcp-evolve --no-escalate` | Disable auto-escalation |
| `mcp-evolve --regression` | Replay baseline questions, compare scores |
| `mcp-evolve --answerer-model <m>` | Cross-model testing (e.g. `sonnet`) |
| `mcp-evolve -c <path>` | Use custom config file |

## What does a typical config look like?

The minimum viable config needs: `mcpConfig` (path to MCP server JSON), `writeTools` (list of mutation tool names), `srcDirs` (where the fixer can edit code), and at least 1 persona.

Optional but recommended: `systemDescription` (used in prompts), `mcpToolPrefix` (for clean metric names), `buildCommand` (for fix → rebuild → replay), `prefetch` (for real entity names).
