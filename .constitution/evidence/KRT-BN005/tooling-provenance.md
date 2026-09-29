# Native planner alignment

On 2026-09-29, the official npm registry and distributed artifacts identified
Changesets CLI 3.0.3, assemble-release-plan 7.0.0, and config 4.0.1. Exact
versioned metadata responses are retained as .json.txt archives and digested
in manifest.yaml. Canonical source URLs for reproduction are:

- https://registry.npmjs.org/%40changesets%2Fcli/3.0.3
- https://registry.npmjs.org/%40changesets%2Fassemble-release-plan/7.0.0
- https://registry.npmjs.org/%40changesets%2Fconfig/4.0.1

Metadata is mutable even at a fixed version; the retained bytes anchor this
observation. Each response names the upstream repository
https://github.com/changesets/changesets and its packages/cli,
packages/assemble-release-plan, or packages/config directory. gitHead is absent;
no upstream commit is inferred. The versioned canonical tarballs are:

- https://registry.npmjs.org/@changesets/cli/-/cli-3.0.3.tgz
- https://registry.npmjs.org/@changesets/assemble-release-plan/-/assemble-release-plan-7.0.0.tgz
- https://registry.npmjs.org/@changesets/config/-/config-4.0.1.tgz

The probe verified each published SHA-1 and SHA-512 integrity against those
downloaded bytes and inspected the distributed package manifests. License
expression is MIT; each tarball contains package/LICENSE. The CLI license text
is retained as changesets-license.txt. Tarball digests/integrity are also in
the retained metadata; complete historical downloads remain under the probe's
temporary artifact directory.

The detached probe used prepared Bun 1.3.10, embedded Node identity v24.3.0,
and external prepared Node v24.13.0. Its recorded locale was LC_ALL=C.UTF-8.
Its original 11/20 fixture failure was traced to missing synthetic Bun lockfile
signals, then resolved by the independently reviewed M3c marker. Twenty tests
and 108 assertions passed; native status and generation produced thirty fixed
0.2.0 versions, nineteen public, and the consumed gate reproduced public
manifests/changelogs. Source and release-lane bytes stayed unchanged.

The main worktree separately repeated frozen installation, twenty tests, the
native plan, and actual-artifact assertions on Bun 1.3.10 with LC_ALL=C. Root
application declarations and configuration semantics remain identical; only
the development CLI pin and matching schema URL change. The named lockfile
resolution diff is retained in tooling-lock-resolver-diff.json.txt. Private
testkits in development dependencies are not publication edges; the required
runtime/optional/peer closure passes.

The old CLI 2.31.0 native1.0.0 result under KRT-BN004 is historical blocker
evidence. This upgrade resolves it without changing tilde peers or lockstep
policy. The coupled stack pin is committed separately as SP2.
