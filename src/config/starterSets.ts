import type { Topic } from "@/types";

/**
 * One-click topic sets on the onboarding grid. Pressing one replaces the
 * topic picks with its topics and leaves countries and outlets alone; the
 * reader edits from there and nothing saves until they do. Drafts for Tarek
 * to try before deciding whether to keep them.
 */
export const STARTER_SETS: readonly { name: string; topics: readonly Topic[] }[] = [
  {
    name: "Morocco watcher",
    topics: ["Morocco", "Morocco Politics", "Morocco Finance", "Africa", "French Politics", "Football"],
  },
  {
    name: "World and geopolitics",
    topics: ["Geopolitics", "Middle East", "European Union", "Asia-Pacific", "Africa", "Defense & Security"],
  },
  {
    name: "Tech and markets",
    topics: ["Tech/AI", "Cybersecurity", "Markets & Investing", "US Finance", "Crypto", "Economy"],
  },
  {
    name: "Sport",
    topics: ["Football", "Basketball", "Tennis", "Formula 1", "Boxing & MMA", "Olympics & Athletics"],
  },
];
