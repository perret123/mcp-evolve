# Round 10: Pubman MCP — Runs 1-8 (sonnet baseline)

**Date:** 2026-04-12, ~01:55 UTC start — ~14:28 UTC (run 8 completed)
**Target:** pubman-mcp (local stdio, Firestore emulator)
**Config:** `pubmanager/evolve.config.mjs`
**Models:** All sonnet (answerer, grader, prompter, fixer, reviewer, promoter), haiku (probes)
**Personas:** 9 (owner, floor-manager, waiter-orders, waiter-payments, waiter-management, chef, accountant, new-employee, customer)
**Spec 2 config:** promptsPerPersona: 3, holdoutPerPersona: 1, maxPromotionsPerRun: 3, overfittingThreshold: 0.1
**Starting state:** Clean-slate v2 migration — empty `prompt-set.json`, no golden, no baselines. `failing-prompts.json` preserved from Spec 1 (Round 9 contamination entries still active as anti-examples).

This is the first round using Spec 2's Train/Eval/Golden redesign architecture:
- Fresh train+holdout generated every run (27 prompts: 18 train-fixer + 9 train-holdout)
- Golden tier built incrementally via the Promoter-Agent
- Pre-fix + post-fix scoring on every tier
- Overfitting detection (never triggered this round)
- Replay-all (every prompt re-run post-fix, not just failures)

---

## Summary Table (Runs 1-8)

| Run | Golden pre→post | Train pre→post | Holdout pre→post | Promoted | Duration | Notes |
|-----|-----------------|----------------|-------------------|----------|----------|-------|
| 1   | —               | 44→89%         | 44→67%            | 3        | 1h29m    | First run, no golden. Deep-fix ran for 6 prompts |
| 2   | 100→100% (3p)   | 56→100%        | 44→89%            | 3        | 29m      | Train hit 100% post-fix |
| 3   | 83→100% (6p)    | 78→78%         | 13→100%           | 3        | 55m      | 1 golden marked obsolete. Holdout 13→100% |
| 4   | 78→100% (9p)    | 61→72%         | 56→100%           | 3        | 1h01m    | **Escalation triggered** (streak=3). Drift warning JSD=0.59 |
| 5   | 67→100% (12p)   | 61→83%         | 78→100%           | 3        | 1h06m    | Escalation (streak=4). Drift warning JSD=0.61 |
| 6   | 71→71% (14p)    | 67→67%         | 44→44%            | 3        | 12m      | **No fixer ran** (no server errors). 1 golden obsolete |
| 7   | 77→94% (17p)    | 56→89%         | 56→89%            | 0        | 58m      | Promoter timed out (exit 143, 3m limit) |
| 8   | 82→100% (17p)   | 39→89%         | 67→89%            | 0        | 1h13m    | Promoter timed out. Golden back to 100% post-fix |

**Run 4 was aborted mid-fix-phase (killed by user). No log written.**

## Key Metrics

- **Golden set growth:** 0 → 17 prompts across 8 runs (15 promoted + 2 removed as obsolete)
- **Golden post-fix:** 100% in runs 2-5 and 8; dipped to 71% (run 6, no fixer ran) and 94% (run 7)
- **Overfitting events:** 0 (holdout consistently improved alongside train)
- **Escalation triggers:** Runs 4-5 (golden streak ≥ 3)
- **Promoter timeouts:** Runs 7-8 (3-min default; bumped to 5-min after run 8)
- **Total wall time:** ~7 hours for 8 runs

## Golden Set (17 prompts at close)

| # | Persona | Capability Tag | Promoted in |
|---|---------|---------------|-------------|
| 1 | owner | daily-turnover-lookup | Run 1 |
| 2 | floor-manager | reservation-floor-status-cross-check | Run 1 |
| 3 | new-employee | knowledge-base-concept-lookup | Run 1 |
| 4 | chef | kitchen-prep-status-lookup | Run 2 |
| 5 | accountant | quarterly-tax-type-breakdown | Run 2 |
| 6 | owner | monthly-revenue-payment-breakdown | Run 2 |
| 7 | accountant | voucher-redemption-status-lookup | Run 3 |
| 8 | owner | staff-transaction-comparison | Run 3 |
| 9 | waiter-payments | per-guest-bill-lookup | Run 3 |
| 10 | owner | staff-revenue-breakdown | Run 4 |
| 11 | new-employee | named-guest-presence-lookup | Run 4 |
| 12 | customer | menu-item-detail-lookup | Run 4 |
| 13 | owner | monthly-turnover-trend-analysis | Run 6 |
| 14 | chef | kitchen-station-routing-lookup | Run 6 |
| 15 | waiter-payments | guest-checkout-with-tip | Run 6 |
| — | *(removed)* | *(1 obsolete removed in run 3, 1 in run 6)* | |

**Persona coverage:** 7 of 9 personas have golden prompts. Missing: waiter-management, waiter-orders. These personas predominantly generate write-tool prompts (table moves, order additions) which are harder to promote to golden due to idempotency criterion 3.

## Fixer Changes (committed to pubmanager)

