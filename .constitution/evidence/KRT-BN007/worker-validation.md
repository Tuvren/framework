# KRT-BN007 validation

The following commands ran from `/home/oscar/GitHub/Tuvren/framework-bn`.

## Failing-first contract probe

```sh
PATH="$PWD/.devenv/profile/bin:$PATH" bun /tmp/KRT-BN007/contract-probe.ts
```

Exit status: `1` before the documentation change. The probe reported the missing
README order, positioning, language, authority-link, session-package, backend,
and 0.x policy requirements.

## Final contract probe

```sh
PATH="$PWD/.devenv/profile/bin:$PATH" bun /tmp/KRT-BN007/contract-probe.ts
```

Exit status: `0`.

```text
KRT-BN007 contract probe: contract probe passed
```

## Probe type check

```sh
PATH="$PWD/.devenv/profile/bin:$PATH" bunx tsc --ignoreConfig --noEmit --target esnext --module esnext --moduleResolution bundler --types bun --strict --skipLibCheck --noUncheckedIndexedAccess --allowImportingTsExtensions /tmp/KRT-BN007/contract-probe.ts
```

Exit status: `0`.

## Published consumer verification

```sh
PATH="$PWD/.devenv/profile/bin:$PATH" bun tools/scripts/publish-registry.ts --verify-consumer 0.1.0
```

Exit status: `0`.

```text
bun install v1.3.10 (30e609e0)
20 packages installed [391.00ms]
first turn completed with 2 durable message(s)
[publish-registry] consumer verification passed: fresh install of 0.1.0 completed a first Turn via createTuvren from @tuvren/sdk
```

## Documentation authority gate

```sh
PATH="$PWD/.devenv/profile/bin:$PATH" bun run docs:authority-freeze:check
```

Exit status: `0`.

```text
docs authority freeze gate verified 264 classified claims
```

## Workspace gate

```sh
devenv shell -- zsh -c 'bun run check'
```

Exit status: `1`. All named authority and affected-target steps completed, but
the worktree-purity guard rejected concurrent modifications to the unrelated
BN006 evidence files:

```text
verification phase "affected typecheck/test/lint (base master)" mutated the worktree while running a read-only verification step.
Changed files:
- M  .constitution/evidence/KRT-BN006/biome-dependabot.log
- M  .constitution/evidence/KRT-BN006/command.txt
- M  .constitution/evidence/KRT-BN006/manifest.yaml
```
