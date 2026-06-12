### ADR-005 The Baseline Provider Strategy Is Tuvren Provider Contract Plus AI SDK Providers Bridge

- **Status:** accepted
- **Context:** The framework owns the canonical provider contract. Supporting multiple bridge ecosystems before the core runtime is proven would add translation surface and semantic drift for little value.
- **Decision:** The baseline provider integration package is `@tuvren/provider-bridge-ai-sdk`, built on `ai@6.0.142` and `@ai-sdk/provider@3.0.8`. The baseline bridge adapts `LanguageModelV3` and `ProviderV3` only. `LanguageModelV2` compatibility, AI SDK agent loops, AI SDK UI message protocols, LangChain bridges, and first-class Tuvren-scoped provider packages are deferred.
- **Consequences:** The initial provider surface stays narrow and Tuvren-scoped while preserving Kraken engine semantics internally. The bridge treats AI SDK as a provider/model source, not as the runtime loop, tool governance layer, host protocol, durable state owner, or long-term semantic oracle. Future packages such as `@tuvren/provider-openai`, `@tuvren/provider-anthropic`, and `@tuvren/provider-google` can be added later without redefining the framework contract, and future Rust connectors must satisfy the same Tuvren-owned provider semantics without inheriting AI SDK-specific shapes.

