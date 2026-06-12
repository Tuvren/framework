### ADR-014 The Framework Is Driver-Oriented and ReAct Is the Initial Driver

- **Status:** accepted
- **Context:** The architecture now distinguishes shared framework services from concrete execution models. The current behavioral specification is strongly ReAct-shaped, but the product must support future workflow-oriented drivers over the same durable runtime foundation.
- **Decision:** Implement the framework as shared contracts plus shared runtime services, with concrete drivers as explicit implementation packages. The first driver is the ReAct Driver.
- **Consequences:** Package structure, task planning, and future implementation sequencing must separate shared framework logic from driver-specific logic. Future drivers can be added without redefining the kernel, host API, or provider-neutral content model.

