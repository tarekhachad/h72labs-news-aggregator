# (C) Tech Stack — Personalized News Aggregator

What's chosen, and why, in plain language. Every non-obvious term also lives in `(C) GLOSSARY.md`.

---

## Frontend + backend: Next.js on Vercel

**What it is:** Next.js is a web app framework that lets one codebase handle both what the user sees (the feed, cards, login screen) and the server-side logic (talking to Claude, the database, etc.) — no separate frontend/backend repos to manage. Vercel is the hosting service made for Next.js; you push code, it deploys automatically.

**Why:** You're not from a software-engineering background, and this pairing is the most common, best-documented combination for exactly this kind of solo-built web app — meaning Claude Code has the most to work with when building it, and there's the most help available if something breaks.

**Cost:** Vercel's Hobby plan is **free forever** for non-commercial projects (100GB data transfer/month, 1M function calls/month — far beyond what you and a handful of friends testing this would use). It's explicitly non-commercial-only, which is fine — this project isn't monetized yet. Upgrade to Pro ($20/month) only once/if it starts generating revenue, per the freemium plan.

---

## Database + Auth: Supabase

**What it is:** Supabase gives you a real Postgres database (a standard, well-supported way to store structured data — users, topics, cards, bookmarks) *and* a managed authentication system (real signup/login/sessions) in one service, so you don't have to wire up two separate tools.

**Why:** You specifically want a real, working login screen in v1 to test that workflow — but hand-rolling password storage and session security yourself is exactly the kind of place a solo non-engineer introduces security bugs, and it teaches you auth plumbing rather than your actual product. Supabase Auth gives you the real signup/profile-creation workflow you want to test, without you owning the risky parts.

**Cost:** Free tier — $0/month. Limits: 500MB database, 50,000 monthly active users (far more than needed here). One quirk: a free project auto-pauses after 7 days with zero activity — data isn't lost, it just needs a manual resume. Not an issue once real usage is happening.

---

## News sourcing: RSS feeds (primary) + GNews (optional supplement)

**What it is:** RSS is a standard format news sites publish their own articles in — free to read, no usage restrictions, real-time. GNews is a news API (a paid service that returns structured article data) with a free tier for supplementing topics where a good RSS feed isn't easy to find.

**Why not NewsAPI.org:** Checked the actual terms — NewsAPI's free tier technically blocks any request from a non-localhost domain. It would stop working the instant this app is deployed for anyone but you to test on `localhost`, regardless of whether it's monetized. It's a dead end for this project.

**Why RSS as primary:** No commercial-use restriction, no domain lock, free, real-time. **GNews as backup:** free tier works from any domain but forbids commercial use (fine — not monetized yet) and delays articles by 12 hours (acceptable for supplementary coverage, not for every topic).

---

## Synthesis engine: tiered Claude API usage + free local clustering

**What it is:** The step that turns raw articles into readable cards. Rather than sending every raw article straight to the most capable (and most expensive) Claude model, the pipeline is split:

1. **Clustering — free, local, no API.** Articles about the same story are grouped using **text embeddings** (a way of turning text into numbers so "similar meaning" articles land near each other mathematically) via a free, open-source embedding model. No Claude call, no cost.
2. **Notability triage — Claude Haiku (cheapest tier).** One quick, cheap call judges a batch of up to 20 clusters from the same topic (batched in F.4.5, after the F.3 cost measurement found 91% of a per-cluster call's input was the same prompt bytes re-sent), deciding for each whether it's distinct/notable enough to become a card. Filters volume down before the expensive step.
3. **Card writing — hybrid Claude Sonnet/Haiku.** Only for clusters that pass triage. Sonnet for multi-source clusters, where turning several accounts of one story into clean briefing prose is a real writing task; Haiku for single-source ones, which the F.3 measurement showed are ~89% of clusters and have nothing to synthesize. Split in F.4.3 — before that, every card paid Sonnet prices for what was usually a rewrite of one article.
4. **Expanded report — Claude Sonnet, generated lazily.** Not pre-built for every card; generated once, the first time a user actually opens that card, then cached. Saves cost on cards nobody ever expands.

**Why this over "just send everything to Claude":** the original idea (one Claude call doing clustering + notability judgment + writing, per topic, from raw articles) works, but pays premium-model prices for a dedup/filtering step that's free to do with embeddings. Splitting the pipeline keeps quality on the part that needs it and cuts cost everywhere else.

One caveat this framing got wrong for months, worth stating so the next reader doesn't inherit it: "keep quality on the writing, cut cost elsewhere" quietly implies the writing is where the money goes. It isn't. Triage runs once per *cluster* — hundreds a day — while writing runs once per *card*, a few dozen. Measured, triage was ~65% of spend. Cheap-per-call is not cheap in aggregate, and the number of calls is what to look at first.

**Real cost (measured 2026-08-15, end of the Final Phase).** A full digest against the real 9-topic profile, 716 clusters, 62 cards:

| | at list | billed |
|---|---|---|
| **per digest** | **$0.399** | $0.335 |
| triage (39 calls, Haiku) | $0.157 | $0.157 |
| card writing (67 calls: 29 Sonnet, 38 Haiku) | $0.237 | $0.174 |
| front-page ranking (1 call) | $0.005 | $0.005 |
| **per card expanded** (Sonnet, on demand) | **~$0.017** | ~$0.012 |

Use the **at-list** column for any forward projection: Sonnet is on introductory pricing until 2026-08-31, and from 1 September the at-list figure *is* the bill.

**Read this as a cold-start number.** Every measurement so far — this one included — is the first run of a brand-new account: null cursor, full 48h lookback, cross-run dedup skipped because there are no cards yet to compare against. A returning daily user starts from a ~24h cursor and ingests roughly half as much, so their recurring digest costs materially less. That figure has never been measured. Sizing anything off $0.399 per user per day therefore overestimates, probably by close to 2× — the safe direction, but not the true one.

**What the two earlier numbers on this line said, and why they were wrong.** The original estimate was $0.20–0.30/digest and ~$15–50/month. A 2026-07-28 run then recorded **$0.17** and was read as confirming it. That run used the 2-topic/3-source dev profile; the real profile has 9 topics, and cost scales with topics far harder than the estimate assumed, because triage fires per *cluster*. Measured properly on 2026-08-13 the same pipeline cost **$1.94/digest — about 10× the documented figure**, and that error had already propagated into V2.0's spend caps. Optimization (input caps, a per-topic card cap, hybrid Haiku/Sonnet writing, a cross-day cursor, and batched triage) brought it to $0.399, **−79.5%**. Full history in `notes-logs/(C) cost-diagnosis-2026-08-13.md` and its post-optimization successor.

The lesson worth carrying: a measurement taken against a toy profile is not a measurement of the product, and "in line with the estimate" is the most dangerous thing a cheap number can look like.

---

## Summary: what it costs to run

| Piece | Cost |
|---|---|
| Vercel (hosting) | $0/month (Hobby, non-commercial) |
| Supabase (DB + Auth) | $0/month (Free tier) |
| RSS feeds | $0 (always) |
| GNews (supplement) | $0 (free tier, non-commercial) |
| Claude API (synthesis) | **$0.399/digest at list** (+~$0.017 per card expanded). One user once a day ≈ **$12/month**; ten users ≈ **$120/month** at full daily usage. Cold-start figure — a returning daily user costs materially less. |

Living document — will be revised as the build reveals what actually works.
