import { defineConfig } from "oxfmt";
import preset from "ultracite/oxfmt";

// ADR-0070 / KRT-BP001: spread the Ultracite oxfmt preset unchanged, repeat its
// ignore patterns, add the repository-only `.constitution/**`, and exclude
// Markdown, YAML and TOML so only the existing TypeScript, JavaScript, JSON and
// JSONC inventory is formatted.
export default defineConfig({
  ...preset,
  ignorePatterns: [
    ...(preset.ignorePatterns ?? []),
    ".constitution/**",
    "**/*.md",
    "**/*.mdx",
    "**/*.yaml",
    "**/*.yml",
    "**/*.toml",
  ],
});
