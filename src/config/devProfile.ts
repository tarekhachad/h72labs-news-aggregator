import type { Source, Topic } from "@/types";

/**
 * Phase 1 has no auth/DB — this stands in for a real per-user profile
 * (see docs/DATABASE_SCHEMA.md `user_topics` / `user_preferred_sources`)
 * until Phase 2 wires up Supabase.
 */
export const devProfile: { topics: Topic[]; preferredSources: Source[] } = {
  topics: ["Tech/AI", "Geopolitics"],
  preferredSources: ["NYT", "BBC", "TechCrunch"],
};
