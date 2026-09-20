import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// CI runs `npm test` at the monorepo root and never installs
// apps/desktop/node_modules (see
// apps/desktop/src/liveTasks/workspacePlanIo.ts). Every @tauri-apps/*
// specifier used by apps/desktop/src is aliased to a single stub so desktop
// unit tests resolve on any machine — keep this list in sync with the stub's
// exports (apps/desktop/src/testSupport/tauriApiStub.ts).
// Derive the stub path from THIS file (not process.cwd()): `npm test
// --workspace=@zelari/core` runs vitest with cwd=packages/core and must not
// silently break this alias (see packages/core/vitest.config.ts).
const tauriStub = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  'apps/desktop/src/testSupport/tauriApiStub.ts',
);
const tauriAliases = [
  '@tauri-apps/api/core',
  '@tauri-apps/api/event',
  '@tauri-apps/api/app',
  '@tauri-apps/api/window',
  '@tauri-apps/api/webviewWindow',
  '@tauri-apps/plugin-dialog',
  '@tauri-apps/plugin-opener',
  '@tauri-apps/plugin-updater',
  '@tauri-apps/plugin-process',
].map((spec) => ({ find: spec, replacement: tauriStub }));

// Keep process-heavy Git, SQLite-worker, and Tauri-adjacent suites reliable on
// developer machines and CI runners without weakening individual timeouts.
export default defineConfig({
  resolve: {
    alias: tauriAliases,
  },
  test: {
    maxWorkers: '50%',
    setupFiles: ['./tests/setup/jailModeDefault.ts'],
    // NOTE: `exclude` REPLACES Vitest's defaults — restate them, then keep
    // generated eval artifacts (baseline worktree snapshots under
    // eval/results/) out of the suite: they are stale copies of product
    // tests (e.g. runOneTurn.*), not product tests. See
    // .zelari/docs/2026-09-15-diagnosi-lag-input-e-desync-modelli.md
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      'eval/results/**',
      // Kraken worktree checkouts (.zelari/worktrees/*) are full repo copies:
      // without this exclude, vitest collects their test files as stale
      // duplicates of product tests (observed: taskTool.progress ran 3x).
      '**/.zelari/**',
    ],
  },
});
