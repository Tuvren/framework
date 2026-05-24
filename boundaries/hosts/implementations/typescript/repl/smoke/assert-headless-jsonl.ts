import { readFileSync } from "node:fs";

let recordCount = 0;

const input = readFileSync(0, "utf8");

for (const line of input.split("\n")) {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    continue;
  }

  recordCount += 1;
  const parsed = JSON.parse(trimmed) as unknown;

  if (hasHeadlessError(parsed)) {
    throw new Error(
      `headless JSONL error record: ${parsed.error.message ?? "unknown error"}`
    );
  }
}

if (recordCount === 0) {
  throw new Error("headless JSONL smoke produced no records");
}

function hasHeadlessError(
  value: unknown
): value is { error: { message?: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null
  );
}
