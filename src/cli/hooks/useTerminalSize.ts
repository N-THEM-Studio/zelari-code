import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface TerminalSizeOptions {
  /** Defaults if stdout is not yet available. Default: { columns: 80, rows: 24 }. */
  defaults?: TerminalSize;
  /**
   * Coalescing window for resize events. Without this, fast terminal resizes
   * (e.g. user dragging a tmux pane border) fire 100+ resize events/sec,
   * causing the same number of full TUI redraws. Default: 16ms (~1 frame
   * at 60Hz). Set to 0 to disable coalescing.
   */
  coalesceMs?: number;
}

/**
 * useTerminalSize — reactive stdout dimensions.
 *
 * Returns the current terminal size and re-renders on resize events.
 * Coalesces bursts of resize events into a single state update per
 * animation frame so a fast drag doesn't trigger 100+ redraws.
 *
 * Extracted from app.tsx (Task v0.4.2 audit split) so it can be unit-tested
 * and reused by other components that care about dimensions (Sidebar,
 * ChatStream already take height/width as props).
 */
/**
 * Default coalescing window. 16ms was too short for Windows Terminal /
 * ConPTY resize storms: each intermediate size still triggered a full Ink
 * reflow of the dynamic region, which corrupt native scrollback (Static).
 * 120ms ≈ one deliberate drag pause and cuts redraws ~8×.
 */
const DEFAULT_COALESCE_MS = 120;

export function useTerminalSize(options: TerminalSizeOptions = {}): TerminalSize {
  const { defaults = { columns: 80, rows: 24 }, coalesceMs = DEFAULT_COALESCE_MS } = options;
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>({
    columns: stdout?.columns ?? defaults.columns,
    rows: stdout?.rows ?? defaults.rows,
  });

  useEffect(() => {
    if (!stdout) return;
    // v0.4.3 audit fix: if stdout resolves AFTER the initial render (e.g.
    // test bootstrap or some terminal wrappers), the size would stay at
    // the default 80x24 until the user manually resized. Pull the current
    // dimensions immediately when stdout becomes available.
    const read = (): TerminalSize => ({
      columns: stdout.columns ?? defaults.columns,
      rows: stdout.rows ?? defaults.rows,
    });
    // Only commit when dimensions actually change — Ink setState with an
    // identical size still re-renders the whole tree on Windows.
    const commit = (next: TerminalSize) => {
      setSize((prev) =>
        prev.columns === next.columns && prev.rows === next.rows ? prev : next,
      );
    };
    commit(read());
    let rafId: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      if (coalesceMs <= 0) {
        commit(read());
        return;
      }
      if (rafId !== null) clearTimeout(rafId);
      rafId = setTimeout(() => {
        commit(read());
        rafId = null;
      }, coalesceMs);
    };
    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
      if (rafId !== null) clearTimeout(rafId);
    };
  }, [stdout, defaults.columns, defaults.rows, coalesceMs]);

  return size;
}