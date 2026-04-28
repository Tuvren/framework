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

import type { InputSignal, TuvrenToolDefinition } from "@tuvren/runtime-api";

export function createPlaygroundTools(): TuvrenToolDefinition[] {
  return [
    {
      description: "Search deterministic playground documents",
      execute(input) {
        const query =
          typeof input === "object" &&
          input !== null &&
          "query" in input &&
          typeof input.query === "string"
            ? input.query
            : "unknown";
        return {
          hits: [
            {
              title: "Tuvren Runtime",
              url: "https://example.invalid/tuvren",
            },
          ],
          query,
        };
      },
      inputSchema: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      name: "search",
    },
    {
      approval: true,
      description: "Send a deterministic playground email",
      execute(input) {
        const to =
          typeof input === "object" &&
          input !== null &&
          "to" in input &&
          typeof input.to === "string"
            ? input.to
            : "unknown@example.invalid";
        return {
          sent: true,
          to,
        };
      },
      inputSchema: {
        properties: {
          subject: { type: "string" },
          to: { type: "string" },
        },
        required: ["to", "subject"],
        type: "object",
      },
      name: "email",
    },
  ];
}

export function textSignal(text: string): InputSignal {
  return {
    parts: [
      {
        text,
        type: "text",
      },
    ],
  };
}
