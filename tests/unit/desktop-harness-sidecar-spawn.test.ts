/**
 * desktop-harness-sidecar-spawn.test.ts — grep-gate for the 2.16.0
 * Desktop regression: the Tauri sidecar spawned `node zelari-code.js`
 * with no argv, so the Ink TUI booted and PluginGate's first frame
 * ("Checking for optional tool plugins…") became the handshake line.
 *
 * CI does not run `cargo test`; this reads the Rust source so `npm test`
 * fails if spawn_generation drops `--serve-harness` again.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_RS = path.resolve(
  HERE,
  '../../apps/desktop/src-tauri/src/harness_sidecar.rs',
);

describe('desktop harness sidecar spawn (2.16.0 regression)', () => {
  const src = fs.readFileSync(SIDECAR_RS, 'utf8');

  it('declares SIDECAR_CLI_ARGS as --serve-harness', () => {
    expect(src).toMatch(
      /const SIDECAR_CLI_ARGS: &\[&str\] = &\["--serve-harness"\];/,
    );
  });

  it('spawn_generation passes SIDECAR_CLI_ARGS before spawn', () => {
    const spawnFn = src.split('fn spawn_generation')[1]?.split(
      'let mut child = cmd.spawn',
    )[0];
    expect(spawnFn, 'spawn_generation body not found').toBeTruthy();
    expect(spawnFn).toContain('cmd.args(SIDECAR_CLI_ARGS)');
    expect(spawnFn).toContain('ZELARI_SERVE_HARNESS');
  });

  it('rejects the PluginGate TUI frame as a boot line', () => {
    expect(src).toContain('Checking for optional tool plugins');
    expect(src).toContain('fn interpret_boot_line');
  });
});
