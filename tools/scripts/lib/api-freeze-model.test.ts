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

// KRT-BL002: unit coverage for the ADR-056 diff table beyond the four
// acceptance fixtures the gate self-tests on every run.

import { describe, expect, test } from "bun:test";
import {
  type ApiSurface,
  classifySurfaceDiff,
  type ExportRecord,
  runDiffTableSelfTest,
} from "./api-freeze-model.js";

const ENTRY = "@tuvren/fixture";

function surface(records: Record<string, Partial<ExportRecord>>): ApiSurface {
  return {
    [ENTRY]: Object.fromEntries(
      Object.entries(records).map(([name, record]) => [
        name,
        {
          kind: "type",
          signature: `interface ${name} {}`,
          stability: "stable",
          ...record,
        } satisfies ExportRecord,
      ])
    ),
  };
}

describe("classifySurfaceDiff (ADR-056 diff table)", () => {
  test("identical surfaces produce no drift", () => {
    const diff = classifySurfaceDiff(
      surface({ A: {} }),
      surface({ A: {} }),
      []
    );
    expect(diff.hasDrift).toBe(false);
    expect(diff.impliedBump).toBe("none");
  });

  test("losing @experimental graduates the export as semver-minor", () => {
    const diff = classifySurfaceDiff(
      surface({ A: { stability: "experimental" } }),
      surface({ A: {} }),
      []
    );
    expect(diff.blocked).toHaveLength(0);
    expect(diff.allowed[0]?.class).toBe("experimental-tag-removed");
    expect(diff.impliedBump).toBe("minor");
  });

  test("graduation with a simultaneous signature change stays allowed", () => {
    const diff = classifySurfaceDiff(
      surface({ A: { stability: "experimental" } }),
      surface({ A: { signature: "interface A { widened: true }" } }),
      []
    );
    expect(diff.blocked).toHaveLength(0);
    expect(diff.allowed[0]?.class).toBe("experimental-tag-removed");
  });

  test("gaining @experimental on a stable export blocks", () => {
    const diff = classifySurfaceDiff(
      surface({ A: {} }),
      surface({ A: { stability: "experimental" } }),
      []
    );
    expect(diff.blocked[0]?.class).toBe("experimental-tag-gained");
    expect(diff.impliedBump).toBe("major");
  });

  test("stable signature change blocks; experimental does not", () => {
    const stable = classifySurfaceDiff(
      surface({ A: {} }),
      surface({ A: { signature: "interface A { broken: true }" } }),
      []
    );
    expect(stable.blocked[0]?.class).toBe("stable-signature-changed");

    const experimental = classifySurfaceDiff(
      surface({ A: { stability: "experimental" } }),
      surface({
        A: {
          signature: "interface A { churn: true }",
          stability: "experimental",
        },
      }),
      []
    );
    expect(experimental.blocked).toHaveLength(0);
    expect(experimental.allowed[0]?.class).toBe(
      "experimental-signature-changed"
    );
    expect(experimental.impliedBump).toBe("experimental-only");
  });

  test("kind flip (type-only to value) counts as a signature change", () => {
    const diff = classifySurfaceDiff(
      surface({ A: { kind: "type" } }),
      surface({ A: { kind: "value" } }),
      []
    );
    expect(diff.blocked[0]?.class).toBe("stable-signature-changed");
  });

  test("removing a stable export blocks; removing an experimental one is recorded", () => {
    const stableRemoval = classifySurfaceDiff(
      surface({ A: {} }),
      { [ENTRY]: {} },
      []
    );
    expect(stableRemoval.blocked[0]?.class).toBe("stable-export-removed");

    const experimentalRemoval = classifySurfaceDiff(
      surface({ A: { stability: "experimental" } }),
      { [ENTRY]: {} },
      []
    );
    expect(experimentalRemoval.blocked).toHaveLength(0);
    expect(experimentalRemoval.allowed[0]?.class).toBe(
      "experimental-export-removed"
    );
    expect(experimentalRemoval.impliedBump).toBe("minor");
  });

  test("adding an export is additive semver-minor", () => {
    const diff = classifySurfaceDiff({ [ENTRY]: {} }, surface({ A: {} }), []);
    expect(diff.blocked).toHaveLength(0);
    expect(diff.allowed[0]?.class).toBe("export-added");
    expect(diff.impliedBump).toBe("minor");
  });

  test("consistency floor flags untagged exports under a wholly-experimental subpath", () => {
    const live = surface({
      Tagged: { stability: "experimental" },
      Untagged: {},
    });
    const diff = classifySurfaceDiff(live, live, [ENTRY]);
    expect(diff.floorViolations).toEqual([
      { entrypoint: ENTRY, exportName: "Untagged" },
    ]);
  });

  test("floor is evaluated on the live surface even with zero drift", () => {
    const live = surface({ Untagged: {} });
    const diff = classifySurfaceDiff(live, live, [ENTRY]);
    expect(diff.hasDrift).toBe(false);
    expect(diff.floorViolations).toHaveLength(1);
  });

  test("a new entrypoint's exports are all additive", () => {
    const diff = classifySurfaceDiff({}, surface({ A: {}, B: {} }), []);
    expect(diff.blocked).toHaveLength(0);
    expect(diff.allowed).toHaveLength(2);
  });
});

describe("runDiffTableSelfTest", () => {
  test("the built-in acceptance fixtures pass", () => {
    expect(runDiffTableSelfTest()).toEqual([]);
  });
});
