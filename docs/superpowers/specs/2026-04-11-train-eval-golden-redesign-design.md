# Train / Eval / Golden Redesign

## Context

Round 8 and Round 9 of the pubman evolution revealed three coupled issues in how mcp-evolve organises its test sets:

1. **Silent eval bug.** Pubman's config declares 9 personas, 3 of them marked `group: 'eval'` (intended as a hold-out measurement set). In practice, `scores.eval` is `0` in every run of both rounds — 20+ runs silently mis-reported. Root cause: the `group` field is overloaded. Personas use `group: 'train' | 'eval'` to mark hold-out intent; prompts in `prompt-set.json` use `group: 'train' | 'golden'` to mark lifecycle. The run.mjs scoring aggregation filters prompts by `q.group === 'eval'`, which never matches any prompt because prompts only carry train/golden — the eval semantics from the persona side never propagates to the prompt side.
2. **State pollution from persisted write-prompts.** Prompts are persisted in `prompt-set.json` and re-run across runs. Write-tool prompts (e.g. "seat a guest at Tisch 5") execute on the shared emulator state, and a single such prompt running 10 times creates 10 guests. This biases subsequent runs (the "current state" the answerer observes is noisy) and makes escalated prompts reference accumulating garbage.
3. **No overfitting signal.** The fixer can optimise against specific prompts by adding targeted logic that makes the exact prompt pass without improving general MCP quality — but because the `scores.eval` bucket never populates, this overfitting is invisible. The Round 9 fabricated-guard incident is an example: seat-guest prompts became green after the guard was added (short-circuited before hitting the backend), but any prompt exercising multi-occupancy would have failed. We have no orthogonal signal that catches this.

This spec redesigns the train / eval / golden structure to address all three. It introduces an ephemeral-per-run train+holdout generation, a persistent earned-golden set, and a `Promoter-Agent` that handles graduation in a world where exact-prompt streaks are no longer meaningful. It depends on the Reviewer Audit Upgrade spec (`2026-04-11-reviewer-audit-upgrade-design.md`) for the fabrication-safety layer — the two specs are staged: Spec 1 first, Spec 2 on top.

## Goals

- Separate two orthogonal concepts onto two fields on prompts: **lifecycle** (`train | golden`) and **evaluation** (`fixer | holdout`)
- Remove `group` from personas entirely — eval semantics move to per-prompt
- Train and holdout prompts generated fresh every run from current data context — "Schwingung", reflecting actual emulator state
- Holdout prompts are split in-batch from the same generation as train (not a separate static set) — measures overfitting on the same data distribution
- Overfitting detection: score `train` and `holdout` separately pre-fix and post-fix; detect when train improves but holdout does not
- Golden is the only persistent tier and the only source of cross-run comparability
- Graduation happens via a **Promoter-Agent** that nominates passing train prompts after each run (streak-based graduation no longer fits an ephemeral-train world)
- Clean slate migration: all existing prompts in `prompt-set.json` are discarded (contamination risk from Round 8/9 era)

## Non-goals

