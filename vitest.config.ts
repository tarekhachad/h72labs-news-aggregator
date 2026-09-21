import { defineConfig } from "vitest/config";
import path from "path";

// Minimal QA-only test config (not part of the shipped app) — resolves the
// "@/..." path alias the same way tsconfig.json does, so test files can
// import src modules the same way the app code does.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The five modules holding an Anthropic client `import "server-only"`,
      // a marker package whose main entry throws the moment it is imported.
      // Next resolves it under the "react-server" export condition, where it
      // is an empty module; vitest resolves the default entry instead, so
      // without this every test touching one of those modules dies on import.
      // Aliased to the package's own empty entry rather than to a stub of our
      // own, so what runs under test is the file React ships for exactly this
      // purpose.
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    // This project's folder lives inside a larger Obsidian vault tree, which
    // has its own unrelated test suites (e.g. .obsidian/plugins/claudian) —
    // without an explicit include pattern, vitest's default discovery walks
    // the whole working directory and picks those up too. Scope discovery to
    // this project's own src/ so `vitest run` only ever runs this repo's tests.
    include: ["src/**/*.test.{ts,tsx}"],
    // No setup file and no ANTHROPIC_API_KEY needed, including for the tests
    // that `vi.importActual` a real lib module (the triage wiring tests pull
    // triageBatchCount through unmocked, which loads triage.ts's module-level
    // `new Anthropic()`). The SDK constructor doesn't validate credentials —
    // it defers that to request time — so constructing a client at import is
    // inert, and every test that would actually issue a request mocks the SDK.
    // Verified rather than assumed: a review round raised this as a suspected
    // hidden dependency on a real key.
  },
});
