# Predicted Result: Pubman MCP — 3-Run Evaluation

**Date:** 2026-04-10
**Config:** `pubmanager/evolve.config.mjs`
**Target:** pubman-mcp (local stdio, Firestore emulator)
**User:** admin-1@tester.com (UID: kTVrH4qQsnY36ZXOttWG0taZ3qSJ)
**Business:** Taverne zum Hirschen (Dl9pWAXuNBvIueURm4FX)
**All models:** sonnet (probes included)
**Personas:** 9 (6 train, 3 eval) × 2 prompts = 18 prompts/run
**Streak config:** escalation at 2, competition at 2

---

## Run 1 — Discovery (expected ~60-80% success)

```
SETUP
├─ seed: skip (null)
├─ healthcheck: skip (null)
├─ describeState: reads .mcp-evolve/seed-state.md
│   → 145 products, 19 categories, 5 rooms, 4 employees, payment options...
└─ prefetch: sonnet calls MCP tools (list_businesses → get_floor_status + get_menu_data)
    → "0 guests present, tables empty, here are some products..."

GENERATE (sonnet, 9 personas × 2 = 18 prompts)
├─ owner:          "What was our revenue last week?" / "Show me top-selling products"
├─ floor-manager:  "Which tables are occupied?" / "Any reservations tonight?"
├─ waiter-orders:  "Seat a guest at table 3 and add 2 Espresso and a Schnitzel"
├─ waiter-payments: "What does table 5 owe?" / "Cash out table 3"
├─ waiter-mgmt:    "Move the guest from table 2 to table 5"
├─ chef:           "What's in the prep queue?" / "Show me the Warme Speisen category"
├─ accountant:     "Transaction breakdown for March 2026 by payment method"
├─ new-employee:   "How do I take an order?" / "What is a daily turnover?"
└─ customer:       "What's on the menu?" / "Any events this week?"

RUN EACH PROMPT (×18)
│
├─ PROBE BEFORE: sonnet reads current state via MCP (get_floor_status, etc.)
│
├─ ANSWER: sonnet uses MCP tools to answer the prompt
│   e.g. waiter-orders: list_businesses → get_menu_data("Espresso")
│         → manage_guest(create at table 3) → create_guest_products(2× Espresso + Schnitzel)
│
├─ PROBE AFTER: sonnet reads state again → compares before/after
│   e.g. "table 3 now has a guest with 3 products"
│
├─ GRADE: sonnet verifies response is correct and complete
│   → { success: true/false, completion: 0-1, explanation: "..." }
│
└─ SCORE: composite (completion, action detection, errors, stuck-in-read-loop)

RESULTS: ~13/18 pass, 5 fail
├─ 3 server errors (MCP tool returned an error)
│   e.g. create_guest_products failed: "productTypeId required"
│   e.g. get_aggregates timeout for broad date range
│   e.g. create_transaction missing paymentOptionId
│
└─ 2 model errors (LLM confused, no server error)
    e.g. waiter tried get_statistics instead of list_transactions
    e.g. accountant couldn't figure out date parameter format

FIX SERVER ERRORS (3 parallel git worktrees)
├─ worktree-1/: sonnet reads packages/pubman-mcp/src/tools/write.ts
│   → improves create_guest_products description: adds "productTypeId is optional"
│   → commits fix
├─ worktree-2/: sonnet fixes get_aggregates timeout handling
│   → commits fix
└─ worktree-3/: sonnet improves create_transaction schema description
    → adds example for paymentOptionId
    → commits fix

REVIEW: sonnet merges all 3 worktree branches → resolves any conflicts

BUILD: cd packages/pubman-mcp && npm run build (tsc)

REPLAY: re-run the 3 server-error prompts against fixed MCP
├─ 2/3 now pass
└─ 1/3 still fails → stays in train set for next run

MODEL ERRORS (2 accumulated → not enough for model-error fixer, need 3+)
└─ logged for next run

PROMOTE: passing prompts get consecutivePasses++
STREAK CHECK: 13/18 != 100% → streak = 0 → no escalation, no competition
RESET: skip (null)
```

**After Run 1:** pubman-mcp has 3 commits improving tool descriptions/schemas. `dist/` rebuilt. Some prompts graduated closer to golden.

---

## Run 2 — Clean sweep (100%)

