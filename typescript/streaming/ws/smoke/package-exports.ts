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

import { describe, expect, test } from "bun:test";
import {
  WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED,
  WS_CLOSE_CODE_HANDSHAKE_INVALID,
} from "@tuvren/stream-ws";

describe("stream-ws package exports", () => {
  test("export the close-code vocabulary", () => {
    expect(WS_CLOSE_CODE_HANDSHAKE_INVALID).toBe(4000);
    expect(WS_CLOSE_CODE_BACKPRESSURE_EXCEEDED).toBe(4005);
  });
});
