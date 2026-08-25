/**
 * tools/eval/arms/metrics.ts — pure NDJSON → ArmRunMetrics extraction
 * (upgrade doc §84). Reads the BrainEvent stream the headless CLI already
 * emits (agent_start/agent_end, tool_execution_*, session_compacted) and
 * tolerates the §89 events that are not wired to stdout yet (they simply
 * count 0 until they appear).
 */

import type { ArmRunMetrics } from './types.ts';

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function zeroMetrics(): ArmRunMetrics {
  return {
    passed: false,
    durationMs: 0,
    modelCalls: 0,
    toolCalls: 0,
    toolFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    tentacles: 0,
    retries: 0,
    verificationFailures: 0,
    guardWarnings: 0,
    compactions: 0,
    spillCount: 0,
    recoveryReads: 0,
  };
}

/**
 * Extract metrics from raw NDJSON lines (stdout of `--output json`).
 * Malformed lines are skipped, never thrown — a partial capture must still
 * produce a metrics object.
 */
export function metricsFromNdjson(lines: readonly string[], passed: boolean): ArmRunMetrics {
  const m = zeroMetrics();
  m.passed = passed;

  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    let ev: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      ev = parsed as Record<string, unknown>;
    } catch {
      continue; // partial/garbage line — tolerate
    }

    const ts = num(ev.ts);
    if (ts > 0) {
      firstTs = Math.min(firstTs, ts);
      lastTs = Math.max(lastTs, ts);
    }

    switch (ev.type) {
      case 'agent_start':
        m.modelCalls++;
        // A tentacle is an agent with a known parent (kraken task spawns).
        if (typeof ev.parentAgentId === 'string' && ev.parentAgentId.length > 0) {
          m.tentacles++;
        }
        break;

      case 'agent_end': {
        const usage = ev.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage === 'object') {
          m.inputTokens += num(usage.input) + num(usage.inputTokens);
          m.outputTokens += num(usage.output) + num(usage.outputTokens);
          m.cachedTokens +=
            num(usage.cached) + num(usage.cacheHitTokens) + num(usage.cachedInputTokens);
        }
        if (typeof ev.reason === 'string' && ev.reason.toLowerCase().includes('retry')) {
          m.retries++;
        }
        break;
      }

      case 'tool_execution_start':
        m.toolCalls++;
        // Heuristic recovery read: a read_file aimed at the run spill store.
        if (ev.tool === 'read_file' && line.includes('/spill/')) {
          m.recoveryReads++;
        }
        break;

      case 'tool_execution_end':
        if (ev.status === 'failed' || num(ev.exitCode) !== 0) {
          if (ev.status === 'failed' || typeof ev.exitCode === 'number') m.toolFailures++;
        }
        break;

      case 'session_compacted':
        m.compactions++;
        break;

      // §89 events: count when present, zero until the CLI emits them.
      case 'runtime_warning':
        m.guardWarnings++;
        break;
      case 'tool_result_spilled':
        m.spillCount++;
        break;
      case 'verification_failed':
        m.verificationFailures++;
        break;
      default:
        break;
    }
  }

  m.durationMs =
    Number.isFinite(firstTs) && lastTs > firstTs ? Math.round(lastTs - firstTs) : 0;
  return m;
}
