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
]);

export default eslintConfig;
