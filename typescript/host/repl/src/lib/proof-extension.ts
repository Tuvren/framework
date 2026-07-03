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

import type { TuvrenExtension } from "@tuvren/runtime";

export const PROOF_EXTENSION_NAME = "proof-extension";
export const PROOF_EXTENSION_EVENT_NAME = "proof-extension.before_turn";

export function createProofExtension(): TuvrenExtension {
  return {
    beforeTurn(context) {
      context.emit({
        data: {
          iterationCount: context.iterationCount,
          messageCount: context.manifest.messageCount,
        },
        name: PROOF_EXTENSION_EVENT_NAME,
      });
      return {
        state: {
          active: true,
          runId: context.runId,
          turnId: context.turnId,
        },
      };
    },
    name: PROOF_EXTENSION_NAME,
    systemPrompt(context) {
      return context.extensionState.active === true
        ? "Proof extension active."
        : undefined;
    },
  };
}
