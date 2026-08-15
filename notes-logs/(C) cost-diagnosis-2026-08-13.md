# (C) Cost Diagnosis — 2026-08-13

> **Superseded for post-optimization figures — see `(C) cost-diagnosis-2026-08-15-post-optimization.md`.** This note remains accurate for what it measures: the **baseline**, before any optimization. Its $1.944/digest and the per-stage split behind it are the record of the problem, and are deliberately left unedited rather than quietly updated into staleness. The current cost is **$0.399/digest at list**.

The Final Phase's F.3 measurement. First time this app's real per-digest cost has been measured with per-stage attribution rather than read off the Anthropic Console as a single total.

**Headline: a real digest costs $1.66 billed / $1.94 at list — roughly 10× the $0.17 figure recorded in `(C) TECH_STACK.md`, and ~7× the $0.20–0.30 estimate above it.**

---

## Method

One real digest generation, 2026-08-13, against Tarek's **real full profile** (9 topics) rather than the 2-topic/3-source dev profile that produced the superseded $0.17 figure. First run of the day, so cross-run dedup was skipped entirely (`sinceIso === null`).

Instrumented by `src/lib/usage.ts` + `src/lib/usageCollector.ts` (Final Phase F.1/F.2). Raw terminal output preserved at `notes-logs/cost-test-log`.

**Pricing basis, verified 2026-08-13:** `claude-haiku-4-5` $1.00/$5.00 per MTok; `claude-sonnet-5` $3.00/$15.00 list, with **introductory $2.00/$10.00 running through 2026-08-31**. Every figure below is given both ways. **Use the at-list column for any forward-looking decision** — the intro rate expires in ~2 weeks and V2.0's spend caps must be sized off what this costs afterwards.

---

## Measured totals

| | value |
|---|---|
| Billed (intro pricing) | **$1.660281** |
| At list price | **$1.944484** |
| Claude API calls | 930 |
| Clusters triaged | 794 |
| Clusters passing triage | 130 (16.4%) |
| Clusters rejected | 665 (83.6%) |
| Cards written | 130 |
| Total input tokens | 824,683 |
| Total output tokens | 110,279 |
| Wall clock | 62s |

### Per stage

| stage | calls | input tok | output tok | billed | at list | % of billed |
|---|---|---|---|---|---|---|
| **triage** | 794 | 674,580 | 81,369 | **$1.081425** | $1.081425 | **65%** |
| **writeCard** | 135 | 140,053 | 28,830 | **$0.568406** | $0.852609 | **34%** |
| **rank** | 1 | 10,050 | 80 | $0.010450 | $0.010450 | <1% |
| dedup | 0 | — | — | — | — | skipped (first run of day) |
| expand | 0 | — | — | — | — | **not measured** |

### Per-topic triage volume

| topic | clusters |
|---|---|
| European Football | 173 |
| Tech/AI | 133 |
| US Politics | 125 |
| Morocco | 117 |
| Geopolitics | 113 |
| US Finance | 73 |
| French Politics | 44 |
| World Finance | 15 |
| Morocco Politics | 1 |

---

## Finding 1 — `(C) ARCHITECTURE.md` has the cost model backwards

`(C) ARCHITECTURE.md` line 45 states: *"Steps 1–3 cost nothing or close to it. Step 4 (and occasionally step 6) is the only real per-use cost."*

**Triage is 65% of billed spend.** Sonnet card writing is 34%. The claim is inverted, and it has been inverted since it was written — the 2026-07-28 console reading (14¢ Haiku triage vs 3¢ Sonnet writing) already contradicted it and was never reconciled. This measurement settles it.

The cause is structural, not incidental: triage fires **one call per cluster**, unbounded, while writeCard fires only for the ~16% that pass. Haiku being ~10× cheaper per token than Sonnet is comfortably outweighed by firing ~6× as often on a fixed-cost-dominated payload.

## Finding 2 — 91% of triage input is the same bytes, re-sent 794 times

Triage input token distribution across 794 calls:

```
min=794   p25=824   median=839   p75=856   p90=896   max=1271   mean=850
```

Nearly flat. That shape is the diagnosis: cost is dominated by a **fixed** per-call payload, not by the content being judged.

Fixed overhead is ~770 tokens per call — a 2,389-character system prompt (~600 tok), the user-message scaffold (~42 tok), plus the `zodOutputFormat` JSON schema, which is sent as part of the request and billed as input. Actual per-cluster content averages only **~80 tokens** (a title plus a 200-char snippet, so most clusters are 1–2 articles).

**~611,000 of 674,580 triage input tokens are pure repetition.** The app is paying to re-send the same instructions 794 times in order to ask 794 one-line questions.

**Prompt caching cannot fix this.** Haiku 4.5's minimum cacheable prefix is 4,096 tokens; this prompt is ~600. It is structurally ineligible. The lever is **call count**, not caching. (Recorded here because "cache the repeated system prompt" is the obvious first instinct and it is a dead end.)

## Finding 3 — 83.6% of triage spend buys a rejection

665 of 794 clusters were rejected. At ~$0.00136/cluster that is **~$0.90 spent to say "no"** — 54% of the entire digest's billed cost.

