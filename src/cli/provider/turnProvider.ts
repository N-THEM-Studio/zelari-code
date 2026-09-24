/**
 * turnProvider — the provider/model the CURRENT turn runs on.
 *
 * Auxiliary calls inside a turn (semantic/memory embeddings, the verdict
 * re-ask, the weakness meter, kraken_select's parent identity, the tentacle
 * factory fallback) used to resolve the PERSISTED active provider
 * (provider.json). A Desktop user who only ever picks a model in the Desktop
 * selector keeps the built-in default there — `openai-compatible`, whose
 * default base URL is api.x.ai with `grok-4.6` — so those calls went to xAI
 * with whatever credential matched, surfacing as random HTTP 401/404 errors
 * from a provider the user never selected.
 *
 * `dispatchHeadlessTurn` publishes the turn's resolved identity here and
 * `providerFromEnv()` prefers it. Per harness session in `--serve-harness`
 * (sessionScope), so concurrent chats on different providers never see each
 * other's; unset in the TUI, where the active provider IS the selection.
 */
import { sessionLocal } from '../sessionScope.js';

export interface TurnProviderIdentity {
  provider: string;
  model: string;
}

const current = sessionLocal<TurnProviderIdentity | undefined>(() => undefined);

export function setTurnProvider(identity: TurnProviderIdentity | undefined): void {
  current.set(identity);
}

export function turnProvider(): TurnProviderIdentity | undefined {
  return current.get();
}
