import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Reads supabase/schema.sql the way a database built from it, then migrated by
// hand in file order, would end up: the seed insert, then every later
// `update public.spend_config set …` block on top. A test against the seed
// alone would pass while the block a live database actually runs said
// something else.

const schema = readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8");

// Comments out, both kinds, so a figure quoted in prose is never read as a
// value and a commented-out block never counts as applied.
const sql = schema.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

const SEED_COLUMNS = [
  "id",
  "generation_enabled",
  "user_window_usd",
  "global_window_usd",
  "max_digest_runs_per_window",
  "max_expands_per_window",
  "digest_base_usd",
  "digest_per_topic_usd",
  "digest_max_usd",
  "digest_max_topics",
  "expand_usd",
] as const;

type Config = Record<string, string>;

function seedConfig(): Config {
  const seed = sql.match(/insert\s+into\s+public\.spend_config\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)/i);
  if (!seed) throw new Error("spend_config seed insert not found in schema.sql");
  const columns = seed[1].split(",").map((c) => c.trim());
  const values = seed[2].split(",").map((v) => v.trim());
  expect(columns).toEqual(SEED_COLUMNS);
  return Object.fromEntries(columns.map((c, i) => [c, values[i]]));
}

// Every statement that writes spend_config after the seed, found loosely (any
// case, any spacing) so none can slip past, then each read strictly: one that
// does not fit the shape below fails the test rather than being skipped.
function updateBlocks(): Config[] {
  const statements = [...sql.matchAll(/\bupdate\s+(?:only\s+)?(?:"?public"?\s*\.\s*)?"?spend_config"?(?![\w"])[^;]*;/gi)].map(
    (m) => m[0]
  );
  return statements.map((statement) => {
    const strict = statement.match(/^update\s+public\.spend_config\s+set\s+([\s\S]*?)\s+where\s+id\s*=\s*1\s*;$/i);
    if (!strict) throw new Error(`spend_config update this test cannot read: ${statement}`);
    return Object.fromEntries(
      strict[1].split(",").map((assignment) => {
        const [column, value] = assignment.split("=").map((part) => part.trim());
        return [column.toLowerCase(), value];
      })
    );
  });
}

function effectiveConfig(): Config {
  return Object.assign(seedConfig(), ...updateBlocks());
}

// Postgres numeric is exact decimal; summing JavaScript floats is not
// (0.05 + 0.065 * 10 is 0.7000000000000001). Millionths match numeric(12,6).
function micro(decimal: string): number {
  return Math.round(Number(decimal) * 1_000_000);
}

// reserve_spend's digest formula, in the same terms as the SQL:
// least(max, base + per_topic * least(greatest(coalesce(n, max_topics), 1), max_topics))
function digestReservationMicro(config: Config, topicCount: number | null): number {
  const maxTopics = Number(config.digest_max_topics);
  const counted = Math.min(Math.max(topicCount ?? maxTopics, 1), maxTopics);
  return Math.min(
    micro(config.digest_max_usd),
    micro(config.digest_base_usd) + micro(config.digest_per_topic_usd) * counted
  );
}

describe("spend reservation sizing", () => {
  it("still reads the formula this test mirrors from reserve_spend", () => {
    const formula = sql.match(/v_amount := least\(([\s\S]*?)\);/);
    expect(formula?.[1].replace(/\s+/g, " ").trim()).toBe(
      "v_cfg.digest_max_usd, v_cfg.digest_base_usd + v_cfg.digest_per_topic_usd * least(greatest(coalesce(p_topic_count, v_cfg.digest_max_topics), 1), v_cfg.digest_max_topics)"
    );
  });

  it("reserves $0.70 for a 10-topic digest", () => {
    expect(digestReservationMicro(effectiveConfig(), 10)).toBe(700_000);
  });

  it("caps topics at 10, so a larger profile or a missing count reserves the same $0.70", () => {
    const config = effectiveConfig();
    expect(config.digest_max_topics).toBe("10");
    expect(digestReservationMicro(config, 13)).toBe(700_000);
    expect(digestReservationMicro(config, null)).toBe(700_000);
  });

  it("reaches the $0.70 ceiling only at the largest profile, so no topic count is cut short by it", () => {
    const config = effectiveConfig();
    expect(digestReservationMicro(config, 9)).toBeLessThan(micro(config.digest_max_usd));
    expect(micro(config.digest_base_usd) + micro(config.digest_per_topic_usd) * 10).toBe(
      micro(config.digest_max_usd)
    );
  });

  // A live database never re-runs the seed insert, so the update block is the
  // only thing that changes it there. Without one, every check above would
  // pass on the seed alone while production kept its old values.
  it("has an update block that sets both values on a live database", () => {
    const live = Object.assign({}, ...updateBlocks()) as Config;
    expect(live.digest_per_topic_usd).toBeDefined();
    expect(live.digest_max_topics).toBeDefined();
    expect(micro(live.digest_per_topic_usd)).toBe(65_000);
    expect(live.digest_max_topics).toBe("10");
  });

  it("keeps the seed values in step with the live-database update block", () => {
    const seed = seedConfig();
    const live = Object.assign({}, ...updateBlocks()) as Config;
    expect(micro(seed.digest_per_topic_usd)).toBe(micro(live.digest_per_topic_usd));
    expect(seed.digest_max_topics).toBe(live.digest_max_topics);
  });
});
