import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOPICS } from "@/types";
import { COUNTRIES, COUNTRIES_TOPIC } from "@/config/countries";

// The migration names its topic, country and container as string literals,
// since SQL can't import the TypeScript constants. These checks tie each
// literal to the constant it has to equal, so a later rename of one side
// fails here instead of leaving a hand-run block that silently matches no
// rows. The block's behaviour on real rows was proved in PGlite at the time
// it was written; this file only guards the names and the shape.

const schema = readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8");

function migrationBlock(): string {
  const start = schema.indexOf("-- V2.7 migration: the Morocco topic becomes the Morocco country");
  expect(start).toBeGreaterThan(-1);
  const begin = schema.indexOf("\nbegin;", start);
  const end = schema.indexOf("\ncommit;", begin);
  expect(begin).toBeGreaterThan(start);
  expect(end).toBeGreaterThan(begin);
  return schema.slice(begin, end + "\ncommit;".length);
}

const RETIRED_TOPIC = "Morocco";

describe("V2.7 migration: the Morocco topic becomes the Morocco country", () => {
  it("retires a name that is no longer a topic, in favour of a country that exists", () => {
    expect(TOPICS as readonly string[]).not.toContain(RETIRED_TOPIC);
    expect(COUNTRIES).toContain(RETIRED_TOPIC);
    expect(COUNTRIES_TOPIC).toBe("Countries");
  });

  it("runs as one transaction", () => {
    const block = migrationBlock();
    expect(block.startsWith("\nbegin;")).toBe(true);
    expect(block.endsWith("\ncommit;")).toBe(true);
  });

  it("gives each holder the Countries topic and the Morocco country, skipping rows they already have", () => {
    const block = migrationBlock();
    expect(block).toMatch(
      /insert into public\.user_topics \(user_id, topic\)\s+select user_id, 'Countries' from public\.user_topics where topic = 'Morocco'\s+on conflict \(user_id, topic\) do nothing;/
    );
    expect(block).toMatch(
      /insert into public\.user_subtopics \(user_id, topic, subtopic\)\s+select user_id, 'Countries', 'Morocco' from public\.user_topics where topic = 'Morocco'\s+on conflict \(user_id, topic, subtopic\) do nothing;/
    );
  });

  it("deletes the topic rows only after both inserts have read them", () => {
    const block = migrationBlock();
    const deleteAt = block.indexOf("delete from public.user_topics where topic = 'Morocco';");
    expect(deleteAt).toBeGreaterThan(block.indexOf("insert into public.user_subtopics"));
    expect(deleteAt).toBeGreaterThan(block.indexOf("insert into public.user_topics"));
  });

  it("refiles every Morocco card under Countries · Morocco", () => {
    expect(migrationBlock()).toContain(
      "update public.cards set topic = 'Countries', subtopic = 'Morocco' where topic = 'Morocco';"
    );
  });
});
