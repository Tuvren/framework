# @tuvren/kernel-runtime

Internal Tuvren kernel runtime engine (ADR-0057) — an engine dependency of @tuvren/sdk, not a host-facing API. Not semver-guaranteed.

> **Internal engine package.** Do not install or import this package directly — it exists on the registry only so the published Tuvren packages can resolve their dependency graph. It is not semver-guaranteed and may change shape between minors (ADR-0057). Hosts compose the framework through [`@tuvren/sdk`](https://www.npmjs.com/package/@tuvren/sdk) and their chosen leaf packages.

See the [Tuvren framework repository](https://github.com/Tuvren/framework) for documentation.

`kernel.verdicts.compose(verdicts)` returns a Promise for its selected verdict. If malformed input causes evaluation to fail, the Promise rejects with that error. Handle failures with `await` and `try`/`catch`. Verdict priority and values are unchanged.
