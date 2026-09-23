import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// The write lockdown on `digests` and `cards` lives entirely in SQL, which
// vitest cannot execute. What it CAN do is hold the file to the shape the
// lockdown depends on, so a later edit that quietly reopens a write path
// fails here rather than in production.
//
// Three properties, and each one is load-bearing on its own:
//
//   - The functions run as their owner (`security definer`) with a fixed
//     `search_path`. Without definer rights they cannot write at all once the
//     policies are gone; without the empty search_path a definer function is
//     the classic escalation, since an unqualified name resolves against
//     whatever schema the caller put first.
//   - Execute is revoked from `public` and `anon`. Functions in `public` are
//     executable by everyone by default, so converting one to definer and
//     forgetting this turns a policy-bounded write into an anonymous one.
//     This is the assertion most worth having: it is the failure mode where
//     the change meant to close a hole opens a wider one.
//   - No insert or update policy exists on either table. That is the lockdown
//     itself.
//
// What this does NOT establish: that any of it behaves as written. A definer
// function's ownership check is a runtime property, and an MCP connection
// runs as `postgres` with no auth.uid() so it cannot even be refused. The
// live probe with a real user's JWT is what establishes behaviour.

const schemaSql = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");

/** The three functions that are now the only write path into either table. */
const WRITE_FUNCTIONS = [
  {
    name: "persist_generated_cards",
    signature: "public.persist_generated_cards(uuid, jsonb, timestamptz, jsonb)",
  },
  {
    name: "ensure_digest_for_today",
    signature: "public.ensure_digest_for_today(date)",
  },
  {
    name: "set_expanded_report",
    signature: "public.set_expanded_report(uuid, text)",
  },
] as const;

/**
 * The text of one function, from its `create or replace` through the `$$;`
 * that ends it. Returns null when the function is not in the file at all,
 * which is a distinct failure from "is in the file but wrong" and is asserted
 * separately below — a regex that silently matches nothing is how a test like
 * this passes while checking nothing.
 */
function functionBody(name: string): string | null {
  const start = schemaSql.indexOf(`create or replace function public.${name}(`);
  if (start === -1) return null;
  const end = schemaSql.indexOf("\n$$;", start);
  if (end === -1) return null;
  return schemaSql.slice(start, end);
}

/**
 * Just the declaration, up to `as $$` — where the modifiers live. Checking
 * definer rights against the whole function would match the word in any
 * comment inside it, which is a test that passes on prose.
 */
function functionHeader(name: string): string | null {
  const body = functionBody(name);
  if (body === null) return null;
  const end = body.indexOf("\nas $$");
  return end === -1 ? null : body.slice(0, end);
}

describe("schema.sql: the write paths into digests and cards", () => {
  it("defines all three functions this test then goes on to check", () => {
    // Guards every assertion below: if a rename made functionBody() return
    // null, the checks on definer rights and search_path would all pass
    // vacuously against an empty string.
    for (const fn of WRITE_FUNCTIONS) {
      expect(functionBody(fn.name), `${fn.name} is missing from schema.sql`).not.toBeNull();
    }
  });

  it.each(WRITE_FUNCTIONS)("runs $name as its owner, with a pinned search_path", ({ name }) => {
    const header = functionHeader(name);
    expect(header, `${name} has no declaration ending in "as $$"`).not.toBeNull();
    expect(header).toContain("security definer");
    expect(header).not.toContain("security invoker");
    expect(header).toContain("set search_path = ''");
  });

  it.each(WRITE_FUNCTIONS)("checks the caller is signed in before $name writes", ({ name }) => {
    // auth.uid() is null for an anon caller. Every one of these reads it and
    // refuses rather than writing a row owned by nobody.
    expect(functionBody(name)).toContain("auth.uid()");
  });

  it.each(WRITE_FUNCTIONS)("revokes $name from public and anon, granting only authenticated", ({ signature }) => {
    expect(schemaSql).toContain(`revoke execute on function ${signature} from public, anon;`);
    expect(schemaSql).toContain(`grant execute on function ${signature} to authenticated;`);
  });

  it("ties persist_generated_cards' rank update to the digest it verified", () => {
    // Under definer rights a bare `c.id = ...` updates any user's card. The
    // digest_id guard is what keeps the statement inside the caller's own
    // data, paired with the ownership check on p_digest_id.
    const body = functionBody("persist_generated_cards") ?? "";
    expect(body).toContain("and c.digest_id = p_digest_id");
  });

  it("will not let persist_generated_cards move the cursor to an arbitrary time", () => {
    // A caller-supplied timestamp is what would walk the since-cursor
    // backwards and force the cold-lookback, firstEver-allowance run shape on
    // every generation -- the hole dropping `update own digests` is for.
    const body = functionBody("persist_generated_cards") ?? "";
    expect(body).toContain("p_generated_at < now() - interval '10 minutes'");
    expect(body).toContain("p_generated_at > now() + interval '1 minute'");
  });
});

