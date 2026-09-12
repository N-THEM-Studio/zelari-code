import { defineConfig } from 'vitest/config';

// `npm test --workspace=@zelari/core` (publish.yml "Run tests (core)") runs
// vitest with cwd=packages/core, where the ROOT vitest.config.ts does not
// apply. Without the same reliability caps the process-heavy Git/SQLite-worker
// suites flake on CI runners: at v2.41.0 this step failed while the very same
// tests passed in the root suite of the same commit (and at v2.40.0 the
// uncapped run got lucky). Mirror the root contract so both entry points run
// core tests under identical conditions.
export default defineConfig({
  test: {
    maxWorkers: '50%',
    setupFiles: ['../../tests/setup/jailModeDefault.ts'],
  },
});
