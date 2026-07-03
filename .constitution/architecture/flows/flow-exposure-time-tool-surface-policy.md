### 4.14 Exposure-Time Tool-Surface Planning and Policy

- **Maps to PRD capability:** CAP-P0-056, CAP-P0-059, CAP-P0-060

```mermaid
sequenceDiagram
  participant Runner as Runner Runtime
  participant Reg as Capability Registry
  participant Src as Tool Source Containers
  participant Prov as Provider Gateway
  participant Pol as Capability Policy Engine
  Runner->>Reg: Request eligible tool surfaces for the active segment (provider, model)
  Src-->>Reg: Contribute capabilities + tool surfaces (built-in, MCP-advertised)
  Prov-->>Reg: Declare provider-native and provider-mediated capabilities
  Reg->>Pol: Candidate tool surfaces for exposure-time evaluation
  Pol-->>Reg: Exposure decisions (provider/model compat, permissions, residency, endpoint availability)
  Reg-->>Runner: Exposed tool surfaces (capability kept distinct from surface)
  Note over Runner,Pol: Withheld surfaces are never rendered to the model; the model sees only policy-approved surfaces
```

