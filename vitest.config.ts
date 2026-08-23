import { defineConfig } from 'vitest/config';

// Keep process-heavy Git, SQLite-worker, and Tauri-adjacent suites reliable on
// developer machines and CI runners without weakening individual timeouts.
export default defineConfig({
  test: {
    maxWorkers: '50%',
  },
});
