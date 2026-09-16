import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `npm test --workspace=@zelari/core` (publish.yml "Run tests (core)") runs
// vitest with cwd=packages/core, where the ROOT vitest.config.ts does not
// apply. Without the same reliability caps the process-heavy Git/SQLite-worker
// suites flake on CI runners: at v2.41.0 this step failed while the very same
// tests passed in the root suite of the same commit (and at v2.40.0 the
// uncapped run got lucky). Mirror the root contract so both entry points run
// core tests under identical conditions.
//
// Same for the @tauri-apps/* aliases: at v2.46.1 this config collected
// apps/desktop unit tests (ChatComposer/ChatTranscript) without the root
// alias and "Run tests (core)" failed on `Failed to resolve import
// "@tauri-apps/api/core"` while the root suite was green. Keep both blocks
// in sync with the ROOT vitest.config.ts.
const tauriStub = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../apps/desktop/src/testSupport/tauriApiStub.ts',
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

export default defineConfig({
  resolve: {
    alias: tauriAliases,
  },
  test: {
    maxWorkers: '50%',
    setupFiles: ['../../tests/setup/jailModeDefault.ts'],
    // Mirror of the root exclude: restates Vitest defaults (exclude REPLACES
    // them) and keeps generated eval artifacts out of the suite.
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
