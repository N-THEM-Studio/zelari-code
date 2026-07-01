/**
 * Ambient type declarations for the CLI build.
 *
 * The CLI is a Node-only standalone binary (no Electron). Shared source files
 * that historically branched between Electron renderer and Node contexts
 * (via `typeof window !== 'undefined'`) now compile cleanly without the
 * Electron `electronAPI` augmentation.
 *
 * This file declares ambient globals so the CLI typecheck passes without
 * redefining the (now-removed) GUI surface.
 */

declare global {
  interface Window {
    // File System Access API proposal (not in TS DOM lib but used by some
    // browser-targeted shared code; never invoked at runtime in the CLI).
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<{
      name: string;
      getDirectoryHandle?: (name: string, options?: { create?: boolean }) => Promise<unknown>;
    }>;
  }

  // Vite-style env injection (used by some renderer files via `import.meta.env`)
  interface ImportMeta {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env?: any;
  }
}

export {};