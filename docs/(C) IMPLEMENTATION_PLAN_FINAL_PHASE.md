# (C) Implementation Plan — Final Phase (Cost diagnosis + cost optimization)

> Copied from the ephemeral Claude Code plan-mode artifact (`.claude/plans/`, not part of this repo and not durable across sessions) so it survives session restarts.

# Final Phase — Cost diagnosis + cost optimization

## Context

Phases 0–8 are built, reviewed, and pushed. This is the last phase of v1, scoped per [`(C) ROADMAP.md`](<(C) ROADMAP.md>) to **cost diagnosis and cost optimization only** — no deployment, no external users.

The app has **zero cost instrumentation**. `response.usage` is never read anywhere in `src/`; there are no token counters, no cost arithmetic, no timing. The only cost figures that exist are two manual Anthropic Console readings recorded in docs, and they contradict each other:

- [`(C) TECH_STACK.md`](<(C) TECH_STACK.md>) line 48 estimates **$0.20–0.30 per digest**.
- Line 50 records a real measurement: **$0.17 — 14¢ Haiku triage + 3¢ Sonnet writing** (2026-07-28, 2-topic/3-source dev profile).
- [`(C) ARCHITECTURE.md`](<(C) ARCHITECTURE.md>) line 45 says the opposite: *"Steps 1–3 cost nothing or close to it. Step 4 [Sonnet writing] is the only real per-use cost."*

The measurement is likely the correct one and the architecture note wrong: triage fires **one Haiku call per cluster**, unbounded, each re-sending a ~1.6 KB system prompt, while Sonnet writing fires only for the handful that pass. Confirming that with real per-stage numbers — rather than one console total — is this phase's job.

