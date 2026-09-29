# BN001 runtime upgrade deferral

The Bun1.4.2 target remains unmet. Both allowed attempts failed outside this ticket's scope. The full Nixpkgs refresh introduced a Weaver registry validation incompatibility. The Bun-only candidate retained the old general lock and PostgreSQL17.9, but failed three backend-memory tests; the same checkout and dependencies passed all 77 tests using Bun1.3.10.

The candidates were reverted. The retained change explicitly selects PostgreSQL17. Independent full verification and the streaming host recipe pass with the retained Bun1.3.10/PostgreSQL17.9 environment; packageManager remains its baseline bun@1.3.11 declaration. This evidence supports the safe partial guard and deferral, not successful Bun1.4.2 acceptance.

Transcripts are historical and label their tool versions, producing commands, and exit codes. Parsed excerpts remove terminal color codes and trailing whitespace; failing and control tests use the same implementation and dependency resolution. No debug tags or product-source fixes were introduced.
