# Kernel reordering pilot evidence

M4 removes the validator import cycle before function conversion. The same 23
record exports now come directly from their owning module. Public export
snapshots are byte-identical, validator bodies remain unchanged, and six fresh
processes check valid records, exact error ordering, canonical bytes and hashes.

`M4-source-and-export-proof.json` records the early deletion of the runtime
validator's legacy directive. The compressed Biome reports prove that the exact
retained configuration selected one unsuppressed file in both cases: the old
source fired `noBarrelFile`, while the new source had zero diagnostics. The
original identity and reason remain in the historical M3 ledger.

The compressed export snapshots contain complete names, kinds and function
arities for both public surfaces. The compressed capture driver is a historical
record and contains the original host path. It is not a prescribed command.
`M4-cycle-check.json` records the native check independently of retained Biome.

Run the durable behavior matrix from the repository root:

```sh
bun run nx run kernel-contract-protocol:test
bun run conformance
```

M4 is one phase of BQ003. Later phase evidence retains its own producing commit
and fresh diagnostics; it does not overwrite these recorded results.
