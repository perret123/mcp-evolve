---
name: init-seed
description: Auto-generate seed state description from a live MCP server data source. Use when setting up mcp-evolve for a new project or refreshing stale describeState.
user-invocable: true
---

# Init Seed — Auto-generate describeState from live data

Scans a running MCP server to discover what test data exists, then generates a structured `describeState` description that mcp-evolve uses for prompt generation.

## When to use

- Setting up mcp-evolve for a new MCP server with existing data
- Refreshing the state description after changing test seed data
- When the current describeState is stale or incomplete

## Prerequisites

1. `evolve.config.mjs` must exist with `mcpConfig` pointing to a valid MCP server config
2. `seedDataSource` must be configured with a `discoveryPrompt`
3. The MCP server must be running and accessible

## Process

### 1. Check configuration

Read `evolve.config.mjs` and verify:
- `seedDataSource` is configured
- `seedDataSource.discoveryPrompt` is set
- `mcpConfig` file exists

If `seedDataSource` is not configured, help the user add it. The `discoveryPrompt` should list MCP tool calls that explore the data:

```javascript
seedDataSource: {
  discoveryPrompt: 'Call list_businesses, then for each business call get_business_config, get_menu_data, get_floor_status...',
  discoveryModel: 'haiku',  // optional
},
```

### 2. Run init-seed

```bash
node bin/cli.mjs --init-seed
# or with a custom config:
node bin/cli.mjs --init-seed -c path/to/evolve.config.mjs
```

### 3. Review output

The command will:
1. Connect to the MCP server and run the discovery prompt
2. Parse tool results to understand what data exists
3. Use an LLM to generate a structured state description
4. Write it to `{dataDir}/seed-state.md`
5. Print the description and next steps

### 4. Wire it into config

After reviewing the generated description, add it to `evolve.config.mjs`:

```javascript
import { readFileSync } from 'node:fs';

export default {
  // ... other config ...
  describeState: () => readFileSync('.mcp-evolve/seed-state.md', 'utf-8'),
};
```

## Troubleshooting

- **"No seedDataSource configured"**: Add the `seedDataSource` block to your config
- **"MCP config not found"**: Check that `mcpConfig` path is correct
- **"Discovery returned an error"**: Make sure the MCP server is running
- **Empty/bad results**: Adjust the `discoveryPrompt` to call different tools
