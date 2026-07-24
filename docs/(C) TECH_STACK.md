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
2. **Notability triage — Claude Haiku (cheapest tier).** One quick, cheap call per cluster decides if it's actually distinct/notable enough to become a card. Filters volume down before the expensive step.
3. **Card writing — Claude Sonnet.** Only for clusters that pass triage — this is the one step that genuinely needs a capable model, since turning multi-source text into clean briefing-style prose is a real writing task, not something a classical/free method does well.
4. **Expanded report — Claude Sonnet, generated lazily.** Not pre-built for every card; generated once, the first time a user actually opens that card, then cached. Saves cost on cards nobody ever expands.

**Why this over "just send everything to Claude":** the original idea (one Claude call doing clustering + notability judgment + writing, per topic, from raw articles) works, but pays premium-model prices for a dedup/filtering step that's free to do with embeddings. Splitting the pipeline keeps quality on the part that needs it (the writing) and cuts cost everywhere else.

**Cost estimate (rough, to validate once built):** roughly $0.20–$0.30 per full digest generation at current Sonnet pricing (~$2–3/M input tokens, ~$10–15/M output tokens). For you plus a handful of friends checking once a day, that's roughly **$15–50/month** — the only real variable cost in this stack, everything else above is $0. Actual number depends heavily on real usage patterns; instrument it once live rather than trusting this estimate blindly.

---

## Summary: what it costs to run

| Piece | Cost |
|---|---|
| Vercel (hosting) | $0/month (Hobby, non-commercial) |
| Supabase (DB + Auth) | $0/month (Free tier) |
| RSS feeds | $0 (always) |
| GNews (supplement) | $0 (free tier, non-commercial) |
| Claude API (synthesis) | ~$15–50/month estimate, scales with actual usage |

Living document — will be revised as the build reveals what actually works.
