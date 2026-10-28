import { requiresHandleProtocolUpgrade } from "./operation-steps.js";

interface SelectionInput {
  adapter: ReadonlySet<string>;
  checkId: string;
  protocolVersion: string;
  requested: ReadonlySet<string>;
  required: readonly string[];
  steps:
    | readonly { action?: string; arguments?: Record<string, unknown> }[]
    | undefined;
}

export const needsServerClock = (steps: SelectionInput["steps"]): boolean =>
  (steps ?? []).some((step) => {
    if (step.action !== "setClock") {
      return false;
    }
    const source = step.arguments?.source;
    return (
      source === "server" ||
      (typeof source === "object" &&
        source !== null &&
        (("$literal" in source && source.$literal === "server") ||
          "$ref" in source))
    );
  });

export const selectCheck = ({
  adapter,
  checkId,
  protocolVersion,
  requested,
  required: declared,
  steps,
}: SelectionInput): { checkId: string; selected: boolean; reason?: string } => {
  const required = needsServerClock(steps)
    ? [...new Set([...declared, "clock.backend-server"])]
    : declared;
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
