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

/**
 * gRPC (Connect RPC) client binding for the `RuntimeKernel` syscall surface
 * (docs/KrakenKernelSpecification.md §7), for pointing an instance at a
 * remote kernel service instead of an in-process one.
 *
 * Despite its kernel-named package, this is the one such package meant for
 * direct host use: it is the leaf adapter a host installs to reach a remote
 * kernel deployment (see
 * docs/guides/publishing-and-adopter-onboarding.md §4). Every method encodes
 * arguments to protobuf, decodes and validates the response back into
 * `@tuvren/kernel-protocol` types, and normalizes transport failures into
 * `TuvrenRuntimeError`.
 *
 * @packageDocumentation
 */

export type { GrpcRuntimeKernelOptions } from "./lib/grpc-kernel-client.js";
// biome-ignore lint/performance/noBarrelFile: This package entrypoint is the intentional public contract surface.
export { createGrpcRuntimeKernel } from "./lib/grpc-kernel-client.js";
