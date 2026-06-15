# @tuvren/provider-bridge-ai-sdk

Bridges a [Vercel AI SDK](https://sdk.vercel.ai) `LanguageModelV3` into a Tuvren
`TuvrenProvider`, so the runtime's driver can call any AI-SDK-backed model
through the neutral provider contract (`generate` / `stream`).

## Secret Isolation — Edge Confinement (ADR-044)

Provider credentials are **confined to the integration edge**. They are accepted
only by the provider bridge (and the underlying AI SDK model) at request time and
never propagate onto any observable, persisted, or replayable runtime surface.

Credentials accepted at this edge:

- the API key baked into the AI SDK provider/model instance you pass to the
  bridge (e.g. via the provider's own constructor or environment), and
- any secret-bearing `defaultHeaders` supplied to the bridge.

These values authenticate the model request and nothing else. They are **never**:

- written to kernel records or any durable state,
- placed on canonical stream events,
- placed on `TelemetrySpan` / `TelemetryEvent` attributes, or
- serialized into REPL transcripts.

Provider continuity artifacts (ADR-005; opaque continuation tokens) are non-secret
by contract and must not carry credential material. The Kernel Boundary, Durable
State Boundary, Telemetry & Observability Boundary, canonical event stream, and
transcript surfaces are credential-free zones.

This guarantee is verified — not assumed. The `secret-isolation` conformance
check set (KRT-BD004) configures a representative provider key, runs a turn, and
uses a shared runner-owned secret-absence helper to recursively scan the
persisted records, stream events, telemetry, and transcript for that secret and
its common encoded variants.

## Usage

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { createAiSdkProviderBridge } from "@tuvren/provider-bridge-ai-sdk";

// The API key lives in the AI SDK provider — the integration edge.
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const provider = createAiSdkProviderBridge({ model: openai("gpt-4o") });

// `provider` is a TuvrenProvider; the key never leaves this edge.
```
