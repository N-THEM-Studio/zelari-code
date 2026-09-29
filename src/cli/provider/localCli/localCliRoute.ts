/**
 * localCliRoute - the local-CLI vs API-key decision for one turn.
 *
 * Deliberately dependency-free. Both hosts need it (`headless.ts` and the
 * TUI `useChatTurn` hook) and neither should have to import the other's
 * entry module to get it: `headless.ts` pulls in keyStore, StatusBar and
 * sessionControl, and a TUI hook importing the CLI entry makes the module
 * graph untestable and the turn path heavier for nothing.
 *
 * This module must stay free of imports so it can be loaded by either side
 * without dragging a graph behind it.
 */

export type LocalCliRoute =
  | { kind: 'env-override'; cli: string; providerId: 'local-cli' }
  | { kind: 'claude-code'; cli: 'claude'; providerId: 'claudeCode'; model?: string }
  | { kind: 'api-key' };

/**
 * `ZELARI_LOCAL_CLI` always wins and keeps the historical label `local-cli`.
 * The picker id `claudeCode` spawns the official `claude` binary but does not
 * rewrite the provider id, so logs show what was selected.
 *
 * `providerId` is only read when there is no env override, so a caller that
 * cannot cheaply resolve the active provider can skip that work entirely.
 */
export function decideLocalCliRoute(input: {
  providerId: string;
  /** Raw `ZELARI_LOCAL_CLI` value. Unset or blank = no override. */
  localCliEnv?: string | null;
  model?: string;
}): LocalCliRoute {
  const localCli = (input.localCliEnv ?? '').trim();
  if (localCli) {
    return { kind: 'env-override', cli: localCli, providerId: 'local-cli' };
  }
  if (input.providerId === 'claudeCode') {
    return {
      kind: 'claude-code',
      cli: 'claude',
      providerId: 'claudeCode',
      ...(input.model !== undefined ? { model: input.model } : {}),
    };
  }
  return { kind: 'api-key' };
}

/**
 * True when the turn cannot need a provider route, so the caller can skip
 * resolving the active provider (and the config reads behind it) entirely.
 */
export function needsLocalCliRoute(localCliEnv?: string | null): boolean {
  return (localCliEnv ?? '').trim().length === 0;
}
