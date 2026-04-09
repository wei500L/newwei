export type ConcurrentSettledResult<T, R> =
  | {
      item: T;
      index: number;
      status: "fulfilled";
      value: R;
    }
  | {
      item: T;
      index: number;
      status: "rejected";
      reason: unknown;
    };

export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<ConcurrentSettledResult<T, R>[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<ConcurrentSettledResult<T, R>>(items.length);
  const safeConcurrency = Math.max(
    1,
    Math.min(
      items.length,
      Number.isFinite(concurrency) ? Math.floor(concurrency) : 1,
    ),
  );
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: safeConcurrency }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;

        if (index >= items.length) {
          return;
        }

        const item = items[index] as T;
        try {
          const value = await worker(item, index);
          results[index] = {
            item,
            index,
            status: "fulfilled",
            value,
          };
        } catch (error) {
          results[index] = {
            item,
            index,
            status: "rejected",
            reason: error,
          };
        }
      }
    }),
  );

  return results;
}
