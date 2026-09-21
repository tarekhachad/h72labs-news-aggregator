import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// Every module that constructs an Anthropic client must be unreachable from a
// client component. `import "server-only"` is what enforces that: Next
// resolves it to a module that throws unless it is being bundled for the
// server, so importing one of these from a client component fails the build
// instead of shipping an API key to a browser.
//
// The list is DERIVED, not written down. A sixth module that constructs a
// client and forgets the guard fails this test the moment it is added, which
// a hardcoded list of five would not catch -- and a hardcoded list is exactly
// what goes stale silently.

const LIB_DIR = join(process.cwd(), "src/lib");

function modulesConstructingAnthropicClient(): string[] {
  return readdirSync(LIB_DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => readFileSync(join(LIB_DIR, f), "utf8").includes("new Anthropic("));
}

describe("modules holding an Anthropic client are server-only", () => {
  const modules = modulesConstructingAnthropicClient();

  it("finds the modules it is meant to be checking", () => {
    // Without this, a change to how the client is constructed would empty the
    // list and every assertion below would pass over nothing.
    expect(modules.length).toBeGreaterThanOrEqual(5);
  });

  it.each(modules)("%s imports server-only", (file) => {
    const source = readFileSync(join(LIB_DIR, file), "utf8");
    expect(source).toContain('import "server-only";');
  });

  it.each(modules)("%s imports it before anything it guards", (file) => {
    // A guard placed after the SDK import still fails the build, but reading
    // it first is what makes the constraint obvious to the next person to
    // open the file.
    const source = readFileSync(join(LIB_DIR, file), "utf8");
    const guardAt = source.indexOf('import "server-only";');
    const sdkAt = source.indexOf('from "@anthropic-ai/sdk"');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(sdkAt);
  });
});
