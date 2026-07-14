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

// biome-ignore-all lint/performance/noBarrelFile: This package entrypoint is the intentional public implementation surface.

/**
 * `@tuvren/provider-bridge-ai-sdk` — the Vercel AI SDK provider bridge.
 *
 * The host-facing leaf adapter that turns any AI SDK `LanguageModelV3` (or a
 * `ProviderV3` registry plus model id) into a `TuvrenProvider`. It implements
 * the framework's baseline adapter strategy
 * (KrakenFrameworkSpecification §3.4; ADR-055): prompt/response mapping,
 * canonical `ProviderStreamChunk` streaming (§3.2), structured-output
 * validation (§3.5), and provider-native / provider-mediated tool
 * declaration mapping. The mapped semantics are governed by the providers
 * authority packet (spec/providers/authority-packet.json) and its
 * conformance plans.
 *
 * Entry points: {@link createAiSdkProviderBridge} binds a constructed model;
 * {@link createAiSdkProviderBridgeFromProvider} resolves the model from an
 * AI SDK provider registry.
 *
 * @packageDocumentation
 */

export type {
  AiSdkProviderBridgeFromProviderOptions,
  AiSdkProviderBridgeOptions,
} from "./lib/ai-sdk-provider-bridge.js";
export {
  createAiSdkProviderBridge,
  createAiSdkProviderBridgeFromProvider,
} from "./lib/ai-sdk-provider-bridge.js";
