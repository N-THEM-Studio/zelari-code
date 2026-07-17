/**
 * headless-run.test.ts — end-to-end smoke test for runHeadless single-agent path.
 *
 * Mocks AgentHarness + keyStore + providerConfig so the test never touches
 * the network or fs. Verifies:
 *   - exit code 0 on success
 *   - exit code 1 on missing API key
 *   - exit code 3 on agent_end with reason='error'
 *   - json output writes one NDJSON line per event
 *   - plain output writes only message_delta deltas to stdout
 *
 * @since 0.5.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Module-level mocks (hoisted by Vitest) ──────────────────────────────

const { harnessEvents } = vi.hoisted(() => ({
  // A queue of events the fake harness will yield on each .run() call.
  // Tests push events into this list before invoking runHeadless.
  harnessEvents: [] as Array<Record<string, unknown>>,
}));

vi.mock('@zelari/core/harness', () => ({
  AgentHarness: class {
    run = async function* () {
      for (const ev of harnessEvents) yield ev;
    };
    queueLength = 0;
    getMessages = () => [] as readonly unknown[];
    enqueue = vi.fn();
    cancel = vi.fn();
    constructor(_opts: unknown) {
      // capture: store opts for inspection if a test needs it
      (this as { lastOpts?: unknown }).lastOpts = _opts;
    }
  },
}));

vi.mock('../../src/cli/provider/openai-compatible.js', () => ({
  openaiCompatibleProvider: vi.fn(() => async function* () {}),
  // headless.ts (resolveHeadlessKey) lazily imports resolveBaseUrl to attach
  // the custom-endpoint base URL to the resolved key metadata.
  resolveBaseUrl: vi.fn(() => 'https://api.x.ai/v1'),
}));

vi.mock('../../src/cli/keyStore.js', () => ({
  PROVIDERS: [
    { id: 'minimax', envVar: 'MINIMAX_API_KEY' },
    { id: 'grok', envVar: 'GROK_API_KEY' },
  ],
  resolveApiKeyWithMeta: vi.fn(async (id: string) => {
    if (id === 'minimax') return { apiKey: 'test-key-minimax' };
    if (id === 'grok') return { apiKey: 'test-key-grok' };
    return null;
  }),
}));

vi.mock('../../src/cli/providerConfig.js', () => ({
  getActiveProvider: vi.fn(() => ({ id: 'minimax' })),
  getModelForProvider: vi.fn(() => 'MiniMax-M3'),
  getCustomEndpoint: vi.fn(() => undefined),
}));

vi.mock('../../src/cli/toolRegistry.js', () => ({
  createBuiltinToolRegistry: vi.fn(() => ({
    registry: {
      toOpenAITools: () => [],
      register: vi.fn(),
      list: () => [],
      get: () => undefined,
    },
    tools: [],
  })),
}));

// ─── Imports under test ──────────────────────────────────────────────────

import { runHeadless } from '../../src/cli/runHeadless.js';
import * as keyStore from '../../src/cli/keyStore.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function captureStdout(): { read(): string; restore(): void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Buffer) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  return {
    read: () => chunks.join(''),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function captureStderr(): { read(): string; restore(): void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Buffer) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  return {
    read: () => chunks.join(''),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

beforeEach(() => {
  harnessEvents.length = 0;
  // runHeadless still calls registerMcpTools unless disabled — keep unit tests hermetic.
  process.env['ZELARI_MCP'] = '0';
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('runHeadless — single agent', () => {
  it('returns 0 and emits NDJSON on success', async () => {
    harnessEvents.push(
      { type: 'agent_start', role: 'primary', ts: 1 },
      { type: 'message_start', role: 'assistant', ts: 2 },
      { type: 'message_delta', delta: 'hello', ts: 3 },
      { type: 'message_delta', delta: ' world', ts: 4 },
      { type: 'message_end', role: 'assistant', ts: 5 },
      { type: 'agent_end', reason: 'completed', durationMs: 10, ts: 6 },
    );

    const out = captureStdout();
    try {
      const code = await runHeadless({
        task: 'say hi', output: 'json', useCouncil: false,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
    }

    const text = out.read();
    // NDJSON: optional leading meta log (`[headless] mode=…`) + harness events
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(6);
    const events = lines.map((l) => {
      expect(() => JSON.parse(l)).not.toThrow();
      return JSON.parse(l) as { type: string; message?: string };
    });
    expect(events.some((e) => e.type === 'agent_start')).toBe(true);
    expect(events.some((e) => e.type === 'message_delta')).toBe(true);
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
    if (events[0]?.type === 'log') {
      expect(events[0].message).toMatch(/\[headless\]/);
    }
  });

  it('returns 1 with clear error when API key is missing', async () => {
    vi.mocked(keyStore.resolveApiKeyWithMeta).mockResolvedValueOnce(null);

    const err = captureStderr();
    try {
      const code = await runHeadless({
        task: 'do thing', output: 'json', useCouncil: false,
      });
      expect(code).toBe(1);
    } finally {
      err.restore();
    }

    expect(err.read()).toMatch(/no API key for provider/);
  });

  it('returns 3 when agent_end reason is error', async () => {
    harnessEvents.push(
      { type: 'agent_start', role: 'primary', ts: 1 },
      { type: 'agent_end', reason: 'error', durationMs: 5, ts: 2 },
    );

    const code = await runHeadless({
      task: 'oops', output: 'json', useCouncil: false,
    });
    expect(code).toBe(3);
  });

  it('returns 2 when a fatal error event is emitted', async () => {
    harnessEvents.push(
      { type: 'error', severity: 'fatal', message: 'kaboom', ts: 1 },
    );

    const code = await runHeadless({
      task: 'x', output: 'json', useCouncil: false,
    });
    expect(code).toBe(2);
  });

  it('plain output writes only message_delta deltas', async () => {
    harnessEvents.push(
      { type: 'agent_start', role: 'primary', ts: 1 },
      { type: 'message_delta', delta: 'foo', ts: 2 },
      { type: 'message_delta', delta: 'bar', ts: 3 },
      { type: 'agent_end', reason: 'completed', durationMs: 1, ts: 4 },
    );

    const out = captureStdout();
    try {
      const code = await runHeadless({
        task: 'x', output: 'plain', useCouncil: false,
      });
      expect(code).toBe(0);
    } finally {
      out.restore();
    }

    const text = out.read();
    // plain output should contain the deltas (possibly with surrounding
    // agent_start/agent_end info if json mode were on, but plain mode
    // must NOT include those events).
    expect(text).toContain('foo');
    expect(text).toContain('bar');
    // agent_start is not a delta — should not appear in plain text
    expect(text).not.toContain('"type":"agent_start"');
  });
});