This is not necessarily waste (filtering is triage's job, and it is doing it), but it means any reduction in *cluster count reaching triage* is worth more than any per-call optimization downstream.

## Finding 4 — triage output is mostly a string used only for a `console.log`

Triage output: `min=48 median=102 max=180 mean=102`, totalling 81,369 tokens = **$0.407** — 38% of triage cost and 24% of the whole digest.

The response schema is `{notable, severity, reason}`. `notable` + `severity` need ~10 tokens. **The rest is `reason`**, which `src/lib/triage.ts` discards apart from one `console.log`. The comment there justifies it as calibration visibility — reasonable when it was written, but at 794 calls per digest it is a recurring line item, and nobody reads 794 rationales.

## Finding 5 — 130 cards is a firehose, and there is no cap in the code

The digest produced **130 cards across 9 topics** (~14/topic). The triage system prompt's own stated intent is *"a handful of genuinely worthwhile items per topic … not a comprehensive scan of everything published that day."* The output does not match the design intent.

`(C) ARCHITECTURE.md` line 61 says topics are *"curated multi-select, **up to 5**"* — but **no such cap exists in code**. `src/lib/profile.ts` enforces only `.min(1, "Pick at least one topic")`. The doc describes a constraint that was never implemented.

This is the single largest remaining cost lever *and* a product-quality issue, and the two point the same way.

## Finding 6 — incidental observations

- **One feed is broken:** `[ingest] failed Medias24/Morocco: Status code 403`. Silently skipped, as designed.
- **4 cards lost to failed truncation retries.** `writeCard made 135 calls for 130 — 5 extra billed attempt(s)`. The instrumentation surfaced this exactly as intended; without it, the double-billing would be invisible.
- **writeCard input has a long tail:** `median=871, p90=1274, max=5142`. The max is ~6× the median — that is the untruncated-RSS-snippet path (`writeCard.ts`'s `sourceTextFor` is the only prompt that does not cap per-article text). Mean is only 1,037 though, so trimming is a tail fix worth ~$0.02, not a headline lever.
- **Rank is negligible today** ($0.0105 for a 130-candidate pool) but confirms the uncapped-pool concern in `ROADMAP.md`'s deferred list is real: the pool grows monotonically across same-day runs.

---

## Modelled savings (not yet measured)

Baseline at list: **$1.944**. Figures below are modelled from the measured token distributions above; they are estimates, and F.4 must re-measure to confirm.

| change | at-list cost | saving | notes |
|---|---|---|---|
| baseline | $1.944 | — | |
| batch triage (~25 clusters/call) | ~$1.25 | −36% | eliminates ~87% of triage input tokens |
| + drop/shorten `reason` | ~$1.01 | −48% | cuts triage output ~85% |
| + cap cards written | see below | | the dominant remaining lever |

**Triage floor.** Even batched and lean, 794 clusters need ~80 content tokens each (63,520 tok ≈ $0.064 input) plus a minimal verdict each (~10 tok ≈ $0.040 output). **Triage cannot go below ~$0.10–0.15 at 794 clusters** without reducing cluster count itself.

**Card cost is linear:** ~$0.0066/card at list. So writeCard alone at 130 cards is $0.853 — over 4× the $0.20 target regardless of what triage does.

**Reaching a $0.20 digest therefore requires capping cards.** Rough arithmetic at list: batched lean triage ($0.15) + rank ($0.01) leaves ~$0.04 for writing, i.e. **~6 Sonnet cards** — likely too few for 9 topics. Realistic landing zones:

| shape | at list |
|---|---|
| batched lean triage + 30 cards | ~$0.35 |
| batched lean triage + 20 cards | ~$0.29 |
| batched lean triage + 15 cards | ~$0.26 |
| batched lean triage + 15 cards, **Haiku writing** | ~$0.18 |

The last row is the only modelled path that clears $0.20, and it trades the one step `(C) ARCHITECTURE.md` calls *"the one step that truly needs a capable LLM."* That is a quality decision, not an engineering one.

---

## Consequence for V2.0 — the gate's arithmetic is off by ~10×

`(C) ROADMAP.md`'s V2.0 worked example reads: *"Ten friends at a $0.20 digest is $60/month at full daily usage."*

At the measured at-list figure: **10 × $1.94 × 30 = $583/month.**

V2.0 cannot be sized off the old assumption. This is precisely why the Final Phase was sequenced before that gate.

---

## Still unmeasured

1. **Expanded reports.** Zero `expand` calls in this run. Sonnet at `max_tokens` 4096 on untruncated persisted sources — plausibly the most expensive *single* call in the app, and the one V2.0's per-user caps must bound. Needs 2–3 real expands across cards with differing source counts.
2. **Second/third same-day runs**, which activate the `dedup` stage (one Haiku call per borderline candidate) and grow the rank pool. Only the first-run shape is measured.
3. **Console reconciliation.** The instrumentation's arithmetic has not yet been checked against the Anthropic Console's own usage figure for 2026-08-13. Until it is, every number here rests on the pricing table in `usage.ts` being correct.

---

## Raw data

`notes-logs/cost-test-log` — full terminal capture, 1,805 lines, including all 930 per-call `[usage]` lines and the per-stage summary at line 1795.
