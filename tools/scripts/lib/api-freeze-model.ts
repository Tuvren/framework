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

// KRT-BL002 (ADR-054, ADR-056): the pure API-freeze diff model. This module
// owns the ADR-056 diff table and consistency floor as data-in/data-out logic
// with no compiler or filesystem access, so the classification semantics can
// be unit-tested independently of surface extraction. The CLI entry point
// (tools/scripts/api-freeze-gate.ts) extracts the live surface, feeds it here,
// and acts on the returned findings.

/** Stability classification derived solely from the TSDoc `@experimental` tag (ADR-056). */
export type ExportStability = "experimental" | "stable";

export interface ExportRecord {
  /** "type" for type-only exports, "value" when the export carries a runtime value. */
  kind: "type" | "value";
  /** Normalized declaration text of the resolved (de-aliased) declaration(s). */
  signature: string;
  stability: ExportStability;
}

/** One package entrypoint's surface: export name → record. */
export type EntrypointSurface = Record<string, ExportRecord>;

/** The full audited surface: entrypoint specifier → surface. */
export type ApiSurface = Record<string, EntrypointSurface>;

/**
 * The ADR-056 diff table, one row per changed export:
 *
 *   export gains @experimental (was untagged/stable)  => BLOCKED (removes a stable guarantee)
 *   export loses @experimental (was tagged)           => ALLOWED, recorded as semver-minor
 *   signature change on an @experimental export       => ALLOWED, not gated
 *   signature change on an untagged (stable) export   => BLOCKED unless semver-major
 *
 * plus the addition/removal rows that follow from the same guarantee: adding
 * an export is additive (semver-minor); removing a stable export removes a
 * guarantee (blocked unless semver-major); removing an experimental export is
 * unguarded but still recorded so the snapshot refresh is deliberate.
 */
export type DiffClass =
  | "export-added"
  | "experimental-tag-gained"
  | "experimental-tag-removed"
  | "experimental-signature-changed"
  | "experimental-export-removed"
  | "stable-signature-changed"
  | "stable-export-removed";

export interface DiffFinding {
  class: DiffClass;
  detail: string;
  entrypoint: string;
  exportName: string;
  /** Blocked findings fail the gate unless the run declares semver-major. */
  verdict: "allowed" | "blocked";
}

export interface FloorViolation {
  entrypoint: string;
  exportName: string;
}

export interface SurfaceDiff {
  /** Allowed findings; `semverMinor` marks the subset recorded as semver-minor. */
  allowed: DiffFinding[];
  /** Blocked findings under the ADR-056 table (overridable only by a declared semver-major). */
  blocked: DiffFinding[];
  /**
   * ADR-056 consistency-floor violations: untagged exports under a subpath the
   * authority declares wholly experimental. Never overridable — an untagged
   * export there is a documentation defect, not a silent stable promotion.
   */
  floorViolations: FloorViolation[];
  /** True when any finding exists (the committed snapshot is stale). */
  hasDrift: boolean;
  /** The semver bump class the drift implies once recorded. */
  impliedBump: "experimental-only" | "major" | "minor" | "none";
}

const SEMVER_MINOR_CLASSES: readonly DiffClass[] = [
  "experimental-tag-removed",
  "export-added",
  "experimental-export-removed",
];

/**
 * Classify the drift between the committed snapshot surface and the live
 * surface under the ADR-056 diff table. Pure function: no I/O.
 *
 * `whollyExperimentalEntrypoints` lists the subpaths the authority declares
 * wholly experimental (ADR-056 consistency floor); the floor is evaluated on
 * the live surface regardless of drift.
 */
export function classifySurfaceDiff(
  snapshot: ApiSurface,
  live: ApiSurface,
  whollyExperimentalEntrypoints: readonly string[]
): SurfaceDiff {
  const blocked: DiffFinding[] = [];
  const allowed: DiffFinding[] = [];

  const entrypoints = new Set([...Object.keys(snapshot), ...Object.keys(live)]);

  for (const entrypoint of [...entrypoints].sort()) {
    const before = snapshot[entrypoint] ?? {};
    const after = live[entrypoint] ?? {};
    const names = new Set([...Object.keys(before), ...Object.keys(after)]);

    for (const exportName of [...names].sort()) {
      const finding = classifyExportChange(
        entrypoint,
        exportName,
        before[exportName],
        after[exportName]
      );

      if (finding === undefined) {
        continue;
      }

      if (finding.verdict === "blocked") {
        blocked.push(finding);
      } else {
        allowed.push(finding);
      }
    }
  }

  return {
    allowed,
    blocked,
    floorViolations: collectFloorViolations(
      live,
      whollyExperimentalEntrypoints
    ),
    hasDrift: blocked.length > 0 || allowed.length > 0,
    impliedBump: computeImpliedBump(blocked, allowed),
  };
}

/** ADR-056 consistency floor, evaluated on the live surface regardless of drift. */
function collectFloorViolations(
  live: ApiSurface,
  whollyExperimentalEntrypoints: readonly string[]
): FloorViolation[] {
  const floorViolations: FloorViolation[] = [];

  for (const entrypoint of whollyExperimentalEntrypoints) {
    const surface = live[entrypoint] ?? {};

    for (const exportName of Object.keys(surface).sort()) {
      if (surface[exportName]?.stability === "stable") {
        floorViolations.push({ entrypoint, exportName });
      }
    }
  }

  return floorViolations;
}

