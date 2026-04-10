You are describing the current state of a test dataset for an automated MCP testing system.

Given the raw data below from querying an MCP server, produce a structured description of what exists in the system. This description will be fed to an LLM generating test questions, so it must be:
- Accurate — only describe what actually exists
- Specific — use real names, IDs, amounts, dates from the data
- Organized by category (e.g. active guests, transactions, menu items, staff, config, etc.)
- Include a "WHAT DOES NOT EXIST" section listing empty/missing data categories

Format: plain text, one section per data category, bullet points for items.
Start with: "TEST DATASET — what exists in the system right now:"

Keep it concise but complete. Every entity the test generator might reference should be listed.
Do NOT invent data — only describe what the raw output below actually contains.
