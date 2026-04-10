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

import type {
  AgentConfig,
  ApprovalResponse,
  EpochMs,
  HashString,
  InputSignal,
  KrakenStreamEvent,
  RuntimeResolution,
  ToolRegistry,
} from "@kraken/framework-runtime-api";
import { KrakenValidationError } from "@kraken/framework-runtime-api";

export interface DriverRuntimePort {
  emit(event: KrakenStreamEvent): Promise<void> | void;
  now(): EpochMs;
}

export interface DriverExecutionContext {
  branchId: string;
  config: AgentConfig;
  runtime: DriverRuntimePort;
  schemaId: string;
  steering?: AsyncIterable<InputSignal>;
  toolRegistry: ToolRegistry;
  turnId: string;
}

export interface DriverResumeContext extends DriverExecutionContext {
  approval: ApprovalResponse;
  resumedFrom?: HashString;
}

export interface DriverExecutionResult {
  activeAgent: string;
  resolution: RuntimeResolution;
}

export interface KrakenDriver {
  execute(context: DriverExecutionContext): Promise<DriverExecutionResult>;
  readonly id: string;
  resume(context: DriverResumeContext): Promise<DriverExecutionResult>;
}

export interface KrakenDriverFactory {
  create(): KrakenDriver;
  readonly id: string;
}

export interface DriverRegistry {
  list(): Array<KrakenDriver | KrakenDriverFactory>;
  register(driver: KrakenDriver | KrakenDriverFactory): void;
  resolve(driverId: string): KrakenDriver | KrakenDriverFactory | undefined;
}

export function isKrakenDriver(value: unknown): value is KrakenDriver {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    "execute" in value &&
    typeof value.execute === "function" &&
    "resume" in value &&
    typeof value.resume === "function"
  );
}

export function assertKrakenDriver(
  value: unknown,
  label = "value"
): asserts value is KrakenDriver {
  if (!isKrakenDriver(value)) {
    throw new KrakenValidationError(`${label} must be a valid KrakenDriver`, {
      code: "invalid_driver_contract",
      details: value,
    });
  }
}