It matters beyond the doc correction: **V2.0** is a hard blocking gate, and its recommended option (Tarek's key, server-side, hard caps) is sized by arithmetic that takes the per-digest cost as input. A wrong number here produces a wrong cap there.

**Two pricing facts, verified 2026-08-13:**

1. **`claude-sonnet-5` is on introductory pricing — $2.00/$10.00 per MTok — through 2026-08-31.** List is $3.00/$15.00. Any figure measured now understates steady-state Sonnet cost by ~50%. Every cost this phase reports carries **both** the billed figure and the at-list figure.
2. **`claude-haiku-4-5`'s prompt-cache minimum is 4096 tokens**; the triage system prompt is ~350 tokens. Prompt caching — the obvious-looking fix for "same system prompt sent N times" — **is not available for triage**. The lever is call count, not prefix caching.

**Decisions taken up front (Tarek, 2026-08-13):** instrumentation is console-only and ships permanently (V2.0's caps will need it); the measurement runs against his **real full profile**, not the dev profile; the optimize step is scoped with him **after** he sees the numbers, not pre-authorized.

Sub-phases are ordered **risk-ascending**, matching the Phase 6/7/8 precedent. Each code-changing sub-phase goes through the standard `qa` + `code-reviewer` convergence loop — **both agents, every round, until a round comes back genuinely clean.**

---

## Design decision: ambient collector, not threaded return values

This repo's convention is explicit injection (`supabase: SupabaseClient` as the first param), so threading usage back through return values was the obvious first choice. **It does not work here.** Every billed call site has a path that never reaches its `return`:

- [rank.ts:102-105](../src/lib/rank.ts#L102-L105) catches and returns `null` — a load-bearing sentinel meaning "ranking didn't happen this run".
- [dedup.ts:67-70](../src/lib/dedup.ts#L67-L70) catches and returns a bare `false`.
- `triageCluster` throwing is swallowed by the route's per-cluster catch, [route.ts:128-131](../src/app/api/digest/route.ts#L128-L131).
- `writeCard` rejecting is absorbed by `Promise.allSettled`, [route.ts:154-156](../src/app/api/digest/route.ts#L154-L156).
- [claudeText.ts:44-76](../src/lib/claudeText.ts#L44-L76) has **three throw paths**, and the worst fires *after two billed Sonnet calls* at max_tokens 2048/4096.

Under threaded returns, the single most expensive event in the pipeline reports **$0.00** — and cost diagnosis of a partially-failing pipeline is exactly when the number matters. Attaching usage to thrown `Error` objects to work around that is the design telling you it is fighting the codebase.

**Decision:** an `AsyncLocalStorage` collector. Five one-line wraps around the existing `client.messages.parse(...)` calls, **zero signature changes**, `claudeText.ts` untouched — and because `recordCall` sits *inside* `generateSummary`/`generateReport`, both retry attempts are counted for free, on both the retry-succeeds and retry-fails paths.

---

## F.1 — The pure module and the collector

Two new files; no existing call site touched.

**Changes**

- [src/lib/usage.ts](../src/lib/usage.ts) *(new — pure, no I/O, house style of `entranceTiming.ts`/`rankUpdates.ts`)*. `TRACKED_MODELS`/`TrackedModel`, `PRICING: Record<TrackedModel, ModelPricing>` (so adding a model without a price fails `tsc`), `PRICING_VERIFIED_ON`, plus:
  - `normalizeUsage(usage: unknown): CallTokens | null` — returns **`null`, never zero-filled tokens**, when usage is absent or unrecognizable. Zeros would silently under-report; null routes the call into a loud warning. This is also what keeps the ~30 existing `mockParse` mocks (no `usage` field) passing untouched.
  - `costFor(model, tokens, at: Date): CostBreakdown` → `{billedUsd, listUsd, promoApplied, promoEndsOn}`. The Sonnet intro rate is `promo: {rate, throughUtcDate}` **alongside** a permanent `list` rate — a date gate, not a swapped table. Nothing is hardcoded to "now", so after 2026-08-31 it self-expires with no code change.
  - `summarizeUsage(calls, at)` grouping by the **`(stage, model)` pair** — never stage alone, since pricing a mixed-model stage once would be wrong by up to 3×.
  - `formatUsageSummary` / `formatCallLine` / `formatUsd`.
- [src/lib/usageCollector.ts](../src/lib/usageCollector.ts) *(new — thin, impure, imports only `usage.ts`)*. `createUsageCollector()`, `withUsageCollector(collector, fn)`, `recordCall(stage, model, call)` — records usage on success, records a usage-less entry on throw (`messages.parse` can throw on schema validation *after* a billed 200) and **rethrows unchanged**; a no-op when no collector is in scope.

**Tests.** `usage.test.ts` — exact cost math; the promo boundary at `2026-08-31T23:59:59Z` (still promo, inclusive) vs `2026-09-01T00:00:00Z` (billed === list); cache multipliers; `normalizeUsage` on `undefined`/`{}`/null cache fields; `(stage, model)` grouping; footer wording flipping across the date. `usageCollector.test.ts` — no-scope no-op (the ~30-mocks guarantee, tested directly); missing usage → `callsWithoutUsage`; throwing call propagates *and* counts; **two concurrent scopes stay isolated** (a module-level singleton fails this); a 20-way `Promise.all` fan-out records 20 entries.

---

## F.2 — Wire the call sites and routes

**The one real hazard.** Do **not** wrap `runDigestPipeline` in a single scope — it is an async generator, and ALS propagation across `yield`/`next()` suspension is not something to bet the instrumentation on; the failure mode is a silent $0.00. Enter the scope around each awaited stage expression the route already has; each is a plain async call whose whole subtree inherits correctly.

**Changes**

- [triage.ts:48](../src/lib/triage.ts#L48), [dedup.ts:53](../src/lib/dedup.ts#L53), [rank.ts:62](../src/lib/rank.ts#L62), [writeCard.ts:37](../src/lib/writeCard.ts#L37), [cards.ts:22](../src/lib/cards.ts#L22) — each `await client.messages.parse({...})` becomes `await recordCall("<stage>", "<model>", () => client.messages.parse({...}))`. Stage is an explicit literal — self-documenting, matches the adjacent `[triage]`/`[dedup]` console tags, no action-at-a-distance.
- [src/app/api/digest/route.ts](../src/app/api/digest/route.ts) — one collector per run; four `withUsageCollector` wraps around the existing `filterAlreadyCovered`, triage `Promise.all`, writeCard `Promise.allSettled`, and `rankFrontPage` awaits. Summary emitted in the generator's existing `finally` beside `releaseDigestGeneration`: that block already runs on completion, throw, and client cancellation, and a generator's `finally` runs at most once — exactly one summary per run. **A run cancelled halfway still paid for triage**, and that is the case most likely to surprise.
- [src/app/api/cards/[id]/expand/route.ts](../src/app/api/cards/%5Bid%5D/expand/route.ts) — one wrap plus a `finally` emission, so the 502 path still reports its spend.

**Output.** One `console.log` per call — same precedent as [triage.ts:69](../src/lib/triage.ts#L69), which already logs per-cluster for observability alone — then a per-stage table with `billed` and `at list` columns, an intro-pricing footer, and a `writeCard made N calls for M cards` line that surfaces retry double-billing without reading code. Three conditional warnings: unrecorded calls (*"every total above is a FLOOR"*), cards produced with zero recorded calls (*"instrumentation is not wired up"*), and a zero-call run.

**Tests.** Do not touch any existing mock — they become the regression suite proving safe degradation. Add `claudeText.usage.test.ts` (truncated-then-complete → **2** recorded calls; truncated-then-truncated throw → **2**; empty-first throw → **1**); one `it` appended to each of the `triage`/`dedup`/`rank`/`writeCard` tests plus a new `cards.test.ts`, pinning the stage/model literals so a copy-paste error is caught; and `src/app/api/digest/__tests__/usage-wiring.test.ts` on the `rank-wiring.test.ts` template, driving the real `POST` through the NDJSON stream — the ALS-across-generator hazard **only** manifests there. It asserts exactly one summary on the success, error, and cancellation paths.

---

## F.3 — Measure (the only paid step)

One real digest generation against Tarek's **real full profile**, plus 2–3 card expands. Full console output captured verbatim into `notes-logs/`.

Two reconciliations no test can do:
- **Cross-check the run's total against the Anthropic Console usage page for that day.** If the table's arithmetic disagrees with the real bill, the pricing table is wrong and every downstream number is too.
- **Compare against the old $0.17 dev-profile figure** and state the scaling relationship, so `TECH_STACK.md`'s line 50 is superseded honestly rather than contradicted.

Standing cost discipline applies: reuse the existing account, no exploratory re-runs.

---

## F.4 — Optimize (scoped with Tarek after F.3)

Nothing is built until Tarek sees the numbers. He gets a ranked menu with measured savings and quality risk per item. Candidates identified in advance, to be confirmed or discarded by the data:

- **Batch triage** — one Haiku call per topic instead of one per cluster. Likely the largest single win if triage dominates, but it changes model behavior: the prompt explicitly states clusters are judged independently against a typical-day baseline. A quality risk, not a free win.
- **Cap the rank candidate pool** — grows monotonically across same-day runs; item count is uncapped (already flagged as deferred in `ROADMAP.md`).
- **Trim `writeCard` input** — the only prompt sending **untruncated** RSS snippets; every other site caps at 200–300 chars.
- **Prompt caching** — Sonnet's 1024-token minimum may be reachable for `writeCard`; Haiku's 4096-token minimum rules out triage. Decide from measured `input` counts, not by guessing.

Whatever ships goes through the full review loop, then **one re-measurement run** to prove the saving is real.

---

---

# F.4 — Cost optimization (added 2026-08-13, after F.3 measured)

**F.3's result: $1.66 billed / $1.94 at list per digest — ~10× the docs' figure.** Full analysis in `notes-logs/(C) cost-diagnosis-2026-08-13.md`; raw capture in `notes-logs/cost-test-log`. Four findings drive this sub-phase:

1. **Triage is 65% of spend** ($1.081 of $1.66), not writeCard. `(C) ARCHITECTURE.md:45` claims the opposite.
2. **91% of triage input is the same bytes re-sent 794 times.** Input is near-flat (`min=794 median=839 max=1271`) because ~770 tok/call is fixed prompt + `zodOutputFormat` schema against ~80 tok of content. **Prompt caching cannot fix this** — Haiku 4.5's minimum cacheable prefix is 4,096 tokens and this prompt is ~600. The lever is call count.
3. **Every day's first run re-ingests 48h.** `upsertDigestForToday` scopes the cursor to *today's* row, so each new day starts with `last_generated_at = null` and hits `FIRST_RUN_LOOKBACK_MS`. Dedup doesn't catch it (skipped on first runs, and only compares against today's cards). A duplicate-stories bug, not just cost.
4. **130 cards from 9 topics, no cap anywhere.** ~89% of clusters are single-article. `profile.ts` enforces only `.min(1)` on topics despite `(C) ARCHITECTURE.md:61` documenting "up to 5".

**Goal:** as close to **$0.20/digest** as possible (Tarek's target, not a hard constraint). Modelled landing: **~$0.25 at list, an 87% cut.**

**Tarek's decisions (2026-08-13):** 4–8 cards per topic, floor being a design target and **not** a backfill quota — a thin topic yields only what passed triage, per the triage prompt's own "don't stretch to fill a quota". Carry the since-cursor across days, 48h ceiling. Capped-out stories accepted as permanently lost. Card writing goes **hybrid** — Haiku for single-source clusters, Sonnet retained for multi-source, where the "synthesized from multiple sources" product claim lives.

## F.4.1–F.4.3 — DONE (2026-08-13, reviewed clean)

- **`writeCard` input cap** — `SOURCE_CHARS_PER_ARTICLE = 1200` in `sourceTextFor`; it was the only prompt builder without a per-article cap.
- **Per-topic card cap** — new `src/lib/cardCap.ts`: `applyCardCap` returns `{ kept, cuts }`, keeping ≤ `MAX_CARDS_PER_TOPIC = 8` highest-severity per topic. Applied in `route.ts` **before** the `writing` stage event and **before** `expectedCalls.writeCard` — capping after either makes the client's "Writing N cards…" text or the cost summary lie.
- **Hybrid model** — `modelForCluster` routes on `cluster.articles.length === 1`. `thinking` is sent **only** on the Sonnet path (Haiku 4.5 has no adaptive thinking; no other Haiku call site sends it).

Review found one real bug: selection tracked by object identity let a duplicated reference exceed the cap. Now index-based, and the drop-reporting was merged into the same function so the two can't disagree. Note the two agents disagreed here — `code-reviewer` reasoned "can't happen in today's pipeline" (true) while `qa` reproduced it; the docstring's absolute claim was taken as the standard.

## F.4.4 — DONE (2026-08-13, converged clean at round 8)

Shipped as designed, plus three things the review loop forced:

- **`getLatestGeneratedAtForUser`** (`src/lib/digests.ts`) — newest `last_generated_at` across all of the user's rows. `upsertDigestForToday` now returns `{ digestId }` only; the cursor is a property of the user, not of today's row. Two filters, both load-bearing: `.not(... is null)` because Postgres sorts NULLs first under DESC (today's fresh row would win and hand back null), and `.lte(plausibleCursorLimitIso())` because this is a MAX query — one corrupt far-future row would win the ordering *forever* and the legitimate cursor is unrecoverable downstream.
- **`LOOKBACK_CEILING_MS`** (`src/lib/ingest.ts`) — was `FIRST_RUN_LOOKBACK_MS`; `cutoff = max(cursor, now − 48h)`. A cursor >5 min ahead of the clock is corrupt: discarded for the ceiling, with a **guarded** `console.warn`. The tolerance is not fussiness — always falling back would mean a writer running seconds fast makes every run re-ingest 48h, a permanent duplicate storm at ~10× cost.
- **`src/lib/cursor.ts`** — the tolerance constant + helpers, shared so the query and the consumer can't drift (the `entranceTiming.ts` precedent). Drift here is silent: the query accepts a value the consumer then discards.
- **`route.ts`** — dedup gate moved from `sinceIso !== null` to `existingCards.length > 0` (the old proxy only coincided with the real precondition while the cursor reset at midnight); the upsert and cursor query issue concurrently under `Promise.all`.

**Eight rounds; six found something real, and four of those were comments asserting a property the code did not have** — a false "self-healing" claim, a false "one re-ingested window" claim, a tick-margin that didn't exist, and a concurrency test that couldn't detect a reversed serial ordering. The logic stabilised at round 3; everything after was the description of it failing review. Round 7 was **void, not clean** — `code-reviewer` read `route.ts` while `qa` had it mutated for a load-bearing check and reported the change as missing. Fixed by giving `code-reviewer` an immutable snapshot while `qa` keeps the live tree; that separation is worth keeping for any future round that runs both concurrently.

Tests 277 → 332. Two deferred items raised to `ROADMAP.md`: the per-row generation mutex (a midnight rollover can let one user run two pipelines) and the missing `digests(user_id, last_generated_at)` index. Neither introduced here.

## F.4.5 — Batch triage (highest risk in the phase)

One Haiku call per **~20 clusters of the same topic**. `src/lib/rank.ts` already solves the same index-mapping problem and is the precedent to follow throughout.

- **Unit: per-topic, then size-evened chunks** — `perBatch = ceil(n / ceil(n / 20))`, so 62 clusters become 16/16/15/15, not 20/20/20/2. A 2-cluster batch is judged at a different context density than a 20-cluster one. Mixing topics would break the prompt's topic-relative calibration; the ~8 extra partial calls cost $0.006.
- **N = 20, `max_tokens: 1024`.** Cost curve is flat past ~20 (N=20→40 saves a further $0.013 while doubling a failed batch's blast radius). Output binds: 20 verdicts × ~24 tok + wrapper ≈ 490, giving 2× headroom.
- **Schema** `{ verdicts: [{ index, notable, severity }] }`, index **batch-local**. Map back via `rank.ts`'s `seenIndices` precedent: out-of-range dropped, duplicate index first-wins, missing verdicts leave a typed `null` hole. **Throw** (with `stop_reason`) only on a missing/unparseable whole response — a truncated response is not "the model judged nothing."
- **Failure: split-retry ladder.** On throw or unfilled slots, split the unjudged set in half and retry, depth 2 (20 → 2×10 → 4×5), then fail closed on the residual. Today one failure loses one cluster; unmitigated batching loses 20 (~3 real stories, permanently, since the cursor advances regardless). Bounded worst case 7 calls per failing batch, only on failure.
- **`triageClusters` must never reject** — the route's per-cluster `try/catch` disappears with this change, so "one failure doesn't take down the digest" has to move inside.
- **Prompt: minimal change.** The system prompt already says *"Each cluster is judged independently … rather than against other clusters you happen to see in the same batch"* — written for exactly this. Keep every calibration paragraph verbatim; append one paragraph on the response contract (one verdict per index, never merge, never skip, never invent).
- **`reason`: env-gated (`TRIAGE_REASONS=1`), default off**, capped at 12 words *in the prompt* — not via `z.string().max()`, which would throw and kill the batch. Saves ~$0.06/digest and stays available for F.4.6's calibration check.
- **`expectedCalls.triage` becomes `triageBatchCount(clusters)`**, a one-liner over the *same* `planTriageBatches` the implementation uses. Divergence makes the module whose premise is "a confidently-wrong number is worse than a crash" emit a false warning every run.
- **Guard the per-cluster `console.log`.** `ROADMAP.md` defers this hazard; batching turns it from "loses 1 cluster" into "loses 20 already-paid-for clusters."

**Tests that matter most:** misalignment canaries — verdicts returned shuffled *and* reverse-ordered with **distinct** severities, asserted per index. A count- or set-based assertion passes under a rotation. Plus `triageBatchCount === planTriageBatches().length`; a route-level `triage-wiring` test through the real NDJSON stream proving the route's zip preserves alignment; and batch-failure isolation (one batch fails every attempt → those fail closed, others unaffected, stream still reaches `done`).

**Migration hazards:** `dedup-wiring.test.ts` has three `toHaveBeenCalledTimes(FAKE_CLUSTERS.length)` assertions → become `toHaveBeenCalledWith(FAKE_CLUSTERS)` (the real intent, not a proxy). Any wiring test that mocks `triageBatchCount` away gets `undefined`, which `formatUsageSummary` skips silently — pull it through `vi.importActual`.

## F.4.6 — Re-measure (paid)

One real digest, same 9-topic profile, `TRIAGE_REASONS=1`, plus 2–3 expands (still unmeasured). **Acceptance band set before running**, since batching's worst failure is silent drift:

| metric | baseline | accept if |
|---|---|---|
| triage pass rate | 16.4% (130/794) | 12–21% |
| mean severity | from baseline log | ±0.5 |
| cost/digest at list | $1.944 | ≤ ~$0.30 |

Also reconcile against the Anthropic Console for that day. Out of band → fix the prompt, don't roll back.

---

## Verification (every sub-phase)

`npx tsc --noEmit` · `npx eslint` · `npx vitest run` clean at every step, plus `next build` on F.2 since it touches both API routes.

Every code-changing sub-phase (F.1, F.2, F.4) goes through the standard convergence loop from `CLAUDE.md`: **`qa` and `code-reviewer`, both agents, every round, until a round comes back genuinely clean from both.** Never drop to one agent; never decide in advance that a round is the last one regardless of what it finds. F.2 is the escalation case — it touches pipeline decision points and both API routes, so any consequential fix there gets a full fresh cold review rather than a narrowed round.

Instrumentation failure modes and how each is caught: **silent zeros** (`normalizeUsage` returns null, never zeros → the run is labelled a FLOOR); **a scope never entered** (route-level self-check warns when cards exist but zero calls were recorded); **ALS lost across the generator boundary** (only visible through the real streamed route — hence the wiring test goes through `POST()`); **cross-request bleed** (the two-concurrent-scopes test); **retry under-count** (`claudeText.usage.test.ts`, plus `N calls for M cards` visible in the log); **stale list pricing** (undetectable in code — hence `PRICING_VERIFIED_ON` prints in every footer and F.3 reconciles against the real Console bill).

**Total API spend for the phase:** one full digest generation plus a few expands in F.3, and one re-measurement run in F.4 if an optimization ships. All of F.1 and F.2 is verified against mocked responses at zero cost.

---

## Docs

When the phase lands: correct `(C) TECH_STACK.md` (lines 48 and 50, including its dangling reference to "the Phase 5 cost/quality pass" — a phase label that no longer exists) and `(C) ARCHITECTURE.md` line 45; mark the Final Phase done in `(C) ROADMAP.md` and record the per-digest figure **inside V2.0**, whose cap arithmetic currently assumes a $0.20 digest; write the full detail into `notes-logs/project-log.md`; refresh the one-paragraph status line in `CLAUDE.md` and nothing more; then run the bundled `project-resume-sync` skill.
