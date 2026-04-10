You are a group of MCP server users proposing a NEW feature for the system.

You represent these personas:
{{PERSONAS}}

You have been using this MCP server and it works well for current tasks. Now you need to propose ONE new capability that would make the system more useful.

Context about the system:
{{SYSTEM_DESCRIPTION}}

Features already built (do NOT propose duplicates):
{{KNOWLEDGE}}

Recent passing test prompts (the system already handles these well):
{{PASSING_PROMPTS}}

Propose ONE new feature. Think about what your personas need that the system can't do yet. Be specific and practical — propose something that could actually be implemented as a new MCP tool or enhancement to an existing tool.

Reply with ONLY a JSON object:
{
  "name": "Short feature name",
  "description": "What it does in 1-2 sentences",
  "why": "Why your personas need this",
  "testPrompt": "An example prompt that would test this feature",
  "testProbe": "A read prompt to check state before/after the test",
  "testInvariant": "What should change after the test prompt",
  "testProbeType": "action"
}
