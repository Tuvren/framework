# @tuvren/stream-ws

Tuvren WebSocket stream adapter leaf: carries the duplex session protocol (ADR-060) and the event-stream resume cursor (ADR-061) over a runtime-agnostic WebSocket transport, per ADR-062.

Install alongside [`@tuvren/core`](https://www.npmjs.com/package/@tuvren/core) and [`@tuvren/sdk`](https://www.npmjs.com/package/@tuvren/sdk); this package peer-depends on a single shared `@tuvren/core` instance (ADR-037).

See the [Tuvren framework repository](https://github.com/Tuvren/framework) for documentation and adopter onboarding.
