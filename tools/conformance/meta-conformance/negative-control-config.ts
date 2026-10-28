export interface NegativeControlPortConfig {
  activationOperation: string;
  branchAdapters?: readonly string[];
  capabilities?: readonly string[];
  mutants?: readonly string[];
  unsupportedReasons?: Readonly<Record<string, string>>;
  undetectedReasons?: string;
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
  undetectedReasons: `spec/conformance/kernel/${profile.replace(".", "-")}-undetected.json`,
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
    undetectedReasons: "spec/conformance/kernel/kernel-memory-undetected.json",
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
      "kernel.accept-noncanonical-cbor": "no Rust reproduction yet; not run",
      "kernel.accept-stale-head-update": "no Rust reproduction yet; not run",
      "kernel.accept-stale-owner-after-takeover":
        "no Rust reproduction yet; not run",
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
        "no shared-substrate construction seam in the Rust kernel; not run",
      "kernel.sweep-inside-grace-window": "no Rust reproduction yet; not run",
    },
    profile: "kernel.memory",
    undetectedReasons: "spec/conformance/kernel/kernel-memory-undetected.json",
  },
  durable("sqlite", "kernel.persistent-reopen"),
  durable("postgres", "kernel.persistent-reopen"),
  durable("sqlite", "kernel.process-crash"),
  durable("postgres", "kernel.process-crash"),
  durable("postgres", "kernel.shared-backend"),
];
