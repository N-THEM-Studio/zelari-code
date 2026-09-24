/**
 * configHealth — find (and optionally repair) stale provider configuration.
 *
 * Field report (2026-09-24): provider.json still said `grok / default-grok` —
 * a model id no provider serves — so every path that read the persisted
 * active provider hit HTTP 404, and the Desktop even listed the bogus id as a
 * valid choice. `--doctor` now says so, and `--doctor --fix` repairs what is
 * unambiguous (a saved model with evidence against it → that provider's
 * built-in default), after backing provider.json up.
 *
 * Evidence discipline (P1, observation integrity): a model missing from a
 * DISCOVERED list is evidence; missing from the static seed list is not
 * (the seed is short on purpose), except for an obvious placeholder id
 * (`default-…`). Unverifiable ids are reported as unverified, never "fixed".
 */

export type FindingLevel = 'ok' | 'warn' | 'info';

export interface ModelFix {
  provider: string;
  from: string;
  to: string;
}

export interface ConfigFinding {
  level: FindingLevel;
  message: string;
  fix?: ModelFix;
}

export interface SavedModelInput {
  provider: string;
  model: string;
  /** Ids from `--discover-models` (the provider's own /models); undefined = never discovered. */
  discovered?: string[];
  /** Base URL the discovered list was fetched from. */
  discoveredFrom?: string;
  /** Base URL the provider resolves to NOW (custom endpoint / env / default). */
  currentBaseUrl?: string;
  /** Built-in seed list for the provider (may be short or empty). */
  staticModels: string[];
  /** Built-in default model for the provider. */
  builtinDefault: string;
}

/** Placeholder-looking ids no provider serves (e.g. an old `default-grok` seed). */
const PLACEHOLDER_ID = /^(default|placeholder|model|none|unset)(-|$)/i;

export function checkSavedModel(input: SavedModelInput): ConfigFinding {
  const { provider, model, builtinDefault } = input;
  // A list discovered on ANOTHER server (the endpoint changed since) is not
  // evidence about the current one — treat it as never discovered.
  const norm = (u?: string) => (u ?? '').trim().replace(/\/+$/, '').toLowerCase();
  const staleDiscovery =
    Boolean(input.discoveredFrom && input.currentBaseUrl) &&
    norm(input.discoveredFrom) !== norm(input.currentBaseUrl);
  const discovered = staleDiscovery ? [] : (input.discovered?.filter(Boolean) ?? []);
  const known = discovered.length > 0 ? discovered : input.staticModels;
  const target = known.includes(builtinDefault) || known.length === 0 ? builtinDefault : known[0]!;

  if (!model.trim()) {
    return target
      ? { level: 'warn', message: `${provider}: no model saved`, fix: { provider, from: model, to: target } }
      : { level: 'warn', message: `${provider}: no model saved and no default known` };
  }
  if (known.includes(model)) return { level: 'ok', message: `${provider} / ${model}` };

  if (discovered.length > 0) {
    return {
      level: 'warn',
      message: `${provider}: saved model "${model}" is not in the provider's model list (${discovered.length} discovered)`,
      ...(target && target !== model ? { fix: { provider, from: model, to: target } } : {}),
    };
  }
  if (PLACEHOLDER_ID.test(model)) {
    return {
      level: 'warn',
      message: `${provider}: saved model "${model}" looks like a placeholder, not a real model id`,
      ...(target && target !== model ? { fix: { provider, from: model, to: target } } : {}),
    };
  }
  return {
    level: 'info',
    message: staleDiscovery
      ? `${provider} / ${model} — the saved model list is from another server (${input.discoveredFrom}); run \`zelari-code --discover-models --provider ${provider}\` to verify`
      : `${provider} / ${model} — not in the built-in list; run \`zelari-code --discover-models --provider ${provider}\` to verify`,
  };
}

export interface EndpointInput {
  provider: string;
  customEndpoint?: string | null;
  envBaseUrl?: string;
}

/** `openai-compatible` without an endpoint silently targets the legacy default (api.x.ai). */
export function checkEndpoint(input: EndpointInput): ConfigFinding {
  if (input.provider !== 'openai-compatible') return { level: 'ok', message: 'endpoint: provider default' };
  if (input.customEndpoint?.trim() || input.envBaseUrl?.trim()) {
    return { level: 'ok', message: `endpoint: ${input.customEndpoint?.trim() || input.envBaseUrl?.trim()}` };
  }
  return {
    level: 'warn',
    message:
      'openai-compatible has no server address and falls back to the legacy default https://api.x.ai/v1 — ' +
      'set yours with `/provider custom <url>` (or OPENAI_BASE_URL), or switch provider',
  };
}

/** Render a finding list as one doctor line. */
export function summarizeFindings(findings: ConfigFinding[]): { ok: boolean; message: string } {
  const problems = findings.filter((f) => f.level === 'warn');
  const infos = findings.filter((f) => f.level === 'info');
  if (problems.length === 0) {
    const okText = findings.filter((f) => f.level === 'ok').map((f) => f.message)[0] ?? 'provider config ok';
    return { ok: true, message: infos.length ? `${okText}\n${infos.map((f) => f.message).join('\n')}` : okText };
  }
  const fixable = problems.some((f) => f.fix);
  return {
    ok: false,
    message:
      [...problems, ...infos].map((f) => f.message).join('\n') +
      (fixable ? '\nFix: zelari-code --doctor --fix (backs up provider.json first)' : ''),
  };
}
