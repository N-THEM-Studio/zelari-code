/**
 * useWizardState — pure state machine for the wizard flow.
 *
 * Decoupled from Ink/React so it's trivially testable. The Ink UI
 * component imports this and renders the current step; selection
 * logic lives here.
 *
 * Steps:
 *   1. welcome        → informational, [Enter] to continue, [Q] to quit
 *   2. provider       → choose from PROVIDERS list (arrow keys + Enter)
 *   3. model          → choose default or type custom
 *   4. apikey         → "use env var" / "save to keyStore" / "skip for now"
 *   5. confirm        → review + commit (writes provider config + key)
 *
 * @public
 * @since 0.5.0
 */
import type { ProviderName, ProviderSpec } from '../keyStore.js';
import {
  setActiveProviderId,
  setModelForProvider,
} from '../providerConfig.js';

/** Step identifier — used as the discriminator for `state.step`. */
export type WizardStep = 'welcome' | 'provider' | 'model' | 'apikey' | 'confirm';

/** Key handling policy for the apikey step. */
export type ApiKeyChoice = 'env' | 'keystore' | 'skip';

export interface WizardState {
  step: WizardStep;
  /** Currently selected provider id (only meaningful from step 2+). */
  providerId?: ProviderName;
  /** Currently edited/selected model name. */
  model?: string;
  /** Api-key handling decision (only set after step 4). */
  apiKeyChoice?: ApiKeyChoice;
  /** Api-key value to persist if apiKeyChoice === 'keystore'. */
  apiKeyValue?: string;
  /** Index into the provider list during step 2 selection. */
  providerCursor: number;
  /** Index into the apiKey options during step 4. */
  apiKeyCursor: number;
  /** True once `commit()` has run successfully (terminal state). */
  committed: boolean;
}

export interface UseWizardStateOptions {
  /** Predefined providers to choose from (matches keyStore.PROVIDERS). */
  providers: readonly ProviderSpec[];
  /** Default model for a given provider (falls back if missing). */
  defaultModelFor: (id: ProviderName) => string;
  /** Optional persistence callbacks — defaults write to provider.json. */
  persistActiveProvider?: (id: ProviderName) => void;
  persistModel?: (id: ProviderName, model: string) => void;
}

export interface UseWizardStateApi {
  state: WizardState;
  /** Move provider cursor up (`true`) / down (`false`). */
  moveProvider: (up: boolean) => void;
  /** Confirm the currently selected provider (advances step). */
  selectProvider: () => void;
  /** Move apikey cursor up/down. */
  moveApiKey: (up: boolean) => void;
  /** Confirm the currently selected apiKey option. */
  selectApiKey: (choice: ApiKeyChoice, value?: string) => void;
  /** Set or override the model name. */
  setModel: (name: string) => void;
  /** Go back one step (no-op at step 1). */
  back: () => void;
  /** Persist the chosen config. Idempotent. */
  commit: () => void;
}

const ORDER: WizardStep[] = ['welcome', 'provider', 'model', 'apikey', 'confirm'];

function next(s: WizardStep): WizardStep | null {
  const idx = ORDER.indexOf(s);
  if (idx === -1 || idx === ORDER.length - 1) return null;
  return ORDER[idx + 1];
}

function prev(s: WizardStep): WizardStep | null {
  const idx = ORDER.indexOf(s);
  if (idx <= 0) return null;
  return ORDER[idx - 1];
}

/**
 * Pure-function factory for the wizard state machine. Returned API is
 * stateless from the caller's perspective — pass the same instance to
 * React via `useMemo`.
 *
 * @public
 */
export function createWizardState(opts: UseWizardStateOptions): UseWizardStateApi {
  const persistActive = opts.persistActiveProvider ?? ((id) => setActiveProviderId(id));
  const persistModel = opts.persistModel ?? ((id, m) => setModelForProvider(id, m));

  let s: WizardState = {
    step: 'welcome',
    providerCursor: 0,
    apiKeyCursor: 0,
    committed: false,
  };
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const l of listeners) l();
  }

  const api: UseWizardStateApi = {
    get state() {
      return s;
    },
    moveProvider(up: boolean) {
      const n = opts.providers.length;
      const c = s.providerCursor;
      s = {
        ...s,
        providerCursor: up ? (c - 1 + n) % n : (c + 1) % n,
      };
      notify();
    },
    selectProvider() {
      const provider = opts.providers[s.providerCursor];
      if (!provider) return; // shouldn't happen
      s = {
        ...s,
        step: 'model',
        providerId: provider.id,
        model: opts.defaultModelFor(provider.id),
      };
      notify();
    },
    setModel(name: string) {
      const trimmed = name.trim();
      if (!trimmed || !s.providerId) return;
      s = { ...s, model: trimmed };
      notify();
    },
    moveApiKey(up: boolean) {
      const c = s.apiKeyCursor;
      // 3 options: 0=env, 1=keystore, 2=skip
      s = { ...s, apiKeyCursor: up ? (c - 1 + 3) % 3 : (c + 1) % 3 };
      notify();
    },
    selectApiKey(choice: ApiKeyChoice, value?: string) {
      s = {
        ...s,
        apiKeyChoice: choice,
        apiKeyValue: choice === 'keystore' ? (value ?? '').trim() : undefined,
        step: 'confirm',
      };
      notify();
    },
    back() {
      const p = prev(s.step);
      if (!p) return;
      s = { ...s, step: p };
      notify();
    },
    commit() {
      if (s.committed || !s.providerId || !s.model) return;
      persistActive(s.providerId);
      persistModel(s.providerId, s.model);
      s = { ...s, committed: true };
      notify();
    },
  };

  // Internal: allow React UI to re-render. We expose `subscribe` so the
  // Ink component can useSyncExternalStore (or call manually in tests).
  (api as unknown as { subscribe(l: () => void): () => void }).subscribe = (
    l: () => void,
  ) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };

  // Advance to first non-welcome step programmatically — used by tests
  // and by the "skip intro" flag (future).
  (api as unknown as { jumpToProvider(): void }).jumpToProvider = () => {
    s = { ...s, step: 'provider' };
    notify();
  };

  // Advance from model to apikey step (used by runWizard when user
  // confirms the model on step 3).
  (api as unknown as { advanceToApikey(): void }).advanceToApikey = () => {
    if (s.step === 'model') {
      s = { ...s, step: 'apikey' };
      notify();
    }
  };

  return api;
}

/** Convenience constants for tests + UI. */
export const API_KEY_OPTIONS: readonly ApiKeyChoice[] = ['env', 'keystore', 'skip'];
export const WIZARD_STEPS: readonly WizardStep[] = ORDER;