/** One export's row in the ADR-056 diff table; undefined means no change. */
function classifyExportChange(
  entrypoint: string,
  exportName: string,
  prev: ExportRecord | undefined,
  next: ExportRecord | undefined
): DiffFinding | undefined {
  if (prev === undefined && next !== undefined) {
    return {
      class: "export-added",
      detail: `new ${next.stability} export (additive, semver-minor)`,
      entrypoint,
      exportName,
      verdict: "allowed",
    };
  }

  if (prev !== undefined && next === undefined) {
    if (prev.stability === "stable") {
      return {
        class: "stable-export-removed",
        detail:
          "removing a stable export removes a semver guarantee (ADR-056); blocked unless the change is declared semver-major",
        entrypoint,
        exportName,
        verdict: "blocked",
      };
    }

    return {
      class: "experimental-export-removed",
      detail:
        "removed an @experimental export (unguarded surface; recorded so the snapshot refresh is deliberate)",
      entrypoint,
      exportName,
      verdict: "allowed",
    };
  }

  if (prev === undefined || next === undefined) {
    return undefined;
  }

  if (prev.stability === "stable" && next.stability === "experimental") {
    return {
      class: "experimental-tag-gained",
      detail:
        "a previously-untagged (stable) export gained @experimental — this removes a stable guarantee (ADR-056); blocked unless declared semver-major",
      entrypoint,
      exportName,
      verdict: "blocked",
    };
  }

  if (prev.stability === "experimental" && next.stability === "stable") {
    // Graduation and a simultaneous signature change are both permitted: the
    // export was unguarded until this run absorbs it as stable.
    return {
      class: "experimental-tag-removed",
      detail:
        "@experimental removed — the export graduates to the stable snapshot (ADR-056 graduation rule); recorded as semver-minor",
      entrypoint,
      exportName,
      verdict: "allowed",
    };
  }

  if (prev.signature === next.signature && prev.kind === next.kind) {
    return undefined;
  }

  if (next.stability === "experimental") {
    return {
      class: "experimental-signature-changed",
      detail:
        "signature change on an @experimental export (ADR-056: not gated)",
      entrypoint,
      exportName,
      verdict: "allowed",
    };
  }

  return {
    class: "stable-signature-changed",
    detail:
      "signature change on an untagged (stable) export (ADR-056); blocked unless the change is declared semver-major",
    entrypoint,
    exportName,
    verdict: "blocked",
  };
}

function computeImpliedBump(
  blocked: DiffFinding[],
  allowed: DiffFinding[]
): SurfaceDiff["impliedBump"] {
  if (blocked.length > 0) {
    return "major";
  }

  if (allowed.some((finding) => SEMVER_MINOR_CLASSES.includes(finding.class))) {
    return "minor";
  }

  return allowed.length > 0 ? "experimental-only" : "none";
}

/**
 * The four KRT-BL002 acceptance scenarios as executable fixtures. The gate CLI
 * runs these on every invocation before touching the real surface, so the
 * ADR-056 table cannot silently regress between snapshot runs. Returns the
 * list of scenario failures (empty means the table behaves as specified).
 */
export function runDiffTableSelfTest(): string[] {
  const failures: string[] = [];
  const entry = "@tuvren/fixture";

  const surface = (record: Partial<ExportRecord>): ApiSurface => ({
    [entry]: {
      Widget: {
        kind: "type",
        signature: "interface Widget { size: number; }",
        stability: "stable",
        ...record,
      },
    },
  });

  // Scenario: removing @experimental is allowed and recorded as semver-minor.
  const graduation = classifySurfaceDiff(
    surface({ stability: "experimental" }),
    surface({ stability: "stable" }),
    []
  );

  if (
    graduation.blocked.length !== 0 ||
    graduation.allowed[0]?.class !== "experimental-tag-removed" ||
    graduation.impliedBump !== "minor"
  ) {
    failures.push(
      "graduation scenario: @experimental removal must be allowed and recorded as semver-minor"
    );
  }

  // Scenario: a stable signature change without a declared semver-major blocks.
  const stableBreak = classifySurfaceDiff(
    surface({}),
    surface({ signature: "interface Widget { size: string; }" }),
    []
  );

  if (
    stableBreak.blocked[0]?.class !== "stable-signature-changed" ||
    stableBreak.impliedBump !== "major"
  ) {
    failures.push(
      "stable-break scenario: an untagged signature change must be blocked"
    );
  }

  // Scenario: a signature change on an @experimental export is not blocked.
  const experimentalChange = classifySurfaceDiff(
    surface({ stability: "experimental" }),
    surface({
      signature: "interface Widget { size: string; }",
      stability: "experimental",
    }),
    []
  );

  if (
    experimentalChange.blocked.length !== 0 ||
    experimentalChange.allowed[0]?.class !== "experimental-signature-changed"
  ) {
    failures.push(
      "experimental-change scenario: an @experimental signature change must not be blocked"
    );
  }

  // Scenario: an untagged export under a wholly-experimental subpath fails the
  // consistency floor.
  const floor = classifySurfaceDiff(surface({}), surface({}), [entry]);

  if (
    floor.floorViolations.length !== 1 ||
    floor.floorViolations[0]?.exportName !== "Widget"
  ) {
    failures.push(
      "consistency-floor scenario: an untagged export under a declared-experimental subpath must violate the floor"
    );
  }

  return failures;
}
