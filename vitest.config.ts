import { defineConfig } from 'vitest/config';

// Keep process-heavy Git, SQLite-worker, and Tauri-adjacent suites reliable on
// developer machines and CI runners without weakening individual timeouts.
export default defineConfig({
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
    ],
  },
});
