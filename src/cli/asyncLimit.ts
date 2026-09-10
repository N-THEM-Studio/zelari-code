/**
 * asyncLimit — minimal bounded-concurrency runner (zero deps).
 *
 * Latency fix (Int 3b): the Kraken memory-graph link tail awaited one
 * round-trip per edge. A bounded fan-out collapses K sequential awaits into
 * ceil(K / limit) waves without opening an unbounded number of calls on the
 * memory backend.
 *
 * @since v2.37.x
 */

/**
 * Run `fn` over `items` with at most `limit` calls in flight at any time.
 *
 * Semantics (small and explicit — callers rely on them):
 *   - `limit` is clamped to >= 1: `0`, negatives and `NaN` mean "sequential",
 *     so a bad env/clamp upstream can never deadlock or fan out unbounded;
 *   - items start in input order: the first `limit` items are started by the
 *     workers in order, later items start as slots free up (completion order);
 *   - fail-fast: the returned promise rejects with the FIRST rejection of
 *     `fn`. In-flight calls are neither awaited nor cancelled (their outcome is
 *     ignored) and no further item is started, which keeps the failure latency
 *     low. The runner holds no state after it settles, so a rejection can never
 *     leave a slot held — retrying is always safe;
 *   - resolves with `undefined` once every item settled successfully.
 *
 * @example
 * await runWithLimit(edges, 8, (edge) => memory.connect(edge).catch(() => undefined));
 */
export async function runWithLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<unknown>,
): Promise<void> {
  const slots = Math.min(
    items.length,
    Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 1),
  );
  if (slots <= 0) return;

  let cursor = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed && cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        await fn(items[index], index);
      } catch (err) {
        failed = true; // stop every worker from pulling more items
        throw err;
      }
    }
  };

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < slots; i += 1) workers.push(worker());
  await Promise.all(workers);
}
