export interface NegativeControlPortConfig {
  activationOperation: string;
  branchAdapters?: readonly string[];
  capabilities?: readonly string[];
  mutants?: readonly string[];
  unsupportedReasons?: Readonly<Record<string, string>>;
  controlAdapter: string;
  mutantAdapter: string;
  mutantEnv: string;
  packet: string;
  port: string;
  profile: string;
}

const kernel = {
  activationOperation: "kernel.mutant.activation",
  mutantEnv: "TUVREN_KERNEL_MUTANT",
  packet: "spec/kernel/authority-packet.json",
  port: "kernel",
};

const durable = (
  backend: "sqlite" | "postgres",
  profile: string
): NegativeControlPortConfig => ({
  ...kernel,
  controlAdapter: `typescript/kernel/conformance-adapter/adapter-${backend}.json`,
  mutantAdapter: `typescript/kernel/conformance-adapter/adapter-${backend}-mutant.json`,
  unsupportedReasons: {},
  profile,
});

export const NEGATIVE_CONTROL_PORTS: readonly NegativeControlPortConfig[] = [
  {
    ...kernel,
    branchAdapters: [
      "typescript/kernel/conformance-adapter/adapter-postgres.json",
    ],
    controlAdapter: "typescript/kernel/conformance-adapter/adapter.json",
    mutantAdapter: "typescript/kernel/conformance-adapter/adapter-mutant.json",
    profile: "kernel.memory",
  },
  {
    ...kernel,
    controlAdapter: "rust/kernel-conformance-adapter/adapter.json",
    mutantAdapter: "rust/kernel-conformance-adapter/adapter-mutant.json",
    mutants: [
      "kernel.wrong-opaque-object-hash",
      "kernel.drop-uncommitted-staged-result-on-recovery",
      "kernel.delete-object-reachable-through-live-root",
    ],
    unsupportedReasons: {
      "kernel.accept-duplicate-map-key": "no Rust reproduction yet; not run",
      "kernel.accept-float64-value": "no Rust reproduction yet; not run",
      "kernel.accept-indefinite-length-array":
        "no Rust reproduction yet; not run",
      "kernel.accept-indefinite-length-map":
        "no Rust reproduction yet; not run",
      "kernel.accept-indefinite-length-text-string":
        "no Rust reproduction yet; not run",
      "kernel.accept-non-minimal-length-head":
        "no Rust reproduction yet; not run",
      "kernel.accept-noncanonical-cbor": "no Rust reproduction yet; not run",
      "kernel.accept-stale-head-update": "no Rust reproduction yet; not run",
      "kernel.accept-stale-owner-after-takeover":
        "no Rust reproduction yet; not run",
      "kernel.accept-tagged-value": "no Rust reproduction yet; not run",
      "kernel.accept-trailing-bytes": "no Rust reproduction yet; not run",
      "kernel.accept-truncated-input": "no Rust reproduction yet; not run",
      "kernel.accept-unsafe-negint": "no Rust reproduction yet; not run",
      "kernel.accept-unsafe-uint": "no Rust reproduction yet; not run",
      "kernel.accept-unsorted-map-keys": "no Rust reproduction yet; not run",
      "kernel.drop-canonical-map-entry": "no Rust reproduction yet; not run",
      "kernel.fault-seam-never-fires": "no Rust reproduction yet; not run",
      "kernel.lease-takeover-before-expiry":
        "no Rust reproduction yet; not run",
      "kernel.never-sweep-eligible-objects":
        "no Rust reproduction yet; not run",
      "kernel.noncanonical-changed-paths-order":
        "no Rust reproduction yet; not run",
      "kernel.promote-staged-before-checkpoint":
        "no Rust reproduction yet; not run",
      "kernel.resolve-object-across-scopes":
        "no Rust reproduction yet; DS owns the scope-resolution mutant",
      "kernel.sweep-inside-grace-window": "no Rust reproduction yet; not run",
      "kernel.wrong-schema-record-hash": "no Rust reproduction yet; not run",
      "kernel.wrong-turn-node-record-hash": "no Rust reproduction yet; not run",
      "kernel.wrong-turn-tree-hash": "no Rust reproduction yet; not run",
    },
    profile: "kernel.memory",
  },
  durable("sqlite", "kernel.memory"),
  durable("postgres", "kernel.memory"),
  durable("sqlite", "kernel.persistent-reopen"),
  durable("postgres", "kernel.persistent-reopen"),
  durable("sqlite", "kernel.process-crash"),
  durable("postgres", "kernel.process-crash"),
  durable("postgres", "kernel.shared-backend"),
];