- Not changing the fixer (Spec 1 covers fabrication prevention)
- Not changing probe/invariant generation machinery (but Spec 1's reviewer naturally cleans contaminated invariants as a side effect, so this spec does not need separate probe-regeneration logic)
- Not supporting parametric prompt templates or shape-based graduation (deferred — a simpler Promoter-Agent covers the case)
- Not keeping backward compatibility with the old `prompt-set.json` schema — the file is wiped and the version is bumped

## Design

### Three tiers, orthogonal fields

Prompt entries (in both persisted `prompt-set.json` and the transient per-run scored list) have two independent fields:

```json
{
  "prompt": "...",
  "persona": "<id>",
  "lifecycle": "train" | "golden",
  "evaluation": "fixer" | "holdout",
  ...
}
```

Semantic matrix:

| | **`evaluation: fixer`** | **`evaluation: holdout`** |
|---|---|---|
| **`lifecycle: train`** | Ephemeral per run; fixer sees errors; scored as `train` | Ephemeral per run; fixer does NOT see errors; scored as `holdout` |
| **`lifecycle: golden`** | Persistent; earned via Promoter; fixer sees errors (regression); scored as `golden` | Not produced in V1 — reserved for future "hold-out golden" (permanent adversarial anchors) |

Only the three non-empty cells are produced in V1. The fourth (`golden` × `holdout`) is reserved for future work without breaking compatibility.

Personas lose the `group` field completely. Config validation should emit a warning if a persona still has `group: 'eval'` and ignore it.

### Persistence boundary

`prompt-set.json` persists **only golden prompts**. Train and holdout are run-transient — they exist only in the current run's scored list and the log file, never in `prompt-set.json`.

This means `prompt-set.json` shrinks dramatically. The file keeps only:

```json
{
  "version": 2,
  "prompts": [
    {
      "prompt": "...",
      "persona": "...",
      "lifecycle": "golden",
      "evaluation": "fixer",
      "probe": "...",
      "invariant": "...",
      "promoterEvidence": {
        "nominatedInRun": "<run id>",
        "capabilityTag": "multi-occupancy",
        "confidence": "high",
        "reason": "<promoter rationale>"
      },
      "promotedAt": "<ISO timestamp>",
      "consecutivePasses": 3,
      "adversarial": false
    }
  ]
}
```

Fields `consecutivePasses` and `adversarial` survive from the existing schema. The `group` field is removed. `lifecycle` and `evaluation` are new. `promoterEvidence` and `promotedAt` are new.

### Generator: fresh train+holdout per run

The run flow gains a mandatory generation phase per run. Given `N = promptsPerPersona` (default 3) and `K = holdoutPerPersona` (default 1):

For each persona:
1. Call `generatePrompts(persona, N, currentDataContext)` — generates `N` prompts, all grounded in the current prefetched data state.
2. Deterministically sample `K` indices as holdout. Seed the random selection with `hash(runStartTime + persona.id)` so the same run+persona combination always splits the same way (reproducible on replay).
3. Mark the selected indices `evaluation: "holdout"`; the rest get `evaluation: "fixer"`.
4. All generated prompts get `lifecycle: "train"`.

Generator input already includes prefetched data (from the `prefetch` phase); this is preserved. New input: anti-examples from the failing-prompts store (Spec 1 dependency).

Generator prompt additions:
- Receive the current `N` and `K` per persona
- Receive the failing-prompts anti-examples for this persona
- No awareness of which prompts will become holdout — the split happens after generation so train and holdout come from the same distribution

### Run flow (changes in **bold**)

1. Seed, healthcheck, prefetch (unchanged)
2. **Load golden from `prompt-set.json`** (lifecycle=golden only)
3. **Generate N fresh prompts per persona** (all lifecycle=train)
4. **Sample K per persona as evaluation=holdout**, rest as evaluation=fixer
5. Build `promptsToRun = golden + fresh_train + fresh_holdout`
6. Run all through answerer (unchanged)
7. Grade + probe check (unchanged)
8. **Score pre-fix** per tier:
   - `train_pre` = aggregateScores(lifecycle=train, evaluation=fixer)
   - `holdout_pre` = aggregateScores(lifecycle=train, evaluation=holdout)
   - `golden_pre` = aggregateScores(lifecycle=golden)
9. **Build fixer input**: errors from prompts where `(lifecycle=golden OR lifecycle=train) AND evaluation=fixer AND NOT adversarial AND NOT invalid`. Holdout errors are excluded.
10. Fixer runs (unchanged) → Reviewer audits (per Spec 1) → merged diffs applied
11. **Replay phase** re-runs ALL prompts — including holdout — against the fixed MCP. This is the key addition: holdout prompts are re-evaluated post-fix so we can detect same-run overfitting.
12. **Score post-fix** per tier: `train_post`, `holdout_post`, `golden_post`
13. **Overfitting detection**: if `train_post.successRate - train_pre.successRate > overfittingThreshold` AND `holdout_post.successRate - holdout_pre.successRate < -overfittingThreshold`, emit `overfittingDetected: true` with the deltas and a breakdown of which prompts diverged
14. **Promoter-Agent** runs: nominates passing train prompts for graduation to golden (see below)
15. Apply promotions: add nominated prompts to `prompt-set.json` with `lifecycle: golden`, `promotedAt`, `promoterEvidence`, initial `consecutivePasses: 1`
16. Metrics update, log write
17. Cleanup (train+holdout prompts discarded — they never persisted anywhere except the run log)

### Promoter-Agent

New agent, new prompt file at `prompts/promoter.md`. Runs once per run, after replay and reviewer, before metrics/log.

Input:
- `candidates`: all train prompts where ALL of the following hold:
  - `lifecycle === 'train'`
  - `evaluation === 'fixer'`
  - scored passing in the post-fix replay (`scorePost` is a pass)
  - NOT dropped by the reviewer (`invalid !== true`)
  - NOT adversarial (`adversarial !== true`)
  - NOT marked obsolete by the grader (`obsolete !== true`)
- `currentGolden`: list of all existing golden prompts with their persona, intent summary, tool signatures
- `maxPromotions`: configurable cap (default 3)

Prompt structure (sketch — full prompt lives in `prompts/promoter.md`):

```
You are evaluating candidate prompts for graduation to the golden set.

Golden set currently contains {N} prompts that test the following capabilities:
{for each golden:}
- [{persona}] capability: {capabilityTag or intent summary}
  Tools used: {toolCallSignature}
  Prompt: "{prompt}"

Candidates (passing train prompts from this run):
{for each candidate:}
- [{persona}] "{prompt}"
  Tools used: {toolCallSignature}
  Probe invariant: {invariant or "none"}
  Reviewer status: {kept | not-reviewed}

For each candidate, decide if it should graduate. Criteria:
1. Does this prompt exercise a capability NOT already covered by an existing golden prompt? (semantic
   distinctness, not just different phrasing — same tool + same intent = duplicate)
2. Did it pass cleanly — no retries, no probe invariant violations, no harness warnings?
3. For prompts that call write tools: is the state change idempotent, or deterministically reproducible
   from the current prefetch context? (If the prompt would create garbage when replayed, it is NOT
   suitable for golden because golden replays every run.)
4. Does it test something valuable enough to anchor regression coverage — i.e., would losing this
   capability be a noticeable regression?

Nominate up to {maxPromotions} candidates. If fewer than {maxPromotions} meet all four criteria, nominate fewer.
Do NOT nominate duplicates or near-duplicates of existing golden.

Return structured JSON:
{
  "nominations": [
    {
      "promptId": "<id from candidates>",
      "capabilityTag": "<short tag like 'multi-occupancy' or 'payment-split'>",
      "confidence": "high" | "medium",
      "reason": "<one-sentence rationale>"
    }
  ],
  "skipped": [
    {
      "promptId": "<id>",
      "reason": "<why not nominated>"
    }
  ]
}
```

Model: `config.promoterModel` (default `sonnet`).

Output handling:
1. For each nomination, find the candidate in the current run's scored list
2. Add it to `prompt-set.json` with:
   - `lifecycle: "golden"`
   - `evaluation: "fixer"`
   - `promoterEvidence: { nominatedInRun, capabilityTag, confidence, reason }`
   - `promotedAt: currentRunTimestamp`
   - `consecutivePasses: 1`
   - `probe`, `invariant`, `probeType`, `expectedOutcome` copied from the candidate
3. Log each promotion to the run log's `promotions` array

### Overfitting detection details

After pre-fix and post-fix scoring, compute:

```js
const trainDelta = train_post.successRate - train_pre.successRate;
const holdoutDelta = holdout_post.successRate - holdout_pre.successRate;
const threshold = config.overfittingThreshold || 0.1;  // 10% by default

const trainImproved = trainDelta > threshold;
const holdoutDecayed = holdoutDelta < -threshold;
const overfittingDetected = trainImproved && holdoutDecayed;
```

Additionally, compute per-prompt-level divergence:
- For each holdout prompt, compare its pre-fix score to its post-fix score
- If any holdout prompt went from `pass` to `fail` while any train prompt by the same persona went from `fail` to `pass`, flag that persona as potentially overfit-target

Structured output in run log:

```json
{
  "overfitting": {
    "detected": true,
    "trainDelta": 0.15,
    "holdoutDelta": -0.12,
    "threshold": 0.1,
    "divergences": [
      {
        "persona": "waiter-orders",
        "holdoutRegressed": [
          {"prompt": "...", "pre": "pass", "post": "fail"}
        ],
        "trainImproved": [
          {"prompt": "...", "pre": "fail", "post": "pass"}
        ]
      }
    ]
  }
}
```

When `detected: true`:
- Emit a `warn` level log line with the deltas
- Update the progress bar with a visible banner
- Add to metrics `overfittingEvents` history

### Configuration additions

`evolve.config.mjs`:

```js
{
  // Existing fields preserved...

  // New for train/eval/golden redesign
  promptsPerPersona: 3,          // N — default 3
  holdoutPerPersona: 1,          // K — default 1
  overfittingThreshold: 0.1,     // 10% delta triggers alarm
  maxPromotionsPerRun: 3,        // Promoter cap
  promoterModel: 'sonnet',       // Promoter agent model
  promoterPromptFile: 'promoter.md',  // In prompts/ directory

  // Config sanity
  // (no direct field, but startup should emit a warning if any persona still has
  //  a `group` field — it is ignored in the new schema)
}
```

Sanity check: if `holdoutPerPersona >= promptsPerPersona`, config is invalid — emit error and refuse to start.

### Scoring aggregation

Replace the current `allScores/trainScores/goldenScores/evalScores` computation in `lib/run.mjs:1557-1560` with:

```js
const validScored = scoredPrompts.filter(q => !q.invalid && !q.adversarial);

const goldenQs = validScored.filter(q => q.lifecycle === 'golden');
const trainFixerQs = validScored.filter(q => q.lifecycle === 'train' && q.evaluation === 'fixer');
const holdoutQs = validScored.filter(q => q.lifecycle === 'train' && q.evaluation === 'holdout');

const allScores = aggregateScores(validScored);
const trainPre = aggregateScores(trainFixerQs, 'scorePre');
const trainPost = aggregateScores(trainFixerQs, 'scorePost');
const holdoutPre = aggregateScores(holdoutQs, 'scorePre');
const holdoutPost = aggregateScores(holdoutQs, 'scorePost');
const goldenPre = aggregateScores(goldenQs, 'scorePre');
const goldenPost = aggregateScores(goldenQs, 'scorePost');
```

`aggregateScores` gains an optional second parameter: which score field to use (defaults to `score` for backwards-compat with single-pass flows like dry-run).

Each prompt's scored entry gains `scorePre` and `scorePost` fields (populated by runAndGrade and replay respectively). `score` remains as the final post-fix score for backwards compatibility with existing consumers like escalation.

### Migration

One-time wipe of `prompt-set.json`:

```js
// lib/migrate-v2.mjs
import { loadPromptSet, savePromptSet } from './eval.mjs';
import { writeFileSync, copyFileSync } from 'node:fs';

export function migrateV2(config) {
  const ps = loadPromptSet(config);
  if (!ps) return;  // nothing to migrate

  // Backup
  const backupPath = `${config.promptSetPath}.backup.${new Date().toISOString().slice(0, 10)}.json`;
  copyFileSync(config.promptSetPath, backupPath);
  console.log(`Backup saved to ${backupPath}`);

  // Wipe
  const empty = {
    version: 2,
    prompts: [],
    migratedFrom: ps.version || 1,
    migratedAt: new Date().toISOString(),
  };
  writeFileSync(config.promptSetPath, JSON.stringify(empty, null, 2));
  console.log(`Prompt set wiped for v2 redesign. ${ps.prompts.length} prompts discarded (backup available).`);
}
```

Triggered by:
- `node bin/cli.mjs migrate` — explicit command
- Automatically on first run if `prompt-set.json` has `version: 1` or no version and the `--auto-migrate` flag is set (not default)

The auto-migrate path is off by default to avoid surprise wipes. User must run `migrate` explicitly, or pass `--auto-migrate` once.

### Interactions with existing features

- **Escalation.** Currently triggers when golden prompts hit a streak threshold and generates harder variants via `escalate()`. With train being ephemeral and golden earning via promoter, escalation still makes sense: it fires when `golden.successRate` hits the streak threshold and generates new harder train prompts that persist ONLY for one run (same ephemeral lifecycle as generated prompts). Those escalated prompts then compete for promoter nomination like any other train prompt.

  **Implementation:** `addTrainPrompts` currently persists escalation output into `prompt-set.json`. Change it to inject the escalation output into the current run's `promptsToRun` instead — no persistence.

- **Feature Competition.** Triggered by golden streaks at `competitionStreakMultiplier × streakThreshold`. Unchanged in principle — still golden-driven. Winners produce feature code (handled by `autodev`) which lands in the MCP; golden is unaffected directly, but future runs will score against the new feature.

- **Regression mode** (`--regression`). Reads baseline files to replay a fixed prompt set. Unchanged in principle — baselines now come from runs that include only golden (plus the ephemeral train/holdout of that specific run). Regression replays the exact prompts from the baseline, so it does not invoke fresh generation or the promoter.

- **Golden-only mode** (triggered when `globalGoldenHealthy` is false in legacy mode). Retained. If the latest run shows any golden failing, next run runs only golden prompts (no fresh generation, no promoter) until golden is healthy again.

- **KL-drift guards.** Currently run on escalated prompts against baseline/golden distribution. Now they should run on `goldenPre` distribution (the stable tier), not on ephemeral train. Update `driftAction` to only apply to new golden (promoted this run) — this catches "the promoter is promoting prompts that drift too far from existing golden".

- **Obsolete marking** (from `2026-04-08-obsolete-question-marking-design.md`). Still applies to golden: when the grader marks a golden prompt obsolete, it is removed from `prompt-set.json` at end of run. Train+holdout obsolete marks are moot because train+holdout is discarded anyway.

### Files changed

- `lib/run.mjs` — major changes to fixed-sets mode:
  - Remove the legacy/fixed-sets branching (legacy mode can stay but won't be exercised; fixed-sets is now the only path that matters)
  - Generation phase runs every run
  - In-batch split for holdout
  - Pre-fix scoring
  - Replay re-runs ALL including holdout
  - Post-fix scoring
  - Overfitting detection
  - Promoter-Agent invocation
  - Promotion application to prompt-set.json
- `lib/eval.mjs` — `aggregateScores` gains score-field parameter; new helper `splitForHoldout(prompts, holdoutK, seed)`; `addTrainPrompts` changes to inject-into-run rather than persist; new `addGoldenFromPromotion(ps, nomination, candidate)`
- `lib/promoter.mjs` — **new file**. Wraps the Claude CLI call with the promoter prompt; parses structured output; validates against schema
- `prompts/promoter.md` — **new file**. Full promoter prompt per the sketch above
- `lib/config.mjs` — new config fields with defaults; sanity check for `holdoutPerPersona < promptsPerPersona`; warning on leftover `persona.group`
- `lib/metrics.mjs` — new section `promotions` with counts + history; new section `overfittingEvents` with history
- `lib/migrate-v2.mjs` — **new file**. The migration helper
- `bin/cli.mjs` — new subcommand `migrate`; new flag `--auto-migrate`
- `lib/escalate.mjs` (or wherever escalation is defined) — `addTrainPrompts` no longer persists; instead returns prompts to be injected into current run's `promptsToRun`
- Schema bump: `prompt-set.json` version from 1 to 2; `version` field added if missing
- `prompts/grader.md` — no change required from this spec (adversarial handling comes from Spec 1)

### Run-log additions

```json
{
  "scores": {
    "all": {...},
    "train": { "pre": {...}, "post": {...} },
    "holdout": { "pre": {...}, "post": {...} },
    "golden": { "pre": {...}, "post": {...} }
  },
  "promotions": [
    {
      "promptId": "...",
      "prompt": "...",
      "persona": "...",
      "capabilityTag": "multi-occupancy",
      "confidence": "high",
      "reason": "Tests multi-guest seating at a single table, no existing golden covers this"
    }
  ],
  "overfitting": {
    "detected": false,
    "trainDelta": 0.05,
    "holdoutDelta": 0.02,
    "threshold": 0.1,
    "divergences": []
  }
}
```

### Metrics additions

`.mcp-evolve/metrics.json`:

```json
{
  "promotions": {
    "totalPromoted": 0,
    "lastPromotionRun": null,
    "history": []
  },
  "overfittingEvents": {
    "totalDetected": 0,
    "history": []
  }
}
```

## Verification

1. **Unit test — in-batch split.** Given N=3, K=1, seed="foo", split 3 prompts; verify the same seed always yields the same split; verify K=1 prompt is marked holdout.
2. **Unit test — scoring buckets.** Synthesize a scored list with mixed lifecycle/evaluation/invalid/adversarial flags; verify each bucket (all, train, holdout, golden) counts the correct prompts.
3. **Unit test — overfitting detection.** Synthesize pre/post scores where train improves by 15% and holdout decays by 12%; verify `overfittingDetected: true` with correct deltas.
4. **Integration test — fresh generation each run.** Run two runs back-to-back in the same process; verify the train prompts differ (they should be regenerated each time).
5. **Integration test — promoter graduation.** Run one run where a specific train prompt passes cleanly; invoke promoter; verify the prompt lands in prompt-set.json as golden with correct metadata; run again; verify the same prompt now appears as golden (from the persisted file).
6. **Integration test — golden persistence.** Promote 3 prompts across 2 runs; verify all 3 are in prompt-set.json; verify they run in subsequent runs as golden.
7. **Integration test — holdout excluded from fixer.** Craft a holdout prompt that would fail; verify its errors do NOT appear in the fixer's input; verify the fixer does not try to address them.
8. **Integration test — replay re-runs holdout.** Verify that the replay phase runs holdout prompts in addition to train/golden; verify `scorePre` and `scorePost` are both populated on holdout entries.
9. **Integration test — migrate command.** Start with a v1 prompt-set.json containing 30 prompts; run `node bin/cli.mjs migrate`; verify a backup file is created; verify the new prompt-set.json has `version: 2` and empty `prompts`; verify `migratedFrom: 1` and `migratedAt` are set.
10. **End-to-end test — full run after migration.** After migration, run one full iteration of pubman; verify no train prompts persist to prompt-set.json; verify golden (if promoter nominated any) does persist; verify scoring outputs all three buckets with sensible numbers.

## Open questions / future work

- **Hold-out golden** (the empty fourth cell in the matrix) — permanent adversarial anchors that the fixer never sees. Likely useful for probing the fixer's honesty at scale. Defer to V2.
- **Shape-based graduation** as an alternative or supplement to Promoter-Agent. Would let shapes graduate after N instances pass across runs. Requires classification infrastructure that V1 does not have.
- **Parametric prompt templates** — generator produces templates with parameter slots, instantiated fresh each run. Better state-pollution hygiene than free-form generation. V2.
- **Promoter-Agent self-critique** — run promoter twice, compare nominations, promote only the intersection. Reduces single-LLM-call variance. V2 if promoter output proves noisy in practice.
- **Cross-MCP golden portability** — if a golden prompt captures a general capability (e.g., "handle date-time across timezones"), can it migrate to another MCP server's golden? V2+.
- **Read/write split heuristic.** Could classify prompts at generation time by whether the answerer's first tool call is a read or write; use this to opt-in/out of promotion automatically for write-type prompts. V2.
