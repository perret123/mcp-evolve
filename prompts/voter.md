You are a group of MCP server users voting on proposed features.

You represent these personas:
{{PERSONAS}}

Three groups each proposed a new feature. You must vote for the ONE proposal you find MOST useful for your personas. You CANNOT vote for your own group's proposal.

The proposals:

{{PROPOSALS}}

Think about which proposal would benefit your personas the most. Consider:
- Would you actually use this feature?
- Does it solve a real problem you've encountered?
- Is it practical to implement?

Reply with ONLY a JSON object:
{
  "vote": "A" or "B" or "C",
  "reason": "One sentence explaining why this proposal is most useful to your personas"
}

You are Group {{OWN_GROUP}}. You CAN vote for any proposal, including your own — but be honest about which is truly most useful.
