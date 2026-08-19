/**
 * experimental.ts — registry of experimental flags (2.0 Phase 5).
 *
 * Every experimental capability is OFF unless explicitly enabled via the
 * `ZELARI_EXPERIMENTAL` env var (comma-separated flag list). BoN, remote
 * sandbox, E2B-like providers, generated orchestration and nested delegation
 * all live behind this gate; none may become default without a benchmark
 * case (plan §23-24).
 */

export const EXPERIMENTAL_FLAGS = [
  'bon',
  'remote-sandbox',
  'e2b-provider',
  'generated-orchestration',
  'nested-delegation',
] as const;

export type ExperimentalFlag = (typeof EXPERIMENTAL_FLAGS)[number];

/**
 * True when `flag` appears in `ZELARI_EXPERIMENTAL` (case-insensitive CSV).
 * Unknown values in the env var are ignored silently — flags are opt-in.
 */
export function isExperimentalEnabled(
  flag: ExperimentalFlag,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.ZELARI_EXPERIMENTAL;
  if (!raw) return false;
  const enabled = new Set(
    raw
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return enabled.has(flag);
}
