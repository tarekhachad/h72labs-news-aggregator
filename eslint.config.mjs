import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // This app lives at the root of the vault sub-folder alongside
    // Obsidian's own config/plugins and the project's design docs —
    // scope linting to the app code only.
    ".obsidian/**",
    ".claude/**",
    "docs/**",
    "notes-logs/**",
  ]),
  {
    // `scripts/cost-report.mts` loads this chain through Node 24's native type
    // stripping, which resolves specifiers itself and does NOT understand the
    // `@/` path alias. A VALUE import from an aliased path therefore breaks
    // `npm run cost-report` with ERR_MODULE_NOT_FOUND while tsc, eslint's own
    // type rules and the entire vitest suite stay green — every one of those
    // uses a resolver that does understand the alias. It happened twice on
    // 2026-09-14 and was invisible until someone ran the script by hand.
    //
    // The comments in those files explain the constraint; this rule is what
    // ENFORCES it. Intent stated only in prose does not fire, which is the
    // whole lesson of this module's guard-on-one-path-but-not-the-other bug
    // family. Keep the file list in sync with the chain: cost-report.mts ->
    // costReport.ts -> usageRecord.ts -> usage.ts (a leaf that imports nothing).
    //
    // TWO HONEST LIMITS, stated because an overstated guard is worse than a
    // modest one. (1) It is BROADER than the hazard: base `no-restricted-imports`
    // cannot see `importKind`, so it also blocks `import type` from `@/`, which
    // Node erases and which could never break the script. That is kept on
    // purpose — "always relative in these three files" is a simpler invariant
    // than "relative unless type-only", and it removes the trap where a
    // type-only import quietly gains a value binding later. (2) It is also
    // NARROWER than the hazard: a NEW file added to the chain and not added to
    // `files` above is unprotected, and no eslint glob can be checked against a
    // real import graph. Both agents flagged this in review round 2; the residual
    // risk is accepted and recorded here rather than papered over.
    files: ["src/lib/costReport.ts", "src/lib/usageRecord.ts", "src/lib/usage.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/*"],
              message:
                "Use a relative './x.ts' specifier here. scripts/cost-report.mts loads this module via Node's native type stripping, which cannot resolve the @/ alias, so an aliased VALUE import breaks `npm run cost-report` while tsc and every test stay green. This rule DELIBERATELY also blocks `import type` from @/ in these files, which is harmless on its own — the simpler 'always relative here' invariant is what stops a type-only import from silently becoming a value import later.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
