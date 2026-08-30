/**
 * desktop-harness-sidecar-lifecycle.test.ts — grep-gate for the Desktop
 * sidecar LIFECYCLE contract (Pilastro B): an unexpected child death is
 * restarted with exponential backoff (RESTART_BASE 500ms doubling up to
 * RESTART_CAP 8s, MAX_RESTART_ATTEMPTS tries), every in-flight request
 * fails with the typed error `sidecar_died`, exhaustion emits
 * `harness-sidecar-status` {status:"down"}, a graceful shutdown NEVER
 * restarts, and there is NO `--headless` fallback anywhere.
 *
 * CI does not run `cargo test`; like desktop-harness-sidecar-spawn.test.ts
 * this reads the Rust source so `npm test` fails if the lifecycle contract
 * regresses.
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

// Read ONCE at collection time; every describe below asserts on this text.
const src = fs.readFileSync(SIDECAR_RS, 'utf8');

/** Source between two markers (spawn-test style: split on section heads). */
function slice(from: string, to: string): string | undefined {
  const start = src.indexOf(from);
  if (start < 0) return undefined;
  const end = src.indexOf(to, start + from.length);
  return end < 0 ? undefined : src.slice(start, end);
}

describe('desktop harness sidecar lifecycle — restart/backoff constants', () => {
  it('restart backoff starts at 500ms (RESTART_BASE)', () => {
    expect(src).toMatch(
      /const RESTART_BASE: Duration = Duration::from_millis\(500\);/,
    );
  });

  it('restart backoff is capped at 8s (RESTART_CAP)', () => {
    expect(src).toMatch(/const RESTART_CAP: Duration = Duration::from_secs\(8\);/);
  });

  it('restart is bounded to 5 attempts (MAX_RESTART_ATTEMPTS)', () => {
    expect(src).toMatch(/const MAX_RESTART_ATTEMPTS: u32 = 5;/);
  });
});

