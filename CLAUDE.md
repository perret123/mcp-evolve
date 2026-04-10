# mcp-evolve

Self-improving test harness for MCP servers.

## Repository Map
- `lib/` — Core library
  - `run.mjs` — Main loop: generate → run → grade → score → fix → replay → escalate → compete
  - `eval.mjs` — Scoring, baselines, golden set, regression, streak detection
  - `metrics.mjs` — Persistent metrics (per-persona, per-tool, system, competitions)
  - `personas.mjs` — MBTI validation, clusters, diversity
  - `claude.mjs` — Claude CLI wrapper, stream-json parser (with tool result capture)
  - `config.mjs` — Config loader with model/competition defaults
  - `compete.mjs` — Feature competition: persona groups propose + cross-vote on new features
  - `knowledge.mjs` — Evolution knowledge base (grows only when features ship)
  - `autodev.mjs` — Autonomous feature development in git worktrees (changes API code)
- `bin/cli.mjs` — CLI entry point
- `prompts/` — LLM system prompts (user-sim, answerer, grader, fixer, fixer-model-error, reviewer, escalator, proposer, voter)
- `self-test/` — mcp-evolve testing itself (MCP server, config, knowledge base)
- `examples/task-manager/` — Family task manager demo (proof of concept)
  - `task-api.mjs` — Backend API (full capabilities)
  - `server.mjs` — MCP server (thin wrapper, deliberately incomplete)
- `examples/restaurant-pos/` — Pubman reference implementation
- `docs/` — Design specs, implementation plans, round results

## Key Commands
```bash
node bin/cli.mjs --help              # CLI help
node bin/cli.mjs init                # Scaffold config
node bin/cli.mjs status              # Show metrics
node bin/cli.mjs --dry-run           # Generate prompts only
node bin/cli.mjs -c self-test/evolve.config.mjs  # Run self-test

# Task manager example (proof of concept)
node bin/cli.mjs -c examples/task-manager/evolve.config.mjs        # Full run
node bin/cli.mjs -c examples/task-manager/evolve.config.mjs -v     # Verbose
node bin/cli.mjs -c examples/task-manager/evolve.config.mjs --escalate  # Force escalation
node bin/cli.mjs -c examples/task-manager/evolve.config.mjs --compete   # Force feature competition
```

## Architecture — The Full Loop
```
SEED → GENERATE prompts → RUN (LLM + MCP tools, name-only user context)
  → GRADE (semantic verification) → SCORE
  → server errors → FIX (parallel, git worktrees) → REVIEWER MERGE → REPLAY
  → model errors (3+) → MODEL-ERROR FIXER (pattern detection, MCP improvements)
  → PROMOTE to golden set
  → STREAK CHECK:
      3x 100% → ESCALATE (harder prompts, relative dates only)
      6x 100% → FEATURE COMPETITION (3 groups propose, cross-vote, winner gets built)
  → RESET
```

## Roles
- **Fixer** — fixes specific server errors in MCP code (tools, descriptions, schemas, handlers). Can create new MCP tools wrapping existing API capabilities. Runs in parallel worktrees.
- **Reviewer** — merges parallel fixer branches. Combines multiple diffs intelligently when fixers edited the same files.
- **Model-error fixer** — analyzes 3+ model-category errors for patterns. Looks for MCP improvements (bad descriptions, missing convenience tools) that would help the LLM succeed.
- **Auto-dev** — feature development for blocked golden prompts. Can change API code, not just MCP wrappers. Deeper investigations in isolated worktrees.

## Key Design Decisions
- **Answerer gets no system prompt** — just tools. Realistic MCP simulation.
- **Answerer gets name only** (like auth session), not full persona
- **Fixer fixes MCP layer only** — wrapping existing API capabilities is fine. New API capabilities come from auto-dev or feature competition.
- **Never optimize for fewer tool calls** — correctness over efficiency
- **No truncation** in grader — full tool results are worth the tokens
- **Parallel fixers** in isolated git worktrees, merged by reviewer
- **Date handling off by default** — `dateHandling: 'off' | 'auto' | 'always'`. Obsolete prompt marking handles stale dates naturally. Enable for date-heavy MCP servers if needed.
- **Replay always runs** after fixing (not gated on buildCommand)
- **Every prompt has a probe** — before/after reads check state invariants (metamorphic testing)
- **Probes are invisible to the answerer** — it only sees the natural prompt
- **Probe model is cheap** (haiku) — probes are simple reads
- **Grader can mark prompts obsolete** — when preconditions aren't met, prompt is permanently skipped
- **KL drift guard on escalation** — Jensen-Shannon divergence checks escalated prompts against baseline/golden distribution
- **Entropy floor protects randomness** — Shannon entropy monitors persona/tool coverage

## Model Configuration (all configurable in evolve.config.mjs, all default to sonnet)
- `promptModel`: prompt generation
- `answererModel`: running prompts
- `graderModel`: semantic grading
- `fixerModel`: fixing errors + model-error analysis
- `reviewerModel`: merging fix branches
- `escalatorModel`: escalation prompts
- `proposalModel`: feature proposals in competition
- `voterModel`: voting in competition
- `probeModel`: metamorphic probes (default: haiku)

### Local Model Settings
- `localConcurrency`: max concurrent requests to local models (default: 1, matches OLLAMA_NUM_PARALLEL)
- `localIterationTimeout`: per-iteration timeout (ms) for local model tool-call loops (default: 180000)
- `localContextWindow`: context window for local models (default: model default)
- `localMaxPredict`: max output tokens for local models (default: model default)

### Model Providers
Models can be prefixed with a provider:
- `sonnet`, `opus`, `haiku` — Claude via CLI (default)
- `ollama:<model>` — Ollama (localhost:11434), e.g. `ollama:gemma4:e4b`
- `lmstudio:<model>` — LM Studio (localhost:1234)

Local models use the OpenAI-compatible `/v1/chat/completions` API.
For tool-calling roles (answerer, probes), local models connect to MCP servers directly via `lib/mcp-client.mjs`.
Fixer/reviewer must stay on Claude — they need Claude Code's built-in Edit/Read tools.

## Competition Configuration
- `competitionGroups`: number of groups (default: 3)
- `competitionGroupSize`: personas per group (default: auto)
- `competitionStreakMultiplier`: streak multiplier for trigger (default: 2x threshold)
- `competitionTestPrompts`: test prompts per winning feature (default: 3)

## Distribution Guards
- `driftThreshold`: JSD threshold for escalation drift (default: 0.4, higher = more permissive)
- `driftAction`: action on high drift — `'warn'` (default), `'reject'`, `'regenerate'`
- `personaEntropyFloor`: minimum persona entropy ratio before warning (default: 0.7)
- `toolEntropyFloor`: minimum tool entropy ratio before warning (default: 0.5)

## Self-test
The self-test MCP server (`self-test/server.mjs`) wraps mcp-evolve's own data as MCP tools.
Knowledge base in `self-test/knowledge/` — update with `/knowledge-qa` skill.

## Task Manager Example
`examples/task-manager/` — family task manager with 180 seeded tasks, 7 MCP tools, 5 personas.

Architecture: `task-api.mjs` (full backend API) → `server.mjs` (thin MCP wrapper, deliberately incomplete).
The API has more capabilities than the MCP exposes (workload analytics, bulk operations, tag lookup, history).
The MCP wrapper has sloppy descriptions and planted bugs — mcp-evolve discovers and fixes them.

See `docs/RESULTS-ROUND-*.md` for proof of concept results across 5 rounds.
