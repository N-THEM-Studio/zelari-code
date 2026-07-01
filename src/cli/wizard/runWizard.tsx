/**
 * runWizard — runs the wizard as a self-contained Ink app.
 *
 * After commit() runs successfully, this returns so main.ts can mount
 * the regular App on top. During the wizard, useInput routes keyboard
 * input to the state machine.
 *
 * @public
 * @since 0.5.0
 */
import React, { useEffect, useState } from 'react';
import { Box } from 'ink';
import { useInput } from 'ink';
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

  // When committed, quit cleanly so App can mount.
  useEffect(() => {
    if (wiz.state.committed) {
      const t = setTimeout(() => process.exit(0), 250);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [wiz.state.committed]);

  useInput((input, key) => {
    if (wiz.state.committed) return;
    const s = wiz.state;

    if (key.escape || (input === 'q' && s.step === 'welcome')) {
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
        // Commit current model and advance.
        if (s.model && s.model.trim().length > 0) {
          (wiz as unknown as { advanceToApikey(): void })?.advanceToApikey?.();
        }
        return;
      }
      if (key.backspace || key.delete) {
        const m = (s.model ?? '').slice(0, -1);
        wiz.setModel(m);
        return;
      }
      // Append printable char.
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

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Wizard state={wiz} providers={PROVIDERS} />
    </Box>
  );
}
