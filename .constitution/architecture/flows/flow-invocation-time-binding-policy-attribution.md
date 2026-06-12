### 4.15 Invocation-Time Binding, Policy, and Provider-Native Attribution

- **Maps to PRD capability:** CAP-P0-057, CAP-P0-058, CAP-P0-061, CAP-P1-062

```mermaid
sequenceDiagram
  participant Model as Model (via Provider Gateway)
  participant Driver as Driver Runtime
  participant Resolver as Binding & Endpoint Resolver
  participant Pol as Capability Policy Engine
  participant Server as Tool Execution Gateway (Tuvren-server)
  participant Prov as Provider Gateway (provider-native/mediated)
  participant Events as Event Stream / Telemetry
  Model-->>Driver: Model-visible tool call against an exposed surface
  Driver->>Resolver: Resolve capability to execution class + endpoint
  Resolver->>Pol: Invocation-time policy (approval, credential boundary, idempotency, risk)
  Pol-->>Resolver: Admit or deny
  alt Tuvren-server binding
    Resolver->>Server: Dispatch; full lifecycle owned by Tuvren
    Server-->>Events: Tuvren-owned invocation events (full lifecycle)
  else Provider-native or provider-mediated binding
    Resolver->>Prov: Enable/configure; provider owns execution
    Prov-->>Events: Provider-attributed events from provider-exposed results only
  end
  Note over Resolver,Events: Every model-visible call resolves to a policy-checked capability invocation against a known execution class
```

