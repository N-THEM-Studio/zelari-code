/**
 * runWizard — runs the wizard as a self-contained Ink app, then
 * transparently transitions into the regular App once commit() runs.
 *
 * No process.exit — the same Ink root remains mounted; only the child
 * component changes. This avoids the bad UX of "wizard runs, CLI
 * exits, user has to re-launch" while still honouring the user's
 * decision end-to-end (provider config + api key + model are all
 * persisted before the transition).
 *
 * @public
 * @since 0.5.0
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useInput } from 'ink';
// @ts-ignore — app.tsx is .tsx, esbuild-bundled.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
import { App } from '../app.js';
import { PROVIDERS } from '../keyStore.js';
import { getModelForProvider } from '../providerConfig.js';
import { Wizard } from './index.js';
import { createWizardState } from './useWizardState.js';

export interface RunWizardProps {
  /** Optional initial state override (used by tests). */
  initialProviderId?: string;
}

export function RunWizard(_props: RunWizardProps): React.ReactElement {
  const [wiz] = useState(() =>
    createWizardState({
      providers: PROVIDERS,
      defaultModelFor: (id) => getModelForProvider(id),
    }),
  );
  const [, force] = useState(0);

  // Force re-render when state machine changes (subscribe pattern).
  useEffect(() => {
    if (typeof (wiz as unknown as { subscribe?: (l: () => void) => () => void }).subscribe === 'function') {
      const sub = (wiz as unknown as { subscribe: (l: () => void) => () => void }).subscribe(() => force((n) => n + 1));
      return () => sub();
    }
    return undefined;
  }, [wiz]);

  useInput((input, key) => {
    // Once committed, App takes over. Don't intercept input here
    // (App's own useInput handlers manage keyboard from this point).
    if (wiz.state.committed) return;
    const s = wiz.state;

    if (key.escape) {
      process.exit(0);
    }
    // 'q' quits from any step (not just welcome).
    if (input === 'q') {
      process.exit(0);
    }

    if (s.step === 'welcome') {
      if (key.return) {
        (wiz as unknown as { jumpToProvider(): void }).jumpToProvider();
      }
      return;
    }

    if (s.step === 'provider') {
      if (key.upArrow) wiz.moveProvider(true);
      else if (key.downArrow) wiz.moveProvider(false);
      else if (key.return) wiz.selectProvider();
      return;
    }

    if (s.step === 'model') {
      if (key.return) {
        // If model is empty, fall back to the default for the
        // currently selected provider. If provider is also unset,
        // just no-op (shouldn't happen in normal flow).
        if (s.model && s.model.trim().length > 0) {
          (wiz as unknown as { advanceToApikey(): void })?.advanceToApikey?.();
        } else if (s.providerId) {
          // Re-seed the default and advance.
          wiz.setModel(getModelForProvider(s.providerId));
          (wiz as unknown as { advanceToApikey(): void })?.advanceToApikey?.();
        }
        return;
      }
      if (key.backspace || key.delete) {
        const m = (s.model ?? '').slice(0, -1);
        wiz.setModel(m);
        return;
      }
      if (input && input.length === 1 && !key.ctrl) {
        wiz.setModel((s.model ?? '') + input);
      }
      return;
    }

    if (s.step === 'apikey') {
      if (key.upArrow) wiz.moveApiKey(true);
      else if (key.downArrow) wiz.moveApiKey(false);
      else if (key.return) {
        const choice = (['env', 'keystore', 'skip'] as const)[s.apiKeyCursor];
        wiz.selectApiKey(choice);
      }
      return;
    }

    if (s.step === 'confirm') {
      if (key.return) wiz.commit();
      else if (input === 'b' || input === 'B') wiz.back();
      return;
    }
  });

  // ── Transition: wizard committed → swap to App in same Ink tree ──
  if (wiz.state.committed) {
    // Show a brief "✓ Setup complete" banner for ~1.2s, then mount App.
    // This gives the user a moment to read what was saved.
    return <PostCommitBridge />;
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Wizard state={wiz} providers={PROVIDERS} />
    </Box>
  );
}

/**
 * PostCommitBridge — short banner shown after commit() succeeds, then
 * fades into <App>. Uses internal state to time the transition.
 */
function PostCommitBridge(): React.ReactElement {
  const [showApp, setShowApp] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowApp(true), 1200);
    return () => clearTimeout(t);
  }, []);

  if (showApp) {
    return <App />;
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box borderStyle="round" borderColor="green" paddingX={2} paddingY={1} flexDirection="column">
        <Text color="green" bold>
          ✓ Setup complete! Launching zelari-code…
        </Text>
        <Text color="gray">Press Ctrl+C any time to exit.</Text>
      </Box>
    </Box>
  );
}
