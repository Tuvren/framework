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
  DEFAULT_GEMINI_PLAYGROUND_SCENARIOS,
  loadPlaygroundConfig,
  runPlaygroundScenarioMatrix,
} from "./index.js";

const config = loadPlaygroundConfig(process.env, process.argv.slice(2));
const report = await runPlaygroundScenarioMatrix({
  // Forward the parsed config wholesale so new private config fields such as
  // resolved credentials cannot drift out of the Gemini matrix path.
  config,
  scenarios: DEFAULT_GEMINI_PLAYGROUND_SCENARIOS,
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (!report.summary.allChecksPassed) {
  process.exitCode = 1;
}
