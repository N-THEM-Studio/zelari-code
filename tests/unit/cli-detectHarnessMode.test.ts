/**
 * cli-detectHarnessMode.test.ts — when the CLI process is the NDJSON
 * harness server (Desktop sidecar) vs the interactive TUI.
 */
import { describe, it, expect } from 'vitest';
import { shouldStartHarnessServer } from '../../src/cli/serve/detectHarnessMode.js';

const sidecarEnv = {
  ANATHEMA_DEV: '1',
  ZELARI_SKIP_PREFLIGHT: '1',
  ZELARI_MEMORY_V2: '1',
};

describe('shouldStartHarnessServer', () => {
  it('starts on --serve-harness even on a TTY', () => {
    expect(
      shouldStartHarnessServer({
        argv: ['--serve-harness'],
        stdinIsTTY: true,
        stdoutIsTTY: true,
      }),
    ).toBe(true);
  });

  it('recovers the 2.16.0 Desktop sidecar fingerprint (no argv, piped stdio)', () => {
    expect(
      shouldStartHarnessServer({
        argv: [],
        env: sidecarEnv,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).toBe(true);
  });

  it('starts when ZELARI_SERVE_HARNESS=1 on a pipe with no argv', () => {
    expect(
      shouldStartHarnessServer({
        argv: [],
        env: { ZELARI_SERVE_HARNESS: '1' },
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).toBe(true);
  });

  it('does not steal an interactive TUI session', () => {
    expect(
      shouldStartHarnessServer({
        argv: [],
        env: sidecarEnv,
        stdinIsTTY: true,
        stdoutIsTTY: true,
      }),
    ).toBe(false);
  });

  it('does not steal one-shot CLI flags (doctor, version, headless, …)', () => {
    expect(
      shouldStartHarnessServer({
        argv: ['--doctor'],
        env: sidecarEnv,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).toBe(false);
  });

  it('does not start on a bare pipe without the Desktop sidecar env', () => {
    expect(
      shouldStartHarnessServer({
        argv: [],
        env: {},
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).toBe(false);
  });
});
