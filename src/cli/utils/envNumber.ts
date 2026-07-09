/**
 * envNumber — robust parse of an env-var integer with a default + bounds.
 *
 * Replaces the duplicated pattern in useChatTurn.ts, runHeadless.ts,
 * historyCompaction.ts, slashCommands.ts, councilConfig.ts, zelariMission.ts,
 * openai-compatible.ts, etc.:
 *
 *   const n = raw ? Number.parseInt(raw, 10) : DEFAULT;
 *   return Number.isFinite(n) && n > 0 ? n : DEFAULT;
 *
 * Each copy had slightly different bounds (some `>= 0`, some `> 0`), which
 * is exactly the kind of drift that lets `ZELARI_FOO=abc` fall through to a
 * NaN-coerced harness instead of the documented default. Centralizing here
 * pins the behavior:
 *
 *   - empty/unset → DEFAULT
 *   - non-finite (NaN, Infinity, "abc", "") → DEFAULT
 *   - below min → min
 *   - above max → max (when provided)
 *   - otherwise → the parsed int
 *
 * Tests pin every branch in tests/unit/cli-envNumber.test.ts.
 */
export interface EnvNumberOptions {
  /** Default value when the env var is unset, empty, or unparseable. */
  default: number;
  /**
   * Inclusive lower bound. Values below this snap up to `min` (or `default`
   * when the parsed value is non-finite). Set to 0 to allow zero, set
   * negative for "any int ≥ X".
   */
  min?: number;
  /** Inclusive upper bound (clamped). Optional. */
  max?: number;
}

/**
 * Parse a string from env / user input into a bounded integer.
 *
 * @param raw  The raw env-var value (already trimmed by the caller when needed).
 *             Empty string and "undefined" / "null" tokens are treated as unset.
 * @param opts See {@link EnvNumberOptions}.
 */
export function envNumber(raw: string | undefined | null, opts: EnvNumberOptions): number {
  const { default: def, min, max } = opts;
  if (raw === undefined || raw === null) return def;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return def;
  // Defensive: some env vars accidentally end up as the literal string
  // "undefined" / "null" when JSON.stringify(undefined) leaks in. Treat
  // those as unset too.
  if (trimmed.toLowerCase() === 'undefined' || trimmed.toLowerCase() === 'null') return def;

  const parsed = Number.parseInt(trimmed, 10);
  // parseInt with non-numeric trailing chars (e.g. "30x") silently returns
  // the prefix. Reject anything that doesn't fully parse. The validation:
  //
  //   1. Must be finite (NaN, Infinity rejected).
  //   2. The integer part of the input must round-trip to the same magnitude.
  //
  // We intentionally ACCEPT these input forms:
  //   - Leading `+` sign:  "+30"  → 30  (some shell scripts emit this)
  //   - Leading zeros:     "0030" → 30  (octal-style, harmless in decimal parseInt)
  //   - Negative sign:     "-30"  → -30
  //
  // We intentionally REJECT:
  //   - Trailing junk:     "30x"  (parseInt returns 30 but the input was malformed)
  //   - Unicode minus:     "−30"  (U+2212, NOT ASCII U+002D; parseInt sees NaN)
  //   - Floats:            "30.5" (truncating to 30 silently is the bug we're avoiding)
  //
  // Strategy: strip an optional sign, strip leading zeros, then compare the
  // round-trip. If the input was a negative number, the parsed result must
  // round-trip back to the same magnitude (without the sign) — and we check
  // the sign explicitly.
  if (!Number.isFinite(parsed)) return def;
  const absStr = `${Math.abs(parsed)}`;
  const body = trimmed.replace(/^[-+]/, '').replace(/^0+(?=\d)/, '');
  if (body !== absStr) return def;
  // Sign sanity: input must start with `-` (negative) or `+`/digit (non-negative).
  // Catches inputs like "--30" (double-negative) which parseInt would interpret
  // as 30 but the syntax is bogus.
  const firstChar = trimmed[0];
  const expectedSign = parsed < 0 ? '-' : /[0-9+]/.test(firstChar ?? '');
  const actualSign = parsed < 0 ? firstChar === '-' : firstChar !== '-';
  if (!expectedSign || !actualSign) return def;

  let clamped = parsed;
  if (min !== undefined && clamped < min) clamped = min;
  if (max !== undefined && clamped > max) clamped = max;
  return clamped;
}