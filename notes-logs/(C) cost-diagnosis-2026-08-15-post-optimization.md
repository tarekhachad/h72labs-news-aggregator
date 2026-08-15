# (C) Cost — post-optimization measurement, 2026-08-15

Closes the Final Phase. Companion to `(C) cost-diagnosis-2026-08-13.md`, which measured the problem; this measures what's left. That file is a dated record of the *baseline* and has deliberately not been edited — its figures are still correct for what they describe.

Raw capture: `notes-logs/cost-test-log-f47-1f823c5-4015d9f6` (self-describing header: base commit, working-tree diff hash, flag state, acceptance band).

---

## The number

A full digest, real 9-topic profile, fresh account, 716 clusters → 62 cards:

| stage | calls | model | at list | billed |
|---|---|---|---|---|
| triage | 39 | Haiku 4.5 | $0.157 | $0.157 |
| writeCard | 29 | Sonnet 5 | $0.190 | $0.127 |
| writeCard | 38 | Haiku 4.5 | $0.047 | $0.047 |
| rank | 1 | Haiku 4.5 | $0.005 | $0.005 |
| **total** | **107** | | **$0.399** | **$0.335** |

**Expand, measured for the first time:** three runs at $0.0194 / $0.0138 / $0.0191 at list — **~$0.017 a card**, on demand, only for cards someone actually opens.

Against the baseline: **$1.944 → $0.399 at list, −79.5%.** Calls 930 → 107. Triage calls 794 → 39.

Zero `WARNING` lines, so these are real totals rather than a floor. Passes + rejects = 716 = clusters triaged, so no verdict was lost to a fail-closed path.

**Use the at-list column for anything forward-looking.** Sonnet introductory pricing ends 2026-08-31; from 1 September, at-list is the bill. Sizing off billed under-provisions by ~19%.

---

## Acceptance: the primary metric passed, the secondary one failed, and that was the designed outcome

| metric | F.3 baseline | F.4.6 | **F.4.7** | band | |
|---|---|---|---|---|---|
| **severity ≥ 3 count** | **101** | 144 | **99** | 85–135 | **pass** |
| pass rate | 16.4% | 35.7% | 29.3% | 12–21% | fail |
| mean severity | 2.854 | 2.605 | 2.514 | ±0.5 | pass |
| cost at list | $1.944 | $0.404 | $0.399 | ≤~$0.35 | miss |

F.4.6 batched triage and doubled the pass rate — with 20 clusters in one call the model graded them against each other instead of against the topic's typical day. F.4.7 added a base-rate anchor, moved the "when genuinely torn, reject" tiebreaker into the batch-contract paragraph, and extended the same rule to severity grading.

**Severity ≥ 3 came back to 99 against a baseline of 101** — 13.8% of clusters vs 12.7%, down from F.4.6's 18.3%.

**Why the pass-rate "failure" is a labelling difference, not a regression.** Of 110 severity-2 passes, **105 were discarded by the per-topic cap of 8**. They never became cards. The model is finding the same real stories and attaching a "notable, barely" label to more marginal ones — which costs nothing (a reject bills the same as a pass) and reaches no one.

This was decided *before* the run, precisely so it couldn't be rationalized after: *if sev ≥ 3 is in band while overall pass rate is not, the criterion was wrong.* The 12–21% band was one measurement, of one prompt, on one day, never validated as a target. Iteration stopped here rather than spending a second ~$0.40.

**Confound, stated rather than buried:** F.4.6 ran with per-verdict reasons on, F.4.7 with them off *and* a changed prompt. Two variables moved. The sev≥3 improvement cannot be cleanly attributed to the prompt alone.

---

## Why the cost didn't land where it was modelled

The estimate was ~$0.315 — F.4.6's $0.404 minus the ~$0.089 of diagnostic reason tokens that production never pays.

Triage delivered: **$0.231 → $0.157**, −$0.074, close to the prediction. But **writeCard Sonnet rose $0.110 → $0.190**, because Sonnet calls went 18 → 29. Hybrid routing sends multi-source clusters to Sonnet; this run produced fewer, denser clusters (716 vs 787), so a larger share had multiple articles — 47% vs 29%.

Per cluster the run is 8.5% *more* expensive than F.4.6. That is cluster-composition variance, not a regression, and it varies on exactly the axis the product's "synthesized from multiple sources" claim lives on.

Worth keeping: **a single-variable cost model of this pipeline is unreliable.** Removing a known cost and predicting the total assumes everything else holds; the composition of what gets clustered moved more than the thing being removed.

---

## What this number is not

Every measurement taken — F.3, F.4.6, F.4.7 — is **the first run of a brand-new account**: null cursor, full 48-hour lookback, cross-run dedup skipped for want of existing cards to compare against.

A returning daily user starts from a ~24-hour cursor, ingests roughly half as much, and pays dedup costs the cold-start path never incurs. **That recurring figure has never been measured**, and it — not $0.399 — is what a per-user cap actually consumes. Sizing V2.0 off the cold-start number overestimates, probably close to 2×.

That is the safe direction, and it is still the wrong number. It is the same *class* of error as the original 10×: a figure measured under conditions that don't match how the thing is used. Measuring one returning-account run is cheap (~$0.15–0.20) and should happen before any cap is set tight enough to bite.

---

## Reconciliation

The 2026-08-13 console reconciliation passed, which is what makes every figure here trustworthy: it validates the pricing table in `src/lib/usage.ts`, and if that table were wrong, so would be every number in both notes.

**Still outstanding: reconcile UTC 2026-08-15 against the console** for this run — expected ~$0.335 billed for the digest plus ~$0.035 for the three expands, ~$0.37 total. The run started at 00:40 UTC, so it bills on the 15th, not the 14th.

`PRICING_VERIFIED_ON` in `usage.ts` still reads `2026-08-13`. It should be bumped only once someone has genuinely re-checked Anthropic's *published rates* — as opposed to reconciling usage, which is a different check. Left alone rather than advanced on an assumption.
