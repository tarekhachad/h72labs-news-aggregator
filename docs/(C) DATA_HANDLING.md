# (C) Data Handling — Personalized News Aggregator

Real user accounts exist from v1 (you plus, soon, a handful of friends testing), so this is a short, real policy rather than a placeholder — living document, revisit before any public launch.

---

## What's collected

- **Account info:** email + password, handled entirely by Supabase Auth — this app never sees or stores raw passwords itself.
- **Preferences:** selected topics of interest, selected preferred news sources.
- **Usage data:** generated digests/cards (tied to the user they were generated for), bookmarks.

No sensitive personal data beyond an email address is collected in v1. No payment info (nothing is monetized yet).

## Where it lives

All of it sits in Supabase (Postgres + Auth), a managed provider — not self-hosted, not stored in plaintext files. Traffic between the frontend and backend, and between the backend and Supabase, runs over HTTPS throughout.

## What's not done with it

- Nothing is sold or shared with third parties.
- News source content (articles pulled via RSS/GNews) is used only to generate a user's own digest — not redistributed or resold.
- No tracking/analytics beyond what's needed to see whether the product is actually being used (return visits) — see the instrumentation step in `(C) ROADMAP.md` Phase 6.

## Retention

Digests and bookmarks persist indefinitely for v1 (that's the point of the calendar history and bookmarking features) — no auto-deletion policy yet. Revisit this once there's real usage volume or before any public launch, per the H72 Labs plan's broader data-handling posture.

## Before any public launch

This is a v1/friends-testing policy, not a public-launch-ready one. Before opening this to the public: a real, visible privacy policy, an account-deletion path, and a decision on how long inactive accounts' data is retained.