describe("schema.sql: no session can write digests or cards directly", () => {
  const FORBIDDEN_POLICIES = [
    { policy: "insert own digests", table: "public.digests" },
    { policy: "update own digests", table: "public.digests" },
    { policy: "insert own cards", table: "public.cards" },
    { policy: "update own cards", table: "public.cards" },
  ] as const;

  it.each(FORBIDDEN_POLICIES)("does not create $policy", ({ policy }) => {
    expect(schemaSql).not.toContain(`create policy "${policy}"`);
  });

  it.each(FORBIDDEN_POLICIES)("drops $policy from a database that already has it", ({ policy, table }) => {
    // Absence from this file is not enough. It is applied by hand to a live
    // database, so a policy that already exists there has to be removed
    // explicitly or the lockdown holds only for a rebuild from scratch.
    expect(schemaSql).toContain(`drop policy if exists "${policy}" on ${table};`);
  });

  it("keeps both select policies, which every read path needs", () => {
    expect(schemaSql).toContain('create policy "select own digests"');
    expect(schemaSql).toContain('create policy "select own cards"');
  });
});

/**
 * The `create table public.digests (...)` block, or null when the anchor no
 * longer matches. Explicitly null rather than letting `indexOf` return -1 feed
 * `slice`: that happens to yield an empty string, against which every
 * `not.toContain` below would pass while checking nothing.
 */
function digestsTableBlock(): string | null {
  const start = schemaSql.indexOf("create table public.digests (");
  if (start === -1) return null;
  const end = schemaSql.indexOf(");", start);
  return end === -1 ? null : schemaSql.slice(start, end);
}

/**
 * The column names a CREATE TABLE block declares — the first token of each
 * non-comment line. Comparing against this instead of searching the block's
 * raw text is what stops the word "generating" inside a comment near this
 * table from failing the suite for no behavioural reason. This table already
 * carries several paragraphs about generation semantics, so that collision is
 * a matter of time rather than a hypothetical.
 */
function declaredColumns(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"))
    .map((line) => line.split(/[\s(,]/)[0])
    .filter((token) => /^[a-z_]+$/.test(token));
}

describe("schema.sql: the superseded generation flag is gone", () => {
  const digestsTable = digestsTableBlock();

  it("locates the digests table definition it then checks", () => {
    expect(digestsTable, "the digests CREATE TABLE anchor no longer matches").not.toBeNull();
    expect(digestsTable).toContain("last_generated_at timestamptz");
    expect(declaredColumns(digestsTable ?? "")).toContain("last_generated_at");
  });

  it.each(["generating", "generation_started_at"])("does not declare %s", (column) => {
    // These looked exactly like a working mutex while they sat on this table.
    // The real one is public.generation_claims, keyed on the user — a check
    // wired to a column here would resurrect the per-digest-row bug.
    expect(declaredColumns(digestsTable ?? "")).not.toContain(column);
  });

  it("drops both columns from a database that already has them", () => {
    // Same reason as the policy drops: absence from the CREATE TABLE removes
    // nothing from a live database this file is applied to by hand.
    expect(schemaSql).toContain("drop column if exists generating");
    expect(schemaSql).toContain("drop column if exists generation_started_at");
  });

  it("drops the superseded rank-update function", () => {
    expect(schemaSql).toContain("drop function if exists public.update_front_page_ranks(jsonb);");
  });
});

describe("schema.sql: the since-cursor query has an index", () => {
  it("indexes (user_id, last_generated_at) with the null predicate the query implies", () => {
    const match = schemaSql.match(
      /create index if not exists digests_user_last_generated_idx\s+on public\.digests \(user_id, last_generated_at desc\)\s+where last_generated_at is not null;/
    );
    expect(match).not.toBeNull();
  });
});

describe("schema.sql: the timezone write path", () => {
  // Same three properties as the digest and card write functions above, for
  // the same reasons. The value arrives from a browser, and it decides which
  // row every run of this user's writes into.
  it("runs set_time_zone as its owner, with a pinned search_path", () => {
    const header = functionHeader("set_time_zone");
    expect(header, "set_time_zone is missing from schema.sql").not.toBeNull();
    expect(header).toContain("security definer");
    expect(header).toContain("set search_path = ''");
  });

  it("checks the caller and the zone name before writing", () => {
    const body = functionBody("set_time_zone") ?? "";
    expect(body).toContain("auth.uid()");
    expect(body).toContain("pg_catalog.pg_timezone_names");
  });

  it("revokes set_time_zone from public and anon, granting only authenticated", () => {
    expect(schemaSql).toContain("revoke execute on function public.set_time_zone(text) from public, anon;");
    expect(schemaSql).toContain("grant execute on function public.set_time_zone(text) to authenticated;");
  });

  it("gives sessions no direct write to user_settings", () => {
    expect(schemaSql).toContain('create policy "select own settings"');
    expect(schemaSql).not.toMatch(/create policy "[^"]*"\s+on public\.user_settings for (insert|update|delete|all)/);
  });
});
