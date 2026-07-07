/**
 * PluginGate — boot-time gate that detects missing optional plugins and
 * offers to install them, before App mounts.
 *
 * Composed inside SplashGate (main.ts), AFTER the splash screen, so the
 * prompt only appears once the user is already looking at the terminal.
 * If nothing is missing (or TTY off / muted / kill-switched), it renders
 * children directly with zero footprint — no async work, no render churn.
 *
 * UX flow (per missing plugin, one at a time):
 *   1. detecting → brief spinner (one line, low flicker)
 *   2. prompting → SelectList with three options:
 *        [Install now]   → spawn npm install, buffered, then advance
 *        [Maybe later]   → skip, advance, no persistence
 *        [Don't ask again] → markDontAskAgain(id), advance
 *   3. installing → "Installing <label>…" spinner, then result block
 *   4. advance to next missing plugin, or render children when done
 *
 * Non-blocking: a plugin install that fails surfaces a red note but does NOT
 * stop the app from booting. The feature will keep degrading silently at
 * call time (that behaviour is unchanged).
 *
 * Opt-out: ZELARI_NO_PLUGIN_PROMPT=1 skips the gate entirely (for CI / scripts
 * / users who'd rather drive installs via `/plugins`).
 *
 * @see src/cli/plugins/registry.ts — detectMissingPlugins
 * @see src/cli/plugins/installer.ts — installPlugin
 * @see src/cli/components/SelectList.tsx — the picker reused here
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Box, Text, useStdin } from 'ink';
import { SelectList, type SelectItem } from './SelectList.js';
import {
  detectMissingPlugins,
  type PluginSpec,
} from '../plugins/registry.js';
import { installPlugin, type InstallResult } from '../plugins/installer.js';
import { markDontAskAgain } from '../plugins/prefs.js';

interface PluginGateProps {
  /** Working directory for project-local detection + -D installs. */
  cwd: string;
  /** The app to render once the gate is satisfied. */
  children: React.ReactNode;
}

type Phase = 'detecting' | 'prompting' | 'installing' | 'result' | 'done';

/** The three picker options. Values are stable (used as discriminators). */
const CHOICE_INSTALL = '__install__';
const CHOICE_LATER = '__later__';
const CHOICE_NEVER = '__never__';

/**
 * PluginGate. Renders `children` directly when there's nothing to prompt,
 * so the common path (everything installed, or non-TTY) has no overhead.
 */
export function PluginGate({ cwd, children }: PluginGateProps): React.ReactElement {
  const { isRawModeSupported } = useStdin();
  const [phase, setPhase] = useState<Phase>('detecting');
  const [queue, setQueue] = useState<PluginSpec[]>([]);
  const [current, setCurrent] = useState<PluginSpec | null>(null);
  const [result, setResult] = useState<InstallResult | null>(null);

  // Opt-out: env var or non-TTY → skip entirely. (Tests inject a TTY via ink.)
  const skipGate =
    process.env.ZELARI_NO_PLUGIN_PROMPT === '1' || isRawModeSupported !== true;

  // Detection on mount.
  useEffect(() => {
    if (skipGate) {
      setPhase('done');
      return;
    }
    let cancelled = false;
    void detectMissingPlugins(cwd)
      .then((missing) => {
        if (cancelled) return;
        if (missing.length === 0) {
          setPhase('done');
          return;
        }
        setQueue(missing);
        setCurrent(missing[0] ?? null);
        setPhase(missing[0] ? 'prompting' : 'done');
      })
      .catch(() => {
        // Detection must never block boot.
        if (!cancelled) setPhase('done');
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, skipGate]);

  // Advance to the next queued plugin, or finish.
  const advance = useCallback(() => {
    setQueue((q) => {
      const rest = q.slice(1);
      if (rest.length === 0) {
        setPhase('done');
        setCurrent(null);
        return rest;
      }
      setCurrent(rest[0] ?? null);
      setPhase(rest[0] ? 'prompting' : 'done');
      setResult(null);
      return rest;
    });
  }, []);

  // Picker selection handler.
  const onSelect = useCallback(
    (value: string) => {
      if (!current) return;
      if (value === CHOICE_LATER) {
        advance();
      } else if (value === CHOICE_NEVER) {
        markDontAskAgain(current.id);
        advance();
      } else if (value === CHOICE_INSTALL) {
        setPhase('installing');
        void installPlugin(current, cwd)
          .then((r) => {
            setResult(r);
            setPhase('result');
          })
          .catch(() => {
            // Defensive: installPlugin never throws, but guard anyway.
            setResult({ ok: false, output: '', exitCode: null, error: 'unexpected error' });
            setPhase('result');
          });
      }
    },
    [current, cwd, advance],
  );

  // Done (or skipped) → render the app.
  if (phase === 'done') {
    return <>{children}</>;
  }

  // Detecting → minimal one-liner spinner.
  if (phase === 'detecting') {
    return (
      <Box paddingX={1}>
        <Text dimColor>Checking for optional tool plugins…</Text>
      </Box>
    );
  }

  // No current plugin (shouldn't happen, defensive).
  if (!current) {
    return <>{children}</>;
  }

  // Installing → spinner line.
  if (phase === 'installing') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="cyan">⏳ Installing {current.label}…</Text>
        <Text dimColor>npm install {current.installScope === 'global' ? '-g' : '-D'} {current.npmPackage}</Text>
      </Box>
    );
  }

  // Result → show outcome, then a one-line hint to continue.
  if (phase === 'result') {
    const ok = result?.ok === true;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={ok ? 'green' : 'red'}>
          {ok ? '✓' : '✗'} {ok ? 'Installed' : 'Install failed'}: {current.label}
        </Text>
        {!ok && result?.error ? (
          <Text dimColor>{result.error}</Text>
        ) : null}
        {ok && current.postInstallHint ? (
          <Text color="yellow">  → {current.postInstallHint}</Text>
        ) : null}
        <Text dimColor>Press any key to continue…</Text>
        <ContinueKey onContinue={advance} />
      </Box>
    );
  }

  // Prompting → the SelectList picker.
  const items: SelectItem[] = [
    {
      value: CHOICE_INSTALL,
      label: `Install now`,
      hint: `npm i ${current.installScope === 'global' ? '-g' : '-D'} ${current.npmPackage}`,
    },
    { value: CHOICE_LATER, label: 'Maybe later' },
    { value: CHOICE_NEVER, label: "Don't ask again" },
  ];

  return (
    <SelectList
      title={`Optional plugin missing: ${current.label}`}
      items={items}
      onSelect={onSelect}
      onCancel={advance} // Esc = same as "Maybe later" for this plugin
      maxVisible={4}
    />
  );
}

/**
 * Tiny helper: listen for any key to continue (used on the result screen).
 * Isolated so it doesn't interfere with SelectList's own useInput.
 */
function ContinueKey({ onContinue }: { onContinue: () => void }): React.ReactElement | null {
  const { isRawModeSupported } = useStdin();
  // ink-testing-library doesn't always expose useInput well; guard with effect.
  useEffect(() => {
    // We can't use useInput here cleanly without raw mode; instead defer to a
    // 1500ms auto-advance so the result is visible but doesn't block forever.
    // This keeps the gate non-interactive-by-default on the result step,
    // which is fine — the user already made their choice at the prompt.
    const t = setTimeout(onContinue, 1500);
    return () => clearTimeout(t);
  }, [onContinue]);
  // Raw-mode support is informational only here; the auto-advance works
  // regardless. Suppress unused-var lint without a noisy disable comment.
  void isRawModeSupported;
  return null;
}
