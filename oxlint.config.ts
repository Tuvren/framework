import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

// ADR-0070 / KRT-BP001: adopt the Ultracite OXC core preset exactly as shipped.
// `extends` does not carry the preset's `ignorePatterns` through, so the list is
// repeated here with the repository-only `.constitution/**` addition. No rule,
// severity or option is overridden locally.
export default defineConfig({
  extends: [core],
  ignorePatterns: [...(core.ignorePatterns ?? []), ".constitution/**"],
});
