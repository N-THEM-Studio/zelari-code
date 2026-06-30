/**
 * Ambient type declarations for the CLI build.
 *
 * The CLI shares TypeScript code with the Electron GUI (src/lib/glm.ts,
 * src/lib/minimax.ts, src/agents/council.ts). These files use runtime
 * guards like `typeof window !== 'undefined'` to branch between Electron
 * renderer (window.electronAPI) and Node.js (process.env) contexts.
 *
 * For the CLI build, `window` and `import.meta.env` may exist as types
 * but lack the custom `electronAPI` augmentation. This file declares
 * them as ambient so the CLI compiles cleanly WITHOUT modifying the
 * shared source files.
 */

declare global {
  /**
   * The Electron renderer exposes `window.electronAPI` (via preload.ts)
   * with an arbitrary shape — chat/onChunk/onDone/abort/storage/rag/etc.
   * The CLI never runs in a renderer context, so this is always undefined
   * at runtime. Declared as `any` here so shared source code (src/lib/*,
   * src/agents/council.ts) compiles cleanly in the CLI build WITHOUT
   * requiring us to redefine the full GUI surface.
   *
   * Runtime safety is preserved by the existing
   * `typeof window !== 'undefined'` guards in those files.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window {
    electronAPI?: any;
    // File System Access API proposal (not in TS DOM lib but used by Electron renderer)
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