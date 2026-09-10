/**
 * verification/runWithLimit.ts — minimal bounded-concurrency runner (Int2a).
 *
 * Local copy of the CLI's `src/cli/asyncLimit.ts` discipline: core must not
 * import from `src/cli`, and the semantics the engine needs are slightly
 * different (see below), so this stays a ~30 LOC private module instead of a
 * new shared util package.
 *
 * Semantics:
 *   - `limit` is clamped to `[1, items.length]`: `0`, negatives and `NaN`
 *     mean "one at a time", so a bad env value can never deadlock the gate;
 *   - items are claimed in input order, later items start as slots free up;
 *   - every item is assigned its own index, so a caller can write results
 *     into a slot (`results[index] = …`) and keep the input order;
 *   - the returned promise rejects with the FIRST error only after the
 *     in-flight callbacks settled (no dangling work mutating caller state
 *     after `evaluate()` rejected).
 */

/**
 * Run `fn` over `items` with at most `limit` calls in flight at any time.
 * Resolves with `undefined` once every item settled successfully.
 */
export async function runWithLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const slots = Math.min(
    items.length,
    Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 1),
  );
  if (slots <= 0) return;

  let cursor = 0;
  let failed = false;
  let firstError: unknown;

  const worker = async (): Promise<void> => {
    while (!failed && cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        await fn(items[index] as T, index);
      } catch (err) {
        // Stop claiming new items; the first failure is the one rethrown.
        if (!failed) {
          failed = true;
          firstError = err;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: slots }, () => worker()));
  if (failed) throw firstError;
}
