/**
 * automations/channels/website.ts — the website webhook channel (F3.3).
 *
 * NO BROWSER: a pure HTTP POST to a user-owned endpoint, authenticated with an
 * HMAC-SHA256 signature over the RAW JSON body. The registry resolves this
 * adapter in `publishMode: 'browser'` (the mode simply means "real delivery, not
 * dry-run"; for `website` that is an HTTP call, not a headless browser) and the
 * F2 dry-run adapter in `'dry-run'` — unchanged.
 *
 *   POST <endpoint>
 *   Content-Type: application/json
 *   X-Zelari-Signature: sha256=<hmacHex(body, secret)>
 *   X-Zelari-Timestamp: <epoch-ms>
 *   { "text": "...", "media"?: [...], "source": "zelari-code automation", "automationId"?: "..." }
 *
 * A publish is ok ONLY when the response carries a `url` (or a `pageUrl` is
 * configured) — it is never fabricated (P1). Config comes from the vault
 * (~/.zelari-code/channels/website.json via ./vault.ts) with an env fallback.
 * Secrets never appear in the result, the run JSON, or the logs.
 */
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { ChannelAdapter, ChannelPublishInput, ChannelPublishResult } from './types.js';
import { loadVault } from './vault.js';

/** The channel id this adapter serves. */
export const WEBSITE_CHANNEL = 'website';
/** Provenance stamped on every webhook body. */
export const SOURCE_LABEL = 'zelari-code automation';
/** Request timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Signature header carrying `sha256=<hmacHex>`. */
export const SIGNATURE_HEADER = 'X-Zelari-Signature';
/** Timestamp header (epoch-ms) — helps the receiver bound replay. */
export const TIMESTAMP_HEADER = 'X-Zelari-Timestamp';
/** Env fallbacks when the vault is absent. */
export const ENV_URL = 'ZELARI_WEBSITE_WEBHOOK_URL';
export const ENV_SECRET = 'ZELARI_WEBSITE_WEBHOOK_SECRET';

/** Stored config: endpoint + secret required; pageUrl optional (fallback evidence). */
export const WebsiteConfigSchema = z.object({
  endpoint: z.string().min(1),
  secret: z.string().min(1),
  /** Page/landing URL used as the evidence url when the webhook omits one. */
  pageUrl: z.string().min(1).optional(),
});
export type WebsiteConfig = z.infer<typeof WebsiteConfigSchema>;

/** Webhook response body we understand (extra fields are ignored). */
export const WebsiteResponseSchema = z.object({
  url: z.string().optional(),
  postId: z.string().optional(),
});

/** Thrown on any website publish failure; the message is safe to show. */
export class WebsitePublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebsitePublishError';
  }
}

/** Validate a config: endpoint must be https, secret present. Returns an error list. */
export function validateConfig(cfg: Partial<WebsiteConfig> | null | undefined): string[] {
  const errors: string[] = [];
  if (!cfg || !cfg.endpoint) errors.push('endpoint is required');
  else if (!/^https:\/\//i.test(cfg.endpoint)) errors.push('endpoint must be an https:// URL');
  if (!cfg?.secret) errors.push('secret is required');
  return errors;
}

/** Deterministic signature header value: `sha256=<hmacHex(body, secret)>`. */
export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf-8').digest('hex')}`;
}

/** Mask a secret for display: `abcd…wxyz`, or `****` when too short to split. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

export interface LoadConfigDeps {
  /** Vault loader seam (default: ./vault.ts `loadVault`). */
  loadVaultFn?: (channel: string) => Promise<unknown | null>;
  /** Env source seam (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

/** Best-effort parse of the raw vault value; null when absent/incomplete. */
function parseVault(raw: unknown): WebsiteConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = WebsiteConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Resolve the website config from the vault, falling back to env. Throws a
 * clear, actionable error (never the secret) when the config is incomplete.
 */
export async function loadWebsiteConfig(deps: LoadConfigDeps = {}): Promise<WebsiteConfig> {
  const env = deps.env ?? process.env;
  const raw = await (deps.loadVaultFn ?? loadVault)(WEBSITE_CHANNEL);
  const vaultCfg = parseVault(raw);
  const cfg: Partial<WebsiteConfig> = {
    endpoint: vaultCfg?.endpoint ?? env[ENV_URL]?.trim(),
    secret: vaultCfg?.secret ?? env[ENV_SECRET]?.trim(),
    pageUrl: vaultCfg?.pageUrl,
  };
  const errors = validateConfig(cfg);
  if (errors.length) {
    throw new WebsitePublishError(
      `${errors.join('; ')}. Configure with: ` +
        `\`zelari-code automation credential website --endpoint <https-url>\` ` +
        `(secret via --secret or ${ENV_SECRET}); or set ${ENV_URL} + ${ENV_SECRET}.`,
    );
  }
  return cfg as WebsiteConfig;
}

/** Injectable seams (tests supply a fake fetch; prod uses global fetch). */
export interface WebsiteAdapterDeps {
  /** Pre-resolved config (skips the vault/env lookup when provided). */
  config?: WebsiteConfig;
  runId?: string;
  automationId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * Build the website webhook adapter implementing the ChannelAdapter seam.
 * Pure fetch — never opens a browser.
 */
export function createWebsiteChannelAdapter(deps: WebsiteAdapterDeps = {}): ChannelAdapter {
  return {
    id: WEBSITE_CHANNEL,
    async publish(input: ChannelPublishInput): Promise<ChannelPublishResult> {
      const config = deps.config ?? (await loadWebsiteConfig());
      const errors = validateConfig(config);
      if (errors.length) throw new WebsitePublishError(errors.join('; '));
      const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
      if (typeof fetchImpl !== 'function') {
        throw new WebsitePublishError('no fetch implementation available (Node < 18?)');
      }

      const bodyObj: Record<string, unknown> = { text: input.text, source: SOURCE_LABEL };
      if (input.mediaPaths && input.mediaPaths.length > 0) bodyObj.media = input.mediaPaths;
      if (deps.automationId) bodyObj.automationId = deps.automationId;
      const body = JSON.stringify(bodyObj);
      const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(config.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [SIGNATURE_HEADER]: signBody(body, config.secret),
            [TIMESTAMP_HEADER]: String(Date.now()),
          },
          body,
          signal: controller.signal,
        });
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        const reason = aborted ? `timeout after ${timeoutMs}ms` : e instanceof Error ? e.message : String(e);
        throw new WebsitePublishError(`website webhook request failed: ${reason}`);
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        throw new WebsitePublishError(`website webhook returned HTTP ${res.status}`);
      }

      let json: unknown = {};
      try {
        json = await res.json();
      } catch {
        json = {};
      }
      const parsed = WebsiteResponseSchema.safeParse(json);
      const response = parsed.success ? parsed.data : {};
      const url = response.url ?? config.pageUrl;
      if (!url) {
        throw new WebsitePublishError(
          'website webhook response carried no url (and no pageUrl configured) — refusing to fabricate one',
        );
      }
      const result: ChannelPublishResult = {
        postId: response.postId ?? url,
        url,
        dryRun: false,
      };
      (deps.log ?? (() => undefined))(`[website] posted ${result.url}`);
      return result;
    },
  };
}
