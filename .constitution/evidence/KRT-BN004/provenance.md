# Published baseline and release classification

The official npm registry metadata for `@tuvren/core`, `@tuvren/sdk`, and
`@tuvren/backend-postgres` version 0.1.0 was retrieved on 2026-09-29. These are
exact retained responses, with their byte counts and digests in manifest.yaml:

- https://registry.npmjs.org/%40tuvren%2Fcore/0.1.0
- https://registry.npmjs.org/%40tuvren%2Fsdk/0.1.0
- https://registry.npmjs.org/%40tuvren%2Fbackend-postgres/0.1.0

Registry metadata at a fixed package version is mutable; the retained bytes
anchor this inspection. All three identify version 0.1.0 and gitHead
`1aa55b7aa44c956a085f36b29c8575419c3334c0` in the upstream repository
https://github.com/Tuvren/framework. The packages declare SPDX `Apache-2.0`;
their source license is
https://github.com/Tuvren/framework/blob/1aa55b7aa44c956a085f36b29c8575419c3334c0/LICENSE.
That package license declaration is not a separate license claim about the
registry database.

The registry gitHead is outside master's ancestry. Mainline integration
`b2244918fbc3cef0ed81cec78fddd686ac0a0427` has equivalent TypeScript source;
the translation diff changes only two README and two Nx project files.
The retained translation and source-equivalence logs establish that mapping.
SDK composition already existed in the published baseline.

At inspected parent `5b10fb15f341dff19581cb7d2c267be11ca3dcca`, nineteen current
public packages have package-path changes after that baseline. The pending
working-tree intent directly covers that exact set. PostgreSQL is minor because
the published omitted schemaName default changed from public to tuvren_kernel.
The existing implicit-public database requires schemaName: "public" to select
its legacy schema for migration; the new guard otherwise rejects it. The lead
ran the real PostgreSQL regression suite: three tests and eight assertions
passed. A selected blob schema migrates on first open; downgrades remain
unsupported, as ADR-0067 records.

The exact frozen snapshot comparison finds only two existing stable signature
changes: the optional AgentConfig sanitizer hook and its SDK re-export. They
are additive and receive patch entries under ADR-0069. The other sixteen
public entries are patch. Historical freeze-ledger structural major/minor labels
do not determine this 0.x release classification.

The highest direct intent is minor, targeting 0.2.0. Native Changesets CLI
2.31.0 / assemble-release-plan 6.0.10 instead computes 1.0.0 for all thirty
fixed members, including nineteen public packages. This is a downstream
blocker, not a successful release-plan validation. The fixed group spreads the
PostgreSQL minor to core, then core's out-of-range tilde peers cause native
major propagation, which the fixed group spreads again. The supported
onlyUpdatePeerDependentsWhenOutOfRange flag cannot suppress an actual
out-of-range minor. Configuration, peers, sources, and versions were preserved.
BN005 is deferred to scoped Tasks planning and technical tooling alignment.
