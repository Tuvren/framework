/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Shared between the authority-guardrails freshness gate and the
// authority-packet validator: a manifest-owned `regenerateCommand` string is
// untrusted input reachable by any pull request that edits a checked-in JSON
// authority packet. Both call sites must reject the same shell metacharacters
// and enforce the same allowlisted command-prefix set so a manifest cannot
// pass validation with a command shape that the guardrail gate would then
// refuse to execute (or, worse, execute unsafely).

const SHELL_METACHARACTER_PATTERN = /[|&;`$<>()]/u;
const WHITESPACE_PATTERN = /\s+/u;

// Ecosystem CLIs this repository already treats as trusted, native command
// authority (see repo CLAUDE.md "Tooling"). A manifest "regenerateCommand"
// must start with one of these. Only "bun" is used by any authority packet
// today; "bunx", "cargo", and "buf" are pre-authorized ahead of use so a
// future manifest adopting one of them does not need a second hardening
// ticket.
export const REGENERATE_COMMAND_ALLOWLIST: readonly string[] = [
  "bun",
  "bunx",
  "cargo",
  "buf",
];

/**
 * Parses a manifest-owned `regenerateCommand` string into an argv array
 * suitable for `spawn(argv[0], argv.slice(1), { shell: false })`.
 *
 * Throws instead of silently mis-splitting or falling back to shell
 * execution: fails loud when the command contains a shell metacharacter,
 * is empty, or does not start with an allowlisted command prefix.
 */
export function parseRegenerateCommandArgv(command: string): string[] {
  if (SHELL_METACHARACTER_PATTERN.test(command)) {
    throw new Error(
      `regenerateCommand "${command}" contains a shell metacharacter (one of | & ; \` $ < > ( )); ` +
        "declare a plain space-separated argv command instead"
    );
  }

  const argv = command
    .trim()
    .split(WHITESPACE_PATTERN)
    .filter((token) => token.length > 0);
  const executable = argv[0];

  if (executable === undefined) {
    throw new Error("regenerateCommand must not be empty");
  }

  if (!REGENERATE_COMMAND_ALLOWLIST.includes(executable)) {
    throw new Error(
      `regenerateCommand "${command}" starts with "${executable}", which is not in the ` +
        `allowlisted command-prefix set (${REGENERATE_COMMAND_ALLOWLIST.join(", ")})`
    );
  }

  return argv;
}
