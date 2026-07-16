// Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// operationHandler runs one conformance-plan operation against the Go
// kernel and returns its OperationOutcome. Every promoted operation this
// adapter's capability set covers has an entry below; operations outside
// that set still fall through to adapter_operation_not_implemented.
type operationHandler func(input json.RawMessage) operationOutcome

// operationHandlers is the seam later milestones extend with per-operation
// entries keyed by promoted conformance-plan operation name, mirroring the
// match arms in rust/kernel-conformance-adapter/src/main.rs's
// dispatch_operation. Only operation literals belong in this routing
// table (see tools/scripts/authority-guardrails/authority-guardrails.ts).
var operationHandlers = map[string]operationHandler{
	"kernel.protocol.deterministic-hashing": runDeterministicHashing,
	"kernel.protocol.schema-roundtrip":      runSchemaRoundtrip,
	"kernel.protocol.modify-composition":    runModifyComposition,
	"kernel.protocol.canonical-rejection":   runCanonicalRejection,
	"kernel.protocol.edge-validation":       runProtocolEdgeValidation,
	"kernel.logical.diff-paths":             runLogicalDiffPaths,
	"kernel.logical.branch-list":            runLogicalBranchList,
	"kernel.logical.recovery-state":         runLogicalRecoveryState,
	"kernel.logical.thread-list":            runLogicalThreadList,
	"kernel.lineage.cross-thread-rejection": runLineageCrossThreadRejection,

	"kernel.run-liveness.lease-renewal":                 runLeaseRenewal,
	"kernel.run-liveness.expired-listing":               runExpiredListing,
	"kernel.run-liveness.stale-preemption":              runStalePreemption,
	"kernel.restart-recovery.crash-recovery-in-process": runCrashRecoveryInProcess,
	"kernel.restart-recovery.concurrent-writer":         runConcurrentWriter,

	"kernel.scope-isolation.cross-scope-probe": runCrossScopeProbe,
	"kernel.reclamation.reclaim-probe":         runReclaimProbe,
	"kernel.reclamation.erasure-probe":         runErasureProbe,
}

// capabilities lists the capability tags this adapter reports during
// initialize. It must byte-match adapter.json's "capabilities" array (see
// tools/conformance/harness/run.ts's validateAdapterHandshake).
func capabilities() []string {
	return []string{
		"kernel.protocol",
		"kernel.edge-validation",
		"kernel.logical",
		"kernel-protocol.thread.enumeration",
		"kernel.run-liveness",
		"kernel.restart-recovery",
		"kernel.scope-isolation",
		"kernel.reclamation",
	}
}

// dispatchOperation runs the named operation's handler, or reports
// adapter_operation_not_implemented when no handler is registered yet. It
// recovers any panic raised while running the handler and reports it as a
// normal error-kind OperationOutcome instead of letting it propagate and
// crash the adapter process: adversarial dispatch input (deeply recursive
// fixtures, unexpected shapes) must degrade into a protocol-visible error,
// not a process exit that takes down the rest of the conformance run.
// Diagnostics for a recovered panic go to stderr only; stdout stays
// frames-only per the adapter protocol.
func dispatchOperation(operation string, input json.RawMessage) (outcome operationOutcome) {
	handler, ok := operationHandlers[operation]
	if !ok {
		return operationOutcome{
			Kind: "error",
			Error: &adapterErrorEnvelope{
				Code:    "adapter_operation_not_implemented",
				Message: fmt.Sprintf("operation not implemented: %s", operation),
			},
		}
	}

	defer func() {
		if recovered := recover(); recovered != nil {
			fmt.Fprintf(os.Stderr, "kernel-conformance-adapter: recovered panic dispatching %s: %v\n", operation, recovered)
			outcome = operationOutcome{
				Kind: "error",
				Error: &adapterErrorEnvelope{
					Code:    "adapter_operation_panicked",
					Message: fmt.Sprintf("operation %s panicked: %v", operation, recovered),
				},
			}
		}
	}()

	return handler(input)
}
