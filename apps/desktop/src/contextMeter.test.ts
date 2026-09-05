import { describe, expect, it } from "vitest";
import {
  computeContextMeter,
  DEFAULT_SPINE_MAX_AGE_MS,
} from "./contextMeter";
import { DEFAULT_CONTEXT_LIMIT } from "./components/TurnStatsCard";

const NOW = 1_000_000_000;
const FRESH = NOW - 5_000; // budget event arrived 5s ago

/**
 * Honesty kernel for the session-strip context meter (t94). The pinned
 * bug: a turn with Σ~64k real tokens on a 200k model rendered "ctx ~100%"
 * because the meter divided a chars/4 proxy by a hardcoded limit while
 * ignoring the spine's budget event entirely.
 */
describe("computeContextMeter", () => {
  it("(a) uses the FRESH spine budget event: occupancy + real window, no est. tag", () => {
    const m = computeContextMeter({
      spine: { occupancy: 0.32, contextLimit: 200_000, receivedAt: FRESH },
      proxyTokens: 999_999, // proxy must be ignored — spine wins
      fallbackLimit: DEFAULT_CONTEXT_LIMIT,
      now: NOW,
    });
    expect(m.source).toBe("spine");
    expect(m.pct).toBeCloseTo(32, 1);
    expect(m.limit).toBe(200_000);
    expect(m.estimated).toBe(false);
    expect(m.limitEstimated).toBe(false);
    expect(m.tooltip).toContain("budget event");
  });

  it("(b) falls back to the labeled proxy when no budget event exists", () => {
    const m = computeContextMeter({
      spine: null,
      proxyTokens: 64_000,
      fallbackLimit: DEFAULT_CONTEXT_LIMIT,
      now: NOW,
    });
    expect(m.source).toBe("proxy");
    expect(m.pct).toBeCloseTo(32, 1);
    expect(m.estimated).toBe(true);
    expect(m.tooltip).toContain("est.");
    expect(m.tooltip).toContain("no fresh budget event");
  });

  it("(c) limit priority: spine event window > model window > 200k fallback", () => {
    // Spine window wins outright.
    const fromEvent = computeContextMeter({
      spine: { occupancy: 0.5, contextLimit: 400_000, receivedAt: FRESH },
      modelContextLimit: 1_000_000,
      fallbackLimit: DEFAULT_CONTEXT_LIMIT,
      now: NOW,
    });
    expect(fromEvent.limit).toBe(400_000);
    expect(fromEvent.limitEstimated).toBe(false);

    // Model window beats the fallback when the event carries no limit…
    const fromModel = computeContextMeter({
      spine: { occupancy: 0.5, receivedAt: FRESH },
      modelContextLimit: 1_000_000,
      fallbackLimit: DEFAULT_CONTEXT_LIMIT,
      now: NOW,
    });
    expect(fromModel.limit).toBe(1_000_000);
    expect(fromModel.limitEstimated).toBe(false);
    expect(fromModel.estimated).toBe(false);

    // …and the fallback renders as estimated (never silent precision).
    const fromFallback = computeContextMeter({
      spine: { occupancy: 0.5, receivedAt: FRESH },
      fallbackLimit: DEFAULT_CONTEXT_LIMIT,
      now: NOW,
    });
    expect(fromFallback.limit).toBe(200_000);
    expect(fromFallback.limitEstimated).toBe(true);
    expect(fromFallback.estimated).toBe(true);
  });

  it("(d) REGRESSION: 64k real tokens on a 200k model → ~32%, never ~100%", () => {
    // Proxy path (no spine event)…
    const proxy = computeContextMeter({
      proxyTokens: 64_000,
      fallbackLimit: DEFAULT_CONTEXT_LIMIT,
      now: NOW,
    });
    expect(proxy.pct).toBeCloseTo(32, 0);
    expect(proxy.pct).toBeLessThan(40);

    // …and the authoritative path agree (occupancy 0.32 from the spine).
    const spine = computeContextMeter({
      spine: { occupancy: 0.32, contextLimit: 200_000, receivedAt: FRESH },
      proxyTokens: 64_000,
      now: NOW,
    });
    expect(spine.pct).toBeCloseTo(32, 0);
    expect(spine.pct).toBeLessThan(40);
  });

  it("treats a STALE budget event as absent: labeled proxy instead of stale truth", () => {
    const m = computeContextMeter({
      spine: {
        occupancy: 0.99,
        contextLimit: 200_000,
        receivedAt: NOW - DEFAULT_SPINE_MAX_AGE_MS - 1,
      },
      proxyTokens: 32_000,
      fallbackLimit: DEFAULT_CONTEXT_LIMIT,
      now: NOW,
    });
    expect(m.source).toBe("proxy");
    expect(m.pct).toBeCloseTo(16, 1);
    expect(m.estimated).toBe(true);
    expect(m.tooltip).toContain("stale");
  });

  it("honors a custom maxAgeMs (long-fresh event stays authoritative)", () => {
    const m = computeContextMeter({
      spine: { occupancy: 0.4, contextLimit: 200_000, receivedAt: NOW - 60 * 60_000 },
      proxyTokens: 999_999,
      fallbackLimit: DEFAULT_CONTEXT_LIMIT,
      now: NOW,
      maxAgeMs: 2 * 60 * 60_000,
    });
    expect(m.source).toBe("spine");
    expect(m.pct).toBeCloseTo(40, 1);
  });

  it("ignores malformed occupancy (out of range / NaN) — advisory by contract", () => {
    for (const occupancy of [0, -0.1, 1.4, Number.NaN]) {
      const m = computeContextMeter({
        spine: { occupancy, contextLimit: 200_000, receivedAt: FRESH },
        proxyTokens: 50_000,
        fallbackLimit: DEFAULT_CONTEXT_LIMIT,
        now: NOW,
      });
      expect(m.source).toBe("proxy");
      expect(m.pct).toBeCloseTo(25, 1);
      expect(m.estimated).toBe(true);
    }
  });

  it("tolerates clock skew (future receivedAt counts as fresh) and clamps at 100", () => {
    const skewed = computeContextMeter({
      spine: { occupancy: 0.62, contextLimit: 200_000, receivedAt: NOW + 30_000 },
      fallbackLimit: DEFAULT_CONTEXT_LIMIT,
      now: NOW,
    });
    expect(skewed.source).toBe("spine");
    expect(skewed.pct).toBeCloseTo(62, 1);

    const clamped = computeContextMeter({
      spine: { occupancy: 0.995, contextLimit: 100_000, receivedAt: FRESH },
      fallbackLimit: DEFAULT_CONTEXT_LIMIT,
      now: NOW,
    });
    expect(clamped.pct).toBe(99.5); // occupancy ≤ 1, so never a fake 100

    const over = computeContextMeter({
      proxyTokens: 300_000,
      fallbackLimit: DEFAULT_CONTEXT_LIMIT,
      now: NOW,
    });
    expect(over.pct).toBe(100);
  });

  it("shows 0% est. when there is nothing to measure at all", () => {
    const m = computeContextMeter({ now: NOW });
    expect(m.source).toBe("proxy");
    expect(m.pct).toBe(0);
    expect(m.limit).toBe(DEFAULT_CONTEXT_LIMIT);
    expect(m.estimated).toBe(true);
  });
});