```
SETUP
├─ describeState: same seed-state.md (unless re-ran extract script)
└─ prefetch: sonnet discovers live state
    → may now see guests from Run 1's write operations still in emulator

GENERATE: may generate new prompts OR reuse prompt-set.json (existing prompts)
  Train prompts: run all
  Golden prompts: run all

RUN EACH PROMPT (×18)
├─ All 18 pass (the fixes from Run 1 resolved the issues)
├─ Probes all consistent
└─ Grading all positive

FIX: nothing to fix (0 errors)

MODEL-ERROR FIXER: if 3+ model errors accumulated across runs
└─ sonnet analyzes patterns → may improve MCP tool descriptions
    e.g. "LLMs keep using get_statistics when they should use list_transactions
          → add clarification to get_statistics description"
    → commits improvement, rebuilds

PROMOTE: all prompts get consecutivePasses++
  Prompts hitting graduationStreak (10) → promoted to golden set

STREAK: 1 consecutive 100%
  < streakThreshold (2) → no escalation, no competition
```

**After Run 2:** Possibly 1 more commit (model-error fixer improving descriptions). Streak = 1.

---

## Run 3 — Streak triggers escalation + competition (100%)

```
SETUP
├─ describeState + prefetch (same as before)
└─ emulator state may have more guests/transactions from prior write-tool runs

RUN EACH PROMPT (×18)
└─ All 18 pass

STREAK: 2 consecutive 100% → hits BOTH thresholds:
  streakThreshold = 2 → ESCALATE
  competitionStreakMultiplier * streakThreshold = 1 * 2 = 2 → COMPETE

ESCALATION — generating harder prompts
─────────────────────────────────────

Sonnet receives:
  - All 18 passing prompts (too easy now)
  - The personas
  - Current system state (prefetch data)

Generates harder prompts, e.g.:
  - "Seat 3 guests at different tables, order for all of them, then split
     one bill across two payment methods"
  - "Show me a tax breakdown comparison between last week and this week,
     separated by dine-in vs takeaway rates"
  - "Move all products from table 2's guest to table 5, then check out
     table 5 with a CHF 50 voucher and the rest on card"

New harder prompts replace some train prompts → prompt set evolves

FEATURE COMPETITION
─────────────────────────────────────

SPLIT: 9 personas → 3 groups of 3
  Group A: owner, waiter-orders, chef
  Group B: floor-manager, waiter-payments, accountant
  Group C: waiter-management, new-employee, customer

PROPOSE: each group's personas discuss + propose a new MCP feature
  Group A: "Add a daily_summary tool that returns today's revenue,
            top 5 products, active guests, and open bills in one call"
  Group B: "Add a split_bill tool that takes a guest and splits their
            products across multiple payment methods in one operation"
  Group C: "Add a quick_checkout tool that seats a guest, adds products,
            and checks out in a single call for bar/quick-service"

VOTE: each group votes on the OTHER groups' proposals
  Group A votes on B and C's proposals
  Group B votes on A and C's proposals
  Group C votes on A and B's proposals

WINNER: e.g. "split_bill" wins (most votes from service-oriented personas)

TEST: sonnet generates 3 test prompts for split_bill:
  1. "Split table 3's bill: CHF 20 cash, rest on card"
  2. "Guest has CHF 45 bill, pay CHF 30 with voucher, rest cash"
  3. "Split evenly between 2 guests at the same table"

AUTO-DEV: sonnet builds the feature in an isolated worktree
  ├─ Creates packages/pubman-mcp/src/tools/write.ts: adds split_bill tool
  ├─ May create functions/lib/api/callables/payments/splitBill.js
  ├─ Updates schemas and descriptions
  ├─ Builds and verifies test prompts pass
  └─ Commits and merges

KNOWLEDGE: updates .mcp-evolve evolution knowledge base
  "Run 3: split_bill tool added via feature competition.
   Proposed by floor-manager group, won cross-vote."
```

**After Run 3:** pubman-mcp potentially has a new tool created by the competition winner. The prompt set is now harder (from escalation). Next runs will test both the new feature and the harder prompts.

---

## Summary: What changed in pubman-mcp across 3 runs

| Run | Success | Code changes | Prompt set |
|-----|---------|-------------|------------|
| 1 | ~70% | 3 commits: tool descriptions/schemas fixed | 5 failures identified, fixes replayed |
| 2 | 100% | 0-1 commits: model-error description improvements | All passing, streak = 1 |
| 3 | 100% | 1+ commits: new tool from competition | Harder prompts from escalation |

**Total: 4-5 commits to pubman-mcp, 0 lines written by a human.**

The MCP server got better — clearer tool descriptions, fixed schemas, and potentially a new convenience tool — all driven by persona-simulated usage patterns and automated fixing.

---

## How to verify this prediction

After running the 3 rounds, compare:
1. **Actual success rates** vs predicted (~70%, 100%, 100%)
2. **Number of fixer commits** vs predicted (3, 0-1, 1+)
3. **Types of errors found** — were they description/schema issues as predicted?
4. **Competition output** — did it propose a useful tool?
5. **Escalation quality** — are the harder prompts genuinely harder?

File: `.mcp-evolve/logs/` contains full run data for each round.
Metrics: `.mcp-evolve/metrics.json` tracks all scores over time.
