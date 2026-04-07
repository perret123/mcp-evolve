---
name: knowledge-qa
description: Create or update Q&A knowledge files in self-test/knowledge/ for LLM context about mcp-evolve
user-invocable: true
---

# Knowledge Q&A Creator

Create or update Q&A-format knowledge files in `self-test/knowledge/` that serve as LLM context when the self-test MCP server's `knowledge_search` tool is queried.

## When to use

- After implementing a new feature or changing how mcp-evolve works
- When the user asks to document domain knowledge
- When you notice the knowledge base is missing coverage for an area
- When the self-test shows the "new-contributor" persona getting wrong answers about concepts

## Arguments

- A **topic**: `/knowledge-qa scoring` or `/knowledge-qa escalation`
- A **persona audit**: `/knowledge-qa --persona qa-lead` or `/knowledge-qa --persona all`
- No argument: scan recent changes and suggest which knowledge files need updating

## Process

### 1. Understand the topic

Before writing, research the topic:

- **Read the source code** in `lib/` — the actual implementation
- **Read existing knowledge files** in `self-test/knowledge/` to avoid duplication
- **Read the prompts** in `prompts/` to understand how the LLM uses the tools
- **Read HISTORY.md** (if it exists in `.mcp-evolve/`) for real-world context about how features evolved

### 2. Write in Q&A format

Every knowledge file follows this structure:

```markdown
# Topic Name

## What is X?

Direct answer. Lead with the most important fact.

## How does X work?

Step-by-step for processes.

## What happens when Y?

Cover edge cases and important details.
```

### 3. Writing rules

- **Questions are `##` headings** — natural questions an LLM or person would ask
- **Answers are direct** — first sentence answers the question
- **Describe what users DO, not just what code does**
- **State concrete facts** — "There are 16 MBTI types" not "there are several"
- **Explain the WHY** — not just what exists, but why
- **Never invent facts** — flag uncertainty for the user

### 4. Persona review

After writing, check from each self-test persona's perspective:

| Persona | Typical questions |
|---------|-------------------|
| **QA Lead** | "What does this metric mean?", "How is scoring calculated?", "What's a good fix rate?" |
| **DevOps** | "What broke?", "How do I check health?", "What's stale?" |
| **Architect** | "How are personas organized?", "What's the coverage model?", "How does escalation decide what to test?" |
| **New Contributor** | "What is a golden set?", "How do I add a persona?", "What's MBTI for?" |
| **Curator** | "When should I add/remove golden questions?", "How do I validate a persona?", "What makes a question stale?" |

### 5. Update the knowledge base

- Create or update the file in `self-test/knowledge/`
- Knowledge files are loaded by the self-test MCP server's `knowledge_search` tool
- Sections are split on `## ` headings and searched by keyword matching
- Keep sections focused — one concept per `##` heading for better search results

## Existing knowledge files

- `self-test/knowledge/concepts.md` — Core concepts (personas, golden set, scoring, MBTI, staleness)
- `self-test/knowledge/architecture.md` — System architecture, three loops, data flow, fix cycle
- `self-test/knowledge/getting-started.md` — Installation, first run, creating personas, CLI reference
- `self-test/knowledge/interpreting-metrics.md` — What healthy looks like, reading rates, plateau detection
- `self-test/knowledge/troubleshooting.md` — Stuck-in-read-loop, timeouts, fake names, fixer failures
- `self-test/knowledge/curation.md` — Golden set management, when to add/remove, quality bar, persona validation