describe('desktop harness sidecar lifecycle — in-flight sidecar_died', () => {
  it('wait_timeout maps a Disconnected channel to sidecar_died', () => {
    const body = slice('fn wait_timeout', 'fn poll');
    expect(body, 'wait_timeout body not found').toBeTruthy();
    expect(body).toMatch(
      /RecvTimeoutError::Disconnected\)\s*=>\s*Err\(HarnessError::new\(\s*"sidecar_died",\s*"harness sidecar exited while the request was in flight"/,
    );
    // The other branch stays a typed timeout — never a crash.
    expect(body).toContain(
      'HarnessError::new("timeout", "harness request timed out")',
    );
  });

  it('poll maps a Disconnected channel to sidecar_died (turn loop)', () => {
    const body = slice('fn poll', '/// Manager for the single sidecar');
    expect(body, 'poll body not found').toBeTruthy();
    expect(body).toMatch(
      /TryRecvError::Disconnected\)\s*=>\s*Some\(Err\(HarnessError::new\(\s*"sidecar_died",\s*"harness sidecar exited while the turn was running"/,
    );
  });

  it('fail_and_clear_proc reaps pending as sidecar_died, clears the proc, emits down', () => {
    const body = slice('fn fail_and_clear_proc', 'fn write_request');
    expect(body, 'fail_and_clear_proc body not found').toBeTruthy();
    expect(body).toContain('fail_pending(&proc.pending, "sidecar_died", msg);');
    expect(body).toContain('Arc::ptr_eq(current, proc)');
    expect(body).toContain('*guard = None;');
    expect(body).toMatch(/self\.emit_status\("down", msg\);/);
    // Reap happens BEFORE the status flip.
    expect(body!.indexOf('fail_pending(&proc.pending')).toBeLessThan(
      body!.indexOf('self.emit_status("down"'),
    );
  });

  it('fail_pending drains the pending map, failing every waiter with the typed code', () => {
    const body = slice('fn fail_pending', '#[cfg(test)]');
    expect(body, 'fail_pending body not found').toBeTruthy();
    expect(body).toContain('for (_, tx) in guard.drain() {');
    expect(body).toContain('tx.send(Err(HarnessError::new(code, message)))');
  });

  it('status rides the harness-sidecar-status event as {status, message}', () => {
    expect(src).toContain('"harness-sidecar-status"');
    expect(src).toContain('json!({ "status": status, "message": message })');
  });

  it('write_request surfaces sidecar_down when no child is running', () => {
    expect(src).toMatch(
      /HarnessError::new\(\s*"sidecar_down",\s*"harness sidecar is not running"\)/,
    );
  });
});

describe('desktop harness sidecar lifecycle — supervise_child restart loop', () => {
  // Body only: up to the next function's doc comment.
  const supervise = () => slice('fn supervise_child', '/// Boot-timeout killer');

  it('supervise_child exists', () => {
    expect(supervise(), 'supervise_child body not found').toBeTruthy();
  });

  it('reaps the dead generation (fail_and_clear_proc) before deciding', () => {
    const body = supervise();
    expect(body).toBeTruthy();
    expect(body).toContain('me.fail_and_clear_proc(&proc, &msg);');
    // Reap precedes BOTH the shutdown early-return and the restart loop.
    // (`if graceful {` occurs twice — msg selection, then early-return —
    // so anchor on the return/restart statements, not on `if graceful {`.)
    expect(body!.indexOf('me.fail_and_clear_proc')).toBeLessThan(
      body!.indexOf('return; // app is closing: never restart'),
    );
    expect(body!.indexOf('me.fail_and_clear_proc')).toBeLessThan(
      body!.indexOf('me.emit_status("restarting"'),
    );
  });

  it('graceful shutdown emits stopped and returns — never restarts', () => {
    const body = supervise();
    expect(body).toBeTruthy();
    expect(body).toContain('me.emit_status("stopped", &msg);');
    expect(body).toContain('return; // app is closing: never restart');
    // The graceful early-return precedes the restart loop.
    expect(body!.indexOf('if graceful {')).toBeLessThan(
      body!.indexOf('me.emit_status("restarting"'),
    );
  });

  it('restart loop re-checks shutting_down before each attempt', () => {
    const body = supervise();
    expect(body).toBeTruthy();
    const guards = body!.match(
      /if me\.shutting_down\.load\(Ordering::SeqCst\) \{\s*return;/g,
    );
    expect(guards?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('unexpected death: visible restarting status + exponential backoff with cap', () => {
    const body = supervise();
    expect(body).toBeTruthy();
    expect(body).toContain('me.emit_status("restarting", &msg);');
    expect(body).toContain('let mut backoff = RESTART_BASE;');
    expect(body).toContain('for attempt in 1..=MAX_RESTART_ATTEMPTS {');
    expect(body).toContain('thread::sleep(backoff);');
    expect(body).toMatch(/backoff = \(backoff \* 2\)\.min\(RESTART_CAP\);/);
    // Status flip comes before the sleep loop.
    expect(body!.indexOf('me.emit_status("restarting"')).toBeLessThan(
      body!.indexOf('let mut backoff = RESTART_BASE;'),
    );
  });

  it('a successful respawn flips status to ready (first-restarter wins)', () => {
    const body = supervise();
    expect(body).toBeTruthy();
    expect(body).toContain('if me.spawn_generation().is_ok() {');
    expect(body).toContain('me.emit_status("ready", "harness sidecar restarted");');
    expect(body).toContain('return; // someone else restarted it already');
    // Success path precedes the exhaustion check.
    expect(body!.indexOf('me.spawn_generation().is_ok()')).toBeLessThan(
      body!.indexOf('if attempt == MAX_RESTART_ATTEMPTS'),
    );
  });

  it('exhausted attempts emit down with no fallback', () => {
    const body = supervise();
    expect(body).toBeTruthy();
    expect(body).toContain('if attempt == MAX_RESTART_ATTEMPTS {');
    expect(body).toMatch(/me\.emit_status\(\s*"down",/);
    expect(body).toMatch(
      /"harness sidecar failed \{MAX_RESTART_ATTEMPTS\} restart attempts/,
    );
    expect(body).toContain('new runs will report the error (no fallback)');
  });
});

describe('desktop harness sidecar lifecycle — no --headless fallback', () => {
  it('spawn_generation never spawns --headless (serve-harness only)', () => {
    const spawnGen = slice('fn spawn_generation', 'fn fail_and_clear_proc');
    expect(spawnGen, 'spawn_generation body not found').toBeTruthy();
    expect(spawnGen).not.toContain('--headless');
    expect(spawnGen).toContain('cmd.args(SIDECAR_CLI_ARGS)');
    expect(spawnGen).toContain('ZELARI_SERVE_HARNESS');
  });

  it('supervise_child restarts via spawn_generation, never a --headless spawn', () => {
    const body = slice('fn supervise_child', '/// Boot-timeout killer');
    expect(body, 'supervise_child body not found').toBeTruthy();
    expect(body).not.toContain('--headless');
    expect(body).toContain('me.spawn_generation()');
  });

  it('the module contract documents zero fallback', () => {
    expect(src).toContain('No `--headless` fallback anywhere.');
  });
});
