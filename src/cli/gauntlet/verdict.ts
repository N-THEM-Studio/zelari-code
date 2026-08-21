/**
 * Gauntlet critic verdict. unknown ≠ pass (ADR-0023): a PASS without tool
 * evidence is rewritten to GAP.
 */
export type GauntletVerdictKind = 'PASS' | 'GAP' | 'BLOCKED';

export interface GauntletVerdict {
  kind: GauntletVerdictKind;
  /** Single biggest remaining gap. Set on GAP (and sometimes BLOCKED). */
  gap?: string;
  /** True when the critic ran at least one tool (disk/command evidence). */
  evidence: boolean;
}

const VERDICT_RE = /\bVERDICT:\s*(PASS|GAP|BLOCKED)\b/i;
const GAP_RE = /\bGAP:\s*(.+)/i;
const REPORT_STATUS_RE = /^status:\s*(pass|fail|unknown)\b/gim;

export function parseGauntletVerdict(
  text: string,
  opts: { toolTraceCount?: number; builderFailed?: boolean; builderError?: string } = {},
): GauntletVerdict {
  const evidence = (opts.toolTraceCount ?? 0) > 0;
  if (opts.builderFailed) {
    return {
      kind: 'GAP',
      gap: (opts.builderError ?? 'builder failed').trim() || 'builder failed',
      evidence,
    };
  }
  const raw = (text ?? '').trim();
  if (!raw) {
    return { kind: 'BLOCKED', gap: 'critic produced no output', evidence };
  }

  const explicit = VERDICT_RE.exec(raw);
  let kind: GauntletVerdictKind | undefined = explicit
    ? (explicit[1]!.toUpperCase() as GauntletVerdictKind)
    : undefined;

  const reports = [...raw.matchAll(REPORT_STATUS_RE)].map((m) => m[1]!.toLowerCase());
  const anyFail = reports.includes('fail');
  const anyUnknown = reports.includes('unknown');
  const anyPass = reports.includes('pass');

  if (!kind) {
    if (anyFail) kind = 'GAP';
    else if (anyPass && !anyUnknown) kind = 'PASS';
    else if (anyUnknown && !anyPass) kind = 'BLOCKED';
    else kind = 'BLOCKED';
  }

  const gapMatch = GAP_RE.exec(raw);
  let gap = gapMatch ? gapMatch[1]!.trim() : undefined;
  if (kind === 'GAP' && !gap) {
    gap = anyFail
      ? 'a verify-report check failed'
      : 'critic named a gap without a GAP: line';
  }

  if (kind === 'PASS' && !evidence) {
    return {
      kind: 'GAP',
      gap: 'unknown ≠ pass: critic declared PASS without tool evidence',
      evidence: false,
    };
  }

  if (kind === 'PASS' && anyFail) {
    return {
      kind: 'GAP',
      gap: gap ?? 'verify-report contains a fail',
      evidence,
    };
  }

  return { kind, ...(gap ? { gap } : {}), evidence };
}