All fixer improvements from 8 runs were committed in `pubmanager d19f163d`:

### Backend (functions/)
- **`createGuestProducts.js`** — Fixed stale `totalBillInt` in return value (was returning pre-transaction amount)
- **`getFloorStatus.js`** — Changed guest ordering from `lastModified` to `lastAction`

### MCP tool descriptions (packages/pubman-mcp/src/tools/)
- **`get_floor_status`** — Guest nicknames in table display; "Guests Not Seated" section for detached guests; pre-computed total open bills; always-includeGuests guidance for name lookups
- **`get_guest_details`** — Separate display for deleted/removed bill items
- **`get_preparation_status`** — Explain `activeOnly: false` for cooked-vs-cancelled checks
- **`list_daily_turnovers`** — Guide users to `list_transactions` for revenue queries; fix payment-option name fallback
- **`create_guest_products`** — Check overflow guests when resolving tableName; better empty-table error
- **`create_transaction`** — Removed fabricated CHF 0.00 guard; handle overpayment edge case via backend sweep
- **`finalize_daily_turnover`** — Clearer preview vs. finalize; explicit "not for revenue queries" guidance
- **`guest_goes`** — Action-first description; handle `no_open_bill` error code
- **`prompts.ts`** — Guest departure workflow section
- **`helpers.ts`** — Distinguish bill-item IDs from menu product IDs in error hints

## Observations

### What worked well

1. **Ephemeral train eliminates state pollution.** Fresh prompts each run means no accumulated garbage from repeated write-tool execution. This was the primary motivation for Spec 2 and it delivered immediately.

2. **Holdout is an honest signal.** Holdout tracked train improvements without gaming — when the fixer fixed real MCP issues, holdout improved too. No overfitting detected in 8 runs.

3. **Promoter builds golden steadily.** 3 nominations per run is the cap, and the promoter consistently hit it in runs 1-6. The capability tags are semantically meaningful and the promoter correctly rejected near-duplicates.

4. **Knowledge-dir hints (added after run 5).** After adding "check the knowledge/ directory" guidance to agent prompts, runs 6+ agents have access to domain documentation. Effect on fixer/reviewer quality is TBD — the promoter timed out in runs 7-8 so we don't have a clean comparison yet.

5. **Fabricated-constraint defense held.** The CHF 0.00 guard from Round 9 was removed by the fixer and the reviewer let it through — the audit checklist correctly identified that the backend handles zero-bill cases on its own.

### What needs attention

1. **Golden prompt staleness from emulator state drift.** Golden prompts referencing specific guests (e.g., "Bruno at Tisch 6") fail when that guest departs between runs. The obsolete-marking system catches some of these, but 4 golden prompts failed in run 6 (71% pre-fix). Mitigation: the `seed` function should restore a known-good emulator state before each run; currently there is no seed/reset between runs.

2. **Promoter timeout.** The 3-minute default was too short once the golden set grew past 12 prompts (the payload gets large). Bumped to 5 minutes after run 8. Consider making it proportional to golden-set size.

3. **Write-tool personas underrepresented in golden.** `waiter-management` and `waiter-orders` have no golden prompts because their prompts are write-heavy and fail the promoter's idempotency criterion. This is by design (non-idempotent prompts would produce garbage on replay), but it means the golden regression suite has a read-heavy bias.

4. **`products_already_swept` recurring error.** The `create_transaction` tool fails when products have already been swept by a prior transaction. This happens when the emulator state accumulates guests with partially-paid bills. Again, a seed/reset would fix this.

5. **Action completion rate is volatile.** The "action=33.3%" in some post-fix runs reflects the fixer improving read-path issues while write-path prompts remain stuck. The action-completion metric needs to be split by lifecycle tier to be more informative.

## Architecture assessment

Spec 2's redesign achieved its three goals:
1. **Silent eval bug fixed.** `holdout` is a real, populated tier (44-100% success rates observed). The old `scores.eval` was always 0.
2. **State pollution eliminated.** Ephemeral train means no persistent write-tool garbage.
3. **Overfitting signal available.** The `trainDelta > threshold && holdoutDelta < -threshold` check ran every run; never triggered, which is the correct result for a fixer that's fixing real issues.

The Promoter-Agent is the right abstraction for golden-set curation — it makes nuanced judgment calls about semantic distinctness and idempotency that a mechanical streak-counter could not.

## Next steps

1. **Add seed/reset to the config** — restore emulator to a known-good state before each run to eliminate golden staleness and `products_already_swept` errors
2. **Run the qwen comparison** — 10 runs with `ollama:qwen3.5:35b-a3b-coding-nvfp4` as answerer, same golden set
3. **Try opus for reviewer + promoter** — the two highest-judgment roles
4. **Wire MCP knowledge tools into agent allowedTools** (Option B from the knowledge-dir discussion) — especially useful for the promoter and reviewer
5. **Consider per-persona golden caps** — currently the promoter can nominate from any persona, leading to owner-heavy golden (4 of 17). A per-persona cap would force coverage diversity.
