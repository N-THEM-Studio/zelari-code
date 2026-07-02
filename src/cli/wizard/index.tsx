/**
 * Wizard — Ink UI for first-run onboarding.
 *
 * Renders the step machine from `useWizardState`. Keyboard handling is
 * done at the App level (via useInput in main.tsx) — this component is
 * "dumb" and just renders the current state.
 *
 * Steps:
 *   1. welcome: title + intro text + "Press Enter to begin"
 *   2. provider: list of PROVIDERS with arrow cursor
 *   3. model: read model name from input (or accept default)
 *   4. apikey: choose env/keystore/skip
 *   5. confirm: review + "Press Enter to commit, B to go back"
 *
 * Used in `main.tsx` instead of `<App>` when `shouldRunWizard()` is true.
 *
 * @public
 * @since 0.5.0
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { ProviderSpec } from '../keyStore.js';
import {
  API_KEY_OPTIONS,
  type ApiKeyChoice,
  type UseWizardStateApi,
} from './useWizardState.js';

export interface WizardProps {
  state: UseWizardStateApi;
  providers: readonly ProviderSpec[];
}

const VERSION = '0.7.0';

function Frame({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      {children}
    </Box>
  );
}

function Step(props: { index: number; total: number; name: string; active: boolean }): React.ReactElement {
  return (
    <Box>
      <Text color={props.active ? 'cyan' : 'gray'} inverse={props.active}>
        {' '}
        {props.index}/{props.total} {props.name}{' '}
      </Text>
    </Box>
  );
}

function renderProviderList(
  providers: readonly ProviderSpec[],
  cursor: number,
): React.ReactElement {
  return (
    <Box flexDirection="column">
      {providers.map((p, i) => {
        const arrow = i === cursor ? '➜ ' : '  ';
        const color = i === cursor ? 'cyan' : undefined;
        return (
          <Text key={p.id} color={color}>
            {arrow}
            {p.displayName} <Text color="gray">({p.id}, uses env {p.envVar})</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function renderApiKeyOptions(cursor: number): React.ReactElement {
  const labels: Record<ApiKeyChoice, string> = {
    env: 'Use env var (recommended — safe)',
    keystore: 'Save to local keyStore (encrypted)',
    skip: 'Skip for now (chat will fail until key is set)',
  };
  return (
    <Box flexDirection="column">
      {API_KEY_OPTIONS.map((choice, i) => {
        const arrow = i === cursor ? '➜ ' : '  ';
        const color = i === cursor ? 'cyan' : undefined;
        return (
          <Text key={choice} color={color}>
            {arrow}
            {labels[choice]}
          </Text>
        );
      })}
    </Box>
  );
}

export function Wizard({ state, providers }: WizardProps): React.ReactElement {
  const s = state.state;

  if (s.committed) {
    return (
      <Frame>
        <Text color="green">✓ Setup complete!</Text>
        <Text>
          Provider: <Text color="cyan">{s.providerId}</Text>
          {' | '}Model: <Text color="cyan">{s.model}</Text>
          {' | '}API key: <Text color="cyan">{s.apiKeyChoice ?? 'n/a'}</Text>
        </Text>
        <Box marginTop={1}>
          <Text color="gray">Launching zelari-code… (press any key)</Text>
        </Box>
      </Frame>
    );
  }

  return (
    <Frame>
      <Text color="cyan" bold>
        zelari-code v{VERSION} — first-time setup
      </Text>
      <Box marginTop={1} marginBottom={1} flexDirection="row">
        <Step index={1} total={5} name="welcome" active={s.step === 'welcome'} />
        <Step index={2} total={5} name="provider" active={s.step === 'provider'} />
        <Step index={3} total={5} name="model" active={s.step === 'model'} />
        <Step index={4} total={5} name="apikey" active={s.step === 'apikey'} />
        <Step index={5} total={5} name="confirm" active={s.step === 'confirm'} />
      </Box>

      {s.step === 'welcome' && (
        <>
          <Text>Welcome! Let's get you coding in under two minutes.</Text>
          <Text color="gray">
            We'll pick a provider, default model, and how to handle your API key.
          </Text>
          <Box marginTop={1}>
            <Text>Press </Text>
            <Text color="cyan" inverse> Enter </Text>
            <Text> to continue, or </Text>
            <Text color="red" inverse> Q </Text>
            <Text> to quit (re-run with </Text>
            <Text color="gray">--no-wizard</Text>
            <Text> to skip later).</Text>
          </Box>
        </>
      )}

      {s.step === 'provider' && (
        <>
          <Text>Choose your LLM provider:</Text>
          <Box marginTop={1}>
            {renderProviderList(providers, s.providerCursor)}
          </Box>
          <Box marginTop={1}>
            <Text color="gray">↑/↓ to move, Enter to confirm</Text>
          </Box>
        </>
      )}

      {s.step === 'model' && (
        <>
          <Text>
            Model for <Text color="cyan">{s.providerId}</Text>:
          </Text>
          <Box marginTop={1} borderStyle="single" borderColor="cyan" paddingX={1}>
            <Text>{s.model ?? '(empty)'}</Text>
          </Box>
          <Box marginTop={1}>
            <Text>
              Press <Text color="cyan" inverse> Enter </Text>
              to accept, or type a new name. <Text color="gray">(default kept on empty input)</Text>
            </Text>
          </Box>
        </>
      )}

      {s.step === 'apikey' && (
        <>
          <Text>How should we handle the API key?</Text>
          <Box marginTop={1}>
            {renderApiKeyOptions(s.apiKeyCursor)}
          </Box>
          <Box marginTop={1}>
            <Text color="gray">↑/↓ to move, Enter to confirm</Text>
          </Box>
        </>
      )}

      {s.step === 'confirm' && (
        <>
          <Text>Confirm your setup:</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              Provider: <Text color="cyan">{s.providerId}</Text>
            </Text>
            <Text>
              Model:    <Text color="cyan">{s.model}</Text>
            </Text>
            <Text>
              API key:  <Text color="cyan">{s.apiKeyChoice ?? '(unset)'}</Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text>
              Press <Text color="green" inverse> Enter </Text>
              to save and launch, or <Text color="yellow" inverse> B </Text>
              to go back.
            </Text>
          </Box>
        </>
      )}
    </Frame>
  );
}
