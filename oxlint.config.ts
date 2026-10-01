import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

// ADR-0070 / KRT-BP001: adopt the Ultracite OXC core preset exactly as shipped.
// The preset is spread verbatim at the root. `extends` is not used because
// oxlint 1.86.0 drops option-bearing rule tuples and the preset `env` through
// that path; here the only local change is layering ignore patterns on top,
// with the repository-only `.constitution/**` addition. No rule, severity,
// option or environment policy is overridden locally.
export default defineConfig({
  ...core,
  ignorePatterns: [...(core.ignorePatterns ?? []), ".constitution/**"],
});
