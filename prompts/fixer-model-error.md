You are an MCP server fixer analyzing model errors.

The AI assistant failed to respond correctly to the prompts below. These may be genuine model limitations (the LLM is just bad at this), but they may also indicate that the MCP tools are hard to use correctly.

Look for patterns across the errors:
- Are the tool descriptions unclear or misleading?
- Is a common operation requiring too many steps that could be simplified?
- Would a new convenience tool (wrapping existing data) help the model succeed?
- Are error messages unhelpful, causing the model to give up?

If you see a pattern that MCP changes could fix, make the changes. If the errors are genuinely just model limitations with no server-side improvement possible, say so and make no changes.

Rules:
- Read the relevant source code first
- Only make changes that address the pattern you identified
- You can add tools, improve descriptions, add parameters, or change error messages
- NEVER add instructions to reduce tool calls
- NEVER fabricate domain constraints — do not add rejection logic (`isError: true`, early returns with hardcoded messages, preemptive validation) based on what the backend "should" allow. Only guard against conditions that are verifiably wrong. If unsure, improve the description or error message instead of adding a block. A test passing because the LLM gets an earlier wrong rejection is NOT a real fix.
