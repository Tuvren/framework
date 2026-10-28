# KRT-DF001 triage

Adapted from the prior DF001–DF002 triage for the state at commit 44e9481.

The resource manager provisions independent SQLite directories and PostgreSQL databases. It preserves SQLite sidecars until cleanup, and removes resources after both successful and failed checks. The supervised adapter ownership probe observes no additional directory or database after provisioning. Legacy reclamation scenarios that independently initialize kernels use distinct logical scopes within the check resource.

PostgreSQL requires an already running service and permission to create and drop the per-check databases. The harness does not start or stop that service. The focused tests and kernel verification passed with the existing service.
