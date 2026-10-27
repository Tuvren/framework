import { requiresHandleProtocolUpgrade } from "./operation-steps.js";

interface SelectionInput {
  adapter: ReadonlySet<string>;
  checkId: string;
  protocolVersion: string;
  requested: ReadonlySet<string>;
  required: readonly string[];
  steps: readonly { action?: string }[] | undefined;
}

export const selectCheck = ({
  adapter,
  checkId,
  protocolVersion,
  requested,
  required,
  steps,
}: SelectionInput): { checkId: string; selected: boolean; reason?: string } => {
  const missing = required.filter((capability) => !adapter.has(capability));
  const matches =
    requested.size === 0 ||
    required.some((capability) => requested.has(capability));
  const reasons: string[] = [];
  if (missing.length > 0) {
    reasons.push(`missing capabilities: ${missing.join(", ")}`);
  }
  if (!matches) {
    reasons.push(
      `outside requested capabilities: ${[...requested].join(", ")}`
    );
  }
  if (requiresHandleProtocolUpgrade(steps, protocolVersion)) {
    reasons.push(
      "requires adapter protocol >= 0.2.0 for operation handle steps"
    );
  }
  return {
    checkId,
    selected: reasons.length === 0,
    ...(reasons.length === 0 ? {} : { reason: reasons.join("; ") }),
  };
};
