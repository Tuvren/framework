#!/usr/bin/env bash
#
# Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Idempotent session bootstrap for devenv-managed services (PostgreSQL, ...).
#
# `devenv up -d` is NOT idempotent: a second invocation exits non-zero with
# "Processes already running". That makes the documented "run once at session
# start" step a footgun when a developer re-runs it. This wrapper swallows the
# already-running case so the command is safe to call repeatedly.
#
# This is a manual, top-level convenience only. Do NOT embed it inside Nx
# targets, certification projects, or the verify lanes — those still assume the
# caller has already started services once, per the repository guidelines.

set -euo pipefail

if ! command -v devenv >/dev/null 2>&1; then
  echo "services:up: 'devenv' not found on PATH. Load the repo environment first (direnv/.envrc)." >&2
  exit 1
fi

# Bounded readiness wait: `devenv up -d` returns before PostgreSQL accepts
# connections, so a kernel verify lane launched immediately afterwards could
# race the database's startup. Poll until ready (or time out loudly) so this
# script does not report success until the database actually is. This stays
# inside the manual convenience script — never embed it in Nx targets or
# runner commands (see header).
wait_for_postgres() {
  if ! command -v pg_isready >/dev/null 2>&1; then
    echo "services:up: 'pg_isready' not found on PATH; skipping the readiness wait." >&2
    return 0
  fi

  for _ in $(seq 1 30); do
    if pg_isready >/dev/null 2>&1; then
      echo "services:up: PostgreSQL is accepting connections."
      return 0
    fi
    sleep 1
  done

  echo "services:up: PostgreSQL did not become ready within 30s; check 'devenv processes' logs." >&2
  return 1
}

if output="$(devenv up -d 2>&1)"; then
  [ -n "${output}" ] && echo "${output}"
  echo "services:up: devenv-managed services started."
  wait_for_postgres
  exit $?
fi

# Idempotency hinges on devenv's human-readable "already running" message. That
# string is an upstream UX detail that could be reworded across devenv CLI
# versions. Nothing in this repo pins the CLI for local dev (`devenv.lock`
# pins the project's inputs, not the devenv binary on PATH; CI pins its own
# install in ci.yml) — so if a devenv upgrade rewords the message, this
# branch stops matching and re-runs revert to a hard failure (the footgun
# this wrapper removes). Update the regex if that happens.
if echo "${output}" | grep -qiE "already running"; then
  echo "services:up: devenv-managed services already running (no-op)."
  wait_for_postgres
  exit $?
fi

echo "${output}" >&2
echo "services:up: 'devenv up -d' failed (see output above)." >&2
echo "services:up: if a stale daemon is blocking startup, run 'bun run services:down' and retry." >&2
exit 1
