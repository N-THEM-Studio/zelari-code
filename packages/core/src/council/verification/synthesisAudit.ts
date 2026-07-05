import type { VerificationCheckResult, VerificationReport, EvidenceTier } from './types.js';
import { matchCheckPrefix, parseEvidenceTier, tierAtLeast, TIER_RANK } from './tiers.js';

export interface SynthesisTableRow {
  check: string;
  tier?: EvidenceTier;
  status?: string;
  evidence?: string;
}

/** Parse markdown table rows under ## Verification status. */
export function parseVerificationTable(synthesisText: string): SynthesisTableRow[] {
  const section = synthesisText.match(
    /##\s+Verification\s+status[^\n]*\n([\s\S]*?)(?=\n##\s|\n---\s*$|$)/i,
  );
  if (!section?.[1]) return [];
  const rows: SynthesisTableRow[] = [];
  for (const line of section[1].split('\n')) {
    if (!line.includes('|') || /^\s*\|?\s*[-:]+/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const headerLike = /^(check|tier|status|evidence|vincolo)/i.test(cells[0] ?? '');
    if (headerLike) continue;
    const check = cells[0] ?? '';
    let tier: EvidenceTier | undefined;
    let status: string | undefined;
    let evidence: string | undefined;
    if (cells.length >= 4) {
      tier = parseEvidenceTier(cells[1]) ?? undefined;
      status = cells[2];
      evidence = cells[3];
    } else if (cells.length === 3) {
      const maybeTier = parseEvidenceTier(cells[1]);
      if (maybeTier) {
        tier = maybeTier;
        status = cells[2];
      } else {
        status = cells[1];
        evidence = cells[2];
      }
    } else {
      status = cells[1];
    }
    rows.push({ check, tier, status, evidence });
  }
  return rows;
}

function reportHasFailingPrefix(report: VerificationReport, prefix: string): boolean {
  return report.results.some((r) => !r.ok && r.id.startsWith(prefix));
}

function maxAchievedTierForPrefix(report: VerificationReport, prefix: string): EvidenceTier {
  const related = report.results.filter((r) => r.id.startsWith(prefix));
  if (related.length === 0) return 'n/a';
  if (related.every((r) => r.ok)) {
    const tiers = related.map((r) => r.tier ?? 'grep');
    return tiers.reduce<EvidenceTier>(
      (best, t) => (TIER_RANK[t] > TIER_RANK[best] ? t : best),
      'grep',
    );
  }
  return 'claimed';
}

/**
 * Detect synthesis claiming PASS or higher tier than the verification report supports.
 */
export function auditSynthesisTiers(
  synthesisText: string | undefined,
  report: VerificationReport,
): VerificationCheckResult[] {
  if (!synthesisText?.trim()) return [];
  const results: VerificationCheckResult[] = [];
  const rows = parseVerificationTable(synthesisText);

  if (rows.length > 0) {
    for (const row of rows) {
      const prefix = matchCheckPrefix(row.check);
      const status = (row.status ?? '').trim().toUpperCase();
      const claimedTier = row.tier ?? (status === 'PASS' ? 'grep' : status === 'FAIL' ? 'claimed' : 'claimed');
      const achieved = maxAchievedTierForPrefix(report, prefix);

      if (status === 'PASS' && reportHasFailingPrefix(report, prefix)) {
        results.push({
          id: 'synthesis.tier-inflation',
          severity: 'error',
          ok: false,
          tier: 'grep',
          message: `Synthesis claims PASS for "${row.check}" but report has failing ${prefix}* checks`,
          evidence: row.check,
        });
      }
      if (row.tier && !tierAtLeast(achieved, row.tier)) {
        results.push({
          id: 'synthesis.tier-inflation',
          severity: 'error',
          ok: false,
          tier: 'grep',
          message: `Synthesis tier "${row.tier}" for "${row.check}" exceeds achieved tier "${achieved}"`,
          evidence: row.check,
        });
      }
    }
  }

  // Global inflation: prose says complete/verified while report.ok is false.
  const globalOkClaim =
    /\b(pronto\s+al\s+commit|tutto\s+verificat|nessuna\s+regressione|green[- ]?light|hand[- ]?off\s+complet)\b/i.test(
      synthesisText,
    );
  if (globalOkClaim && !report.ok) {
    results.push({
      id: 'synthesis.tier-inflation',
      severity: 'error',
      ok: false,
      tier: 'grep',
      message: 'Synthesis claims completion/regression-free while verification-report has blocking FAIL',
    });
  }

  return results;
}
