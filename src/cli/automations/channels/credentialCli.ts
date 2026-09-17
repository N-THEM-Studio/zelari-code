/**
 * automations/channels/credentialCli.ts — `automation credential <channel> …` (F3.3).
 *
 * Stores / lists / removes per-channel webhook credentials in the vault. Kept in
 * its own module so the cli.ts dispatch table stays lean. Prints through an
 * injected io seam and returns a numeric exit code (0 ok, 1 error). Never throws.
 */
import { loadVault, removeVault, saveVault } from './vault.js';
import { ENV_SECRET, maskSecret, validateConfig, WebsiteConfigSchema } from './website.js';

/** Value of `--name value` or `--name=value` (undefined when absent/empty). */
function optValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) {
      const v = argv[i + 1];
      return v && !v.startsWith('--') ? v : undefined;
    }
    if (a.startsWith(`${name}=`)) {
      const v = a.slice(name.length + 1);
      return v.length > 0 ? v : undefined;
    }
  }
  return undefined;
}

export interface CredentialIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Machine-readable `credential website --json` result (secret is ALWAYS masked). */
export interface CredentialJson {
  channel: 'website';
  /** true when a complete endpoint+secret pair is stored. */
  configured: boolean;
  endpoint?: string;
  /** Masked secret (`abcd…wxyz`) — never the raw value. */
  secret?: string;
  pageUrl?: string;
  /** Only set by `--remove`: whether anything was actually deleted. */
  removed?: boolean;
}

/**
 * Handle `automation credential website …`. Only `website` is supported today.
 * Human text is the default; `--json` swaps every success line for a single
 * machine-readable object on stdout (errors keep going to stderr, so the
 * Desktop IPC bridge surfaces the exit code + message unchanged).
 */
export async function runCredentialCommand(
  argv: readonly string[],
  io: CredentialIo,
): Promise<number> {
  const json = argv.includes('--json');
  const out = (payload: CredentialJson, human: string): void => {
    io.out(json ? JSON.stringify(payload) : human);
  };
  const at = argv.indexOf('credential');
  const channel = at >= 0 ? argv[at + 1] : undefined;
  if (channel !== 'website') {
    io.err(`[automation credential] unsupported channel: ${channel ?? '(missing)'} (supported: website)`);
    return 1;
  }
  if (argv.includes('--remove')) {
    const existing = await loadVault('website');
    await removeVault('website');
    out(
      { channel: 'website', configured: false, removed: Boolean(existing) },
      existing ? 'removed website credentials' : 'no website credentials to remove',
    );
    return 0;
  }
  if (argv.includes('--show')) {
    const parsed = WebsiteConfigSchema.safeParse(await loadVault('website'));
    if (!parsed.success) {
      out({ channel: 'website', configured: false }, 'no website credentials configured');
      return 0;
    }
    const mask = maskSecret(parsed.data.secret);
    out(
      {
        channel: 'website',
        configured: true,
        endpoint: parsed.data.endpoint,
        secret: mask,
        pageUrl: parsed.data.pageUrl,
      },
      `endpoint: ${parsed.data.endpoint}\nsecret:   ${mask}` +
        (parsed.data.pageUrl ? `\npageUrl:  ${parsed.data.pageUrl}` : ''),
    );
    return 0;
  }
  const endpoint = optValue(argv, '--endpoint');
  const secret = optValue(argv, '--secret') ?? process.env[ENV_SECRET]?.trim();
  if (!endpoint) {
    io.err('[automation credential] --endpoint <https-url> is required (or use --show | --remove)');
    return 1;
  }
  if (!secret) {
    io.err(`[automation credential] secret is required: pass --secret <s> or set ${ENV_SECRET}`);
    return 1;
  }
  const errors = validateConfig({ endpoint, secret });
  if (errors.length) {
    io.err(`[automation credential] ${errors.join('; ')}`);
    return 1;
  }
  await saveVault('website', { endpoint, secret });
  const mask = maskSecret(secret);
  out(
    { channel: 'website', configured: true, endpoint, secret: mask },
    `saved website credentials (endpoint: ${endpoint}, secret: ${mask})`,
  );
  return 0;
}
