import nodePath from "node:path";

interface ControlBatch {
  controlAdapter: string;
  profile: string;
}

interface IndexedBatch<T> {
  config: T;
  index: number;
}

const ROOT = nodePath.resolve(import.meta.dirname, "../../..");

const CONTROL_BATCH_CONCURRENCY = 4;

export const runControlBatches = async <T extends ControlBatch, R>(
  configs: readonly T[],
  run: (config: T) => Promise<R>
): Promise<R[]> => {
  const byStream = new Map<string, IndexedBatch<T>[]>();
  for (const [index, config] of configs.entries()) {
    const key = JSON.stringify([
      nodePath.resolve(ROOT, config.controlAdapter),
      config.profile,
    ]);
    const group = byStream.get(key) ?? [];
    group.push({ config, index });
    byStream.set(key, group);
  }
  const groups = [...byStream.values()];
  const results: R[] = [];
  let nextGroup = 0;
  const worker = async (): Promise<void> => {
    while (nextGroup < groups.length) {
      const group = groups[nextGroup];
      nextGroup += 1;
      if (group === undefined) {
        return;
      }
      for (const { config, index } of group) {
        results[index] = await run(config);
      }
    }
  };
  const completed = await Promise.allSettled(
    Array.from(
      { length: Math.min(CONTROL_BATCH_CONCURRENCY, groups.length) },
      worker
    )
  );
  const errors: unknown[] = [];
  for (const result of completed) {
    if (result.status === "rejected") {
      errors.push(result.reason);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "control batches failed");
  }
  return results;
};
