#!/usr/bin/env node
/**
 * desktop-rust-tests — run the Desktop (Tauri) Rust unit tests on any OS.
 *
 *   node scripts/desktop-rust-tests.mjs [test-filter] [-- libtest args]
 *   npm run test:desktop-rust
 *
 * Linux / macOS: plain `cargo test --lib`.
 *
 * Windows: the lib test binary links the Tauri/WebView2 stack, which imports
 * comctl32 v6 symbols (TaskDialogIndirect). tauri-build embeds the required
 * Common-Controls manifest into the APP binary only, so `cargo test` builds a
 * test exe that dies at load with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)
 * before a single test runs. Here the test harness is linked with the same
 * manifest dependency (`cargo rustc --profile test -- -C link-arg=…`, which
 * touches only that one link step) and then executed directly.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = path.join(root, 'apps', 'desktop', 'src-tauri', 'Cargo.toml');
const passThrough = process.argv.slice(2);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
  if (r.error) {
    console.error(`[desktop-rust-tests] failed to start ${cmd}: ${r.error.message}`);
    process.exit(1);
  }
  return r.status ?? 1;
}

if (process.platform !== 'win32') {
  process.exit(run('cargo', ['test', '--manifest-path', manifest, '--lib', ...passThrough]));
}

const COMCTL_V6 =
  "/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' " +
  "version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'";

const build = spawnSync(
  'cargo',
  [
    'rustc',
    '--manifest-path',
    manifest,
    '--lib',
    '--profile',
    'test',
    '--message-format=json-render-diagnostics',
    '--',
    '-C',
    'link-arg=/MANIFEST:EMBED',
    '-C',
    `link-arg=${COMCTL_V6}`,
  ],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024 },
);
if (build.error || build.status !== 0) {
  console.error('[desktop-rust-tests] cargo rustc (test profile) failed');
  process.exit(build.status ?? 1);
}

// The last test-profile artifact with an executable is the lib test harness.
let exe = null;
for (const line of build.stdout.split('\n')) {
  if (!line.startsWith('{')) continue;
  try {
    const msg = JSON.parse(line);
    if (msg.reason === 'compiler-artifact' && msg.profile?.test && msg.executable) exe = msg.executable;
  } catch {
    /* non-JSON cargo output */
  }
}
if (!exe) {
  console.error('[desktop-rust-tests] could not find the lib test executable in cargo output');
  process.exit(1);
}
process.exit(run(exe, passThrough.filter((a) => a !== '--')));
