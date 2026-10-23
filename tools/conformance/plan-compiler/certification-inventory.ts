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

import {
  assessConformancePlans,
  collectEnforcedViolations,
  formatCertificationInventory,
  loadCertificationAuthority,
} from "./certification-assessment.js";
import { findConformancePlans } from "./index.js";

const USAGE =
  "usage: bun tools/conformance/plan-compiler/certification-inventory.ts [--violations]";

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--violations");

if (unknown.length > 0) {
  console.error(`unknown argument ${unknown.join(" ")}\n${USAGE}`);
  process.exit(2);
}

const assessments = await assessConformancePlans(
  await findConformancePlans(),
  await loadCertificationAuthority()
);

console.log(
  formatCertificationInventory(assessments, {
    violations: args.includes("--violations"),
  })
);

if (collectEnforcedViolations(assessments).length > 0) {
  process.exitCode = 1;
}
