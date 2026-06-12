### ADR-020 TypeScript Must Adopt the Final Artifact and Conformance Structure First

- **Status:** accepted
- **Context:** The current repository still contains TypeScript-first structural shortcuts such as testkit packages standing in for a future language-neutral conformance system.
- **Decision:** Where the transition defines a stable language-neutral pattern, TypeScript adopts it first. Boundary-owned conformance assets, interop definitions, target naming, and compatibility reporting must normalize the TypeScript line before later implementations inherit the structure.
- **Consequences:** Later languages inherit a real system instead of a special case. Transition work may relocate or split current TypeScript-only helpers, but it must do so without weakening the existing TypeScript delivery path.

