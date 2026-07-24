# (C) Glossary — Personalized News Aggregator

Plain-language definitions of terms used across the other design docs. Add to this as building surfaces new ones.

---

**API (Application Programming Interface)** — a defined way for one piece of software to ask another for data or to do something. E.g., "calling the Claude API" means sending it text and getting a response back, over the internet.

**API route / endpoint** — a specific URL your backend responds to, e.g. "generate a digest" or "save a bookmark." In this project these are internal — only the frontend calls them, not outside developers.

**Auth (authentication)** — proving who a user is (login/signup, sessions). "Managed auth provider" means a third-party service (Supabase Auth here) handles the risky parts (password storage, session security) instead of you building it from scratch.

**Backend** — the server-side part of the app: the logic that talks to the database, calls the Claude API, runs the news pipeline. The user never sees it directly.

**Clustering** — grouping similar things together. Here: grouping articles from different outlets that are all covering the same underlying event into one group, before deciding whether that event deserves a card.

**Embeddings** — a way of converting text into a list of numbers (a "vector") such that texts with similar meaning end up numerically close to each other. Used here to do clustering without needing an AI model to read and compare every article directly — much cheaper.

**Frontend** — the part of the app the user actually sees and interacts with (the feed, the cards, the login screen).

**GNews** — a paid news API (with a free tier) used as a supplemental news source when RSS coverage for a topic is thin.

**LLM (Large Language Model)** — the kind of AI model Claude is; good at reading and generating natural language text. Used here for the actual writing step (turning multiple raw articles into one readable card).

**Notability triage** — the step where a cheap AI call looks at a cluster of articles and decides "is this actually a distinct, meaningfully notable story," before spending more (on the pricier model) to write it up.

**Postgres** — a widely-used, standard type of database for storing structured data (rows and tables) — what Supabase provides here.

**Prompt caching** — a Claude API feature that reduces cost when the same instructions/context get reused across calls, by not re-charging full price for the repeated part.

**RSS feed** — a standard, free format that news sites publish their own articles in, meant to be read by software rather than a browser. The primary news source for this project.

**Serverless function** — a small piece of backend code that runs on demand (e.g. when a user requests a digest) without you having to manage a server that's running all the time. This is how Vercel hosts the backend logic.

**Session** — the mechanism that keeps a user "logged in" across visits without re-entering a password every time. Handled by the managed auth provider.

**Supabase** — the service providing both the Postgres database and the managed auth for this project.

**Tiered model usage** — using a cheaper AI model (Claude Haiku) for simpler judgment calls (notability triage) and a more capable, pricier model (Claude Sonnet) only where quality genuinely matters (writing the final card), instead of using the expensive model for everything.

**Vercel** — the hosting service this project deploys to; built specifically for Next.js apps.
