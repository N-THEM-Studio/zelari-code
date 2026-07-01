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
export function useTerminalSize(options: TerminalSizeOptions = {}): TerminalSize {
  const { defaults = { columns: 80, rows: 24 }, coalesceMs = 16 } = options;
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
    setSize({
      columns: stdout.columns ?? defaults.columns,
      rows: stdout.rows ?? defaults.rows,
    });
    let rafId: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      if (coalesceMs <= 0) {
        setSize({
          columns: stdout.columns ?? defaults.columns,
          rows: stdout.rows ?? defaults.rows,
        });
        return;
      }
      if (rafId !== null) clearTimeout(rafId);
      rafId = setTimeout(() => {
        setSize({
          columns: stdout.columns ?? defaults.columns,
          rows: stdout.rows ?? defaults.rows,
        });
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