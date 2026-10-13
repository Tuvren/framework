Historical source snapshot: `d04b04d172007604c930aa38ccde7acee1145fa6`. The current PR has two later comment/test corrections; use [the review overlay](pr-review-round1/REPLAY.md) for current-source replay. This M10 archive and its fingerprints remain unchanged.

# M10 evidence replay

Measurement base is cd1f44d94e48b963eb48de159484d6de548c96e3; this bundle measures an uncommitted working candidate. Final52-file fingerprints cover complete fresh Git inventories of all five owned roots plus bs.json. M8=55907cfb80861d68b5a95db537057e811c9065b9 and M9=cd1f44d94e48b963eb48de159484d6de548c96e3 are historical measurements. Their source regions remain byte-identical at M10; historical reports are not relabeled as new runs.

Run from the candidate repository root. Set `TUVREN_ENV_ROOT` to the checkout supplying the loaded direnv environment, `TUVREN_VERIFY_LOCK` to the team's shared runtime lock, `REPORT_ROOT` to the extracted bundle, and `REPLAY_OUT` to a new directory outside the repository. These are host-local values; none is a prescribed machine path. Services must already be running under repository session rules.

```zsh
mkdir -p "$REPLAY_OUT"
direnv exec "$TUVREN_ENV_ROOT" flock "$TUVREN_VERIFY_LOCK" bun "$REPORT_ROOT/admission-proof.mjs" "$REPLAY_OUT/admission"
direnv exec "$TUVREN_ENV_ROOT" flock "$TUVREN_VERIFY_LOCK" bun "$REPORT_ROOT/program.mjs" "$REPLAY_OUT/program.json"
direnv exec "$TUVREN_ENV_ROOT" flock "$TUVREN_VERIFY_LOCK" env NX_DAEMON=false bun "$REPORT_ROOT/hash.mjs" "$REPLAY_OUT/hash.json"
direnv exec "$TUVREN_ENV_ROOT" bun "$REPORT_ROOT/replay.mjs" "$REPORT_ROOT" "$REPLAY_OUT"
```

Admission replay uses actual Oxlint `--debug=files` and uncached native JSON Git inventories for every live native project. It retains raw per-file owners, asserts exactly one owner without deduplicating the ownership proof, rejects overlapping roots, compares complete nonempty code/JSON selections, proves formatter ignores cannot hide source-integrity files, freshly checks every JSON-only project for code, verifies all five canonical commands and inherited checker inputs, compares every effective shipped policy field, and reconciles both original directive identities/reasons against their actual atomic M8/M9 commits. It also proves all other coverage files and M8/M9 source regions are byte-identical. `replay.mjs` verifies the archived52-file fingerprints and every actual159-source dependency/helper/config/lock input in the installed Nx hasher output, with no source mutation.

The original pre-freeze cache mutation proof lives in cache-mutation.json and hash-before/hash-mutated/hash-restored.json. Only an owned certification source received a temporary comment; exact original bytes and hash were restored before broad verification. No dependency/helper source was mutated. Actual typecheck program includes one required TRACKED generated semconv source; it contains no ignored generated or dist imports. Existing gRPC generated-output prerequisite/hash and testkit input metadata remain unchanged.

Original/current behavior21-case results live in behavior-proof.json. Six malformed manifest-field cases now use TypeError under A11; first message/order and valid results match, and all existing certification assertions remain byte-identical. No M10 async/cause/API/protocol normalization occurred. Preliminary unsuccessful probes are distinguished from gate failures in failure-provenance.json; all13required gates passed without retry.

Read final/results.json for exact commands/statuses, final/12-full-verify.log for complete serial full verification, and final/tree-before.json plus final/tree-after.json for the frozen2313tracked/index/new-file state. All13required commands are listed in summary.json. Full verify used VERIFY_SERIAL=1 with unchanged coverage/timeouts. Check, kernel verify, and full verify retained the shared lock through `git fetch origin master`; each gate and fetch status is preserved separately.

For independent broad replay, freeze all tracked/index/new-file bytes and execute the13commands under the shared lock. For commands that may run breaking/interop, use this host-neutral wrapper and retain both statuses:

```zsh
direnv exec "$TUVREN_ENV_ROOT" flock "$TUVREN_VERIFY_LOCK" zsh -c '
  cd "$1" || exit
  if [[ "$2" == verify ]]; then
    VERIFY_SERIAL=1 bun run "$2"
  else
    bun run "$2"
  fi
  tuvren_gate_status=$?
  git fetch origin master
  tuvren_fetch_status=$?
  print -r -- "gate=$tuvren_gate_status fetch=$tuvren_fetch_status"
  if (( tuvren_gate_status != 0 )); then exit "$tuvren_gate_status"; fi
  exit "$tuvren_fetch_status"
' -- "$PWD" verify
```

Substitute check or verify:kernel as relevant; canonical native commands have exact project-root operands/options as summary.json records. Never use Bun --cwd, a nested lock, service startup from a runner, an obsolete empty-helper Git fallback, modified timeouts, checker overrides, or a skipped control. Independent lead replay occurs after constitution evidence assembly; this worker does not claim the epic or final CI complete.

The archive contains the complete raw command reports, actual inventories, source/hash captures, probes, scripts, logs and final snapshots. digest-index.json indexes every archived member by sha256 and bytes; reports.tar.gz.sha256 pins the compressed archive. Constitution files remain lead-owned.

The independent behavior replay uses the archived exact M9 parent source, even after M10 is committed:

```zsh
direnv exec "$TUVREN_ENV_ROOT" flock "$TUVREN_VERIFY_LOCK" bun "$REPORT_ROOT/behavior-replay.mjs" "$REPORT_ROOT" "$REPLAY_OUT/behavior"
```
