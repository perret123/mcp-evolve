# mcp-evolve

Self-improving test harness for MCP servers.

## Repository Map
- `lib/` — Core library
  - `run.mjs` — Main loop: generate → answer → grade → score → fix → replay → escalate → compete
  - `eval.mjs` — Scoring, baselines, golden set, regression, streak detection
  - `metrics.mjs` — Persistent metrics (per-persona, per-tool, system, competitions)
  - `personas.mjs` — MBTI validation, clusters, diversity
  - `claude.mjs` — Claude CLI wrapper, stream-json parser (with tool result capture)
  - `config.mjs` — Config loader with model/competition defaults
  - `compete.mjs` — Feature competition: persona groups propose + cross-vote on new features
  - `knowledge.mjs` — Evolution knowledge base (grows only when features ship)
  - `autodev.mjs` — Autonomous fix development in git worktrees
- `bin/cli.mjs` — CLI entry point
- `prompts/` — LLM prompts (user-sim, answerer, grader, fixer, reviewer, escalator, proposer, voter)
- `self-test/` — mcp-evolve testing itself (MCP server, config, knowledge base)
- `examples/task-manager/` — Family task manager demo (proof of concept)
- `examples/restaurant-pos/` — Pubman reference implementation
- `docs/` — Design specs, implementation plans, round results

## Key Commands
```bash
node bin/cli.mjs --help              # CLI help
node bin/cli.mjs init                # Scaffold config
node bin/cli.mjs status              # Show metrics
node bin/cli.mjs --dry-run           # Generate questions only
node bin/cli.mjs -c self-test/evolve.config.mjs  # Run self-test

# Task manager example (proof of concept)
node bin/cli.mjs -c examples/task-manager/evolve.config.mjs        # Full run
node bin/cli.mjs -c examples/task-manager/evolve.config.mjs -v     # Verbose
node bin/cli.mjs -c examples/task-manager/evolve.config.mjs --escalate  # Force escalation
node bin/cli.mjs -c examples/task-manager/evolve.config.mjs --compete   # Force feature competition
```

## Architecture — The Full Loop
```
SEED → GENERATE (Sonnet) → ANSWER (Opus, name-only user context)
  → GRADE (Sonnet, semantic verification) → SCORE
  → FIX (parallel, git worktrees) → MERGE (Claude) → REPLAY → PROMOTE to golden set
  → REVIEW (cross-question polish)
  → STREAK CHECK:
      3x 100% → ESCALATE (harder questions from source, relative dates only)
      6x 100% → FEATURE COMPETITION (3 groups propose, cross-vote, winner gets built)
  → RESET
```

## Key Design Decisions
- **Answerer gets name only** (like auth session), not full persona — realistic MCP simulation
- **Grader gets name too** — consistent with what answerer knows
- **Fixer cannot create new tools** — only fix existing ones. New tools come from feature competition.
- **Never optimize for fewer tool calls** — correctness over efficiency. Fixer/reviewer must not add "minimize calls" language.
- **No truncation** in grader — full tool results are worth the tokens
- **Parallel fixers** in isolated git worktrees, merged by Claude
- **Escalation uses relative dates** ("next week", not "April 10th") — stays valid across runs
- **Replay always runs** after fixing (not gated on buildCommand)
- **Every question has a probe** — before/after reads check state invariants (metamorphic testing)
- **Probes are invisible to the answerer** — it only sees the natural question
- **Probe model is cheap** (haiku) — probes are simple reads

## Model Configuration (all configurable in evolve.config.mjs, all default to sonnet)
- `questionModel`: question generation
- `answererModel`: answering questions
- `graderModel`: semantic grading
- `fixerModel`: fixing errors
- `reviewerModel`: reviewing descriptions
- `escalatorModel`: escalation questions
- `proposalModel`: feature proposals in competition
- `voterModel`: voting in competition
- `probeModel`: metamorphic probes (default: haiku)

## Competition Configuration
- `competitionGroups`: number of groups (default: 3)
- `competitionGroupSize`: personas per group (default: auto)
- `competitionStreakMultiplier`: streak multiplier for trigger (default: 2x threshold)
- `competitionTestQuestions`: test questions per winning feature (default: 3)

## Self-test
The self-test MCP server (`self-test/server.mjs`) wraps mcp-evolve's own data as MCP tools.
Knowledge base in `self-test/knowledge/` — update with `/knowledge-qa` skill.

## Task Manager Example
`examples/task-manager/` — family task manager with 120 seeded tasks, 7 tools, 5 personas.
See `docs/RESULTS-ROUND-1.md` for 35-run proof of concept results.
Round 2 starts from original server (planted bugs + sloppy descriptions) with all mcp-evolve improvements.
