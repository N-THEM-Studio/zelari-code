/**
 * cli.test.ts — `automation <sub>` dispatch (module-level, tmp dirs only).
 * Covers the read-only/fs subs; register|remove|status touch the OS and are
 * exercised only via the pure builders in osSchedule.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadVault } from './channels/vault.js';
import { runAutomationCli } from './cli.js';
import { getAutomation, listRuns, newRunId, upsertAutomation, writeRun } from './registry.js';
import { runSocialPost } from './social/runner.js';
import type { AutomationSpec } from './types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zelari-cli-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ALPHA: AutomationSpec = {
  id: 'alpha',
  name: 'Alpha',
  enabled: false,
  kind: 'gardener',
  schedule: { intervalMin: 60, timezone: 'UTC' },
  budget: { maxCostUsd: 1 },
};

const SOC: AutomationSpec = {
  id: 'soc',
  name: 'Soc',
  enabled: true,
  kind: 'social_post',
  schedule: { timezone: 'UTC' },
  budget: { maxCostUsd: 1 },
  social_post: {
    channels: ['x'],
    topicOrBrief: 'hi',
    requireApproval: true,
    approvalTtlMin: 1440,
  },
};

describe('runAutomationCli', () => {
  it('list migrates gardener and returns 0', async () => {
    expect(await runAutomationCli(['automation', 'list'], root)).toBe(0);
    expect((await getAutomation(root, 'gardener'))?.kind).toBe('gardener');
  });

  it('show with a missing id returns 1', async () => {
    expect(await runAutomationCli(['automation', 'show', '--id', 'nope'], root)).toBe(1);
  });

  it('upsert --file validates and stores a spec', async () => {
    const file = path.join(root, 'spec.json');
    await writeFile(file, JSON.stringify({ id: 'news', name: 'News', kind: 'gardener' }), 'utf-8');
    expect(await runAutomationCli(['automation', 'upsert', '--file', file], root)).toBe(0);
    expect((await getAutomation(root, 'news'))?.name).toBe('News');
  });

  it('upsert --file with an invalid spec returns 1', async () => {
    const file = path.join(root, 'bad.json');
    await writeFile(file, JSON.stringify({ id: 'BAD', name: 'x', kind: 'nope' }), 'utf-8');
    expect(await runAutomationCli(['automation', 'upsert', '--file', file], root)).toBe(1);
  });

  it('upsert --file --json prints the SAVED spec as one JSON line', async () => {
    const file = path.join(root, 'spec-json.json');
    await writeFile(
      file,
      JSON.stringify({ id: 'news2', name: 'News 2', kind: 'gardener' }),
      'utf-8',
    );
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await runAutomationCli(['automation', 'upsert', '--file', file, '--json'], root)).toBe(
        0,
      );
      const printed = spy.mock.calls.map((c) => String(c[0])).join('');
      // One compact line (the Desktop parses stdout verbatim).
      expect(printed.trim().split('\n')).toHaveLength(1);
      const parsed = JSON.parse(printed) as { id: string; schedule: unknown; enabled: boolean };
      expect(parsed.id).toBe('news2');
      expect(parsed.enabled).toBe(false);
      expect(parsed.schedule).toBeTruthy();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('set-enabled roundtrip flips the flag and refuses gardener', async () => {
    const file = path.join(root, 'se.json');
    await writeFile(file, JSON.stringify({ id: 'news3', name: 'N3', kind: 'gardener' }), 'utf-8');
    await runAutomationCli(['automation', 'upsert', '--file', file], root);
    expect((await getAutomation(root, 'news3'))?.enabled).toBe(false);

    expect(
      await runAutomationCli(['automation', 'set-enabled', '--id', 'news3', '--value', 'true'], root),
    ).toBe(0);
    expect((await getAutomation(root, 'news3'))?.enabled).toBe(true);

    expect(
      await runAutomationCli(['automation', 'set-enabled', '--id', 'news3', '--value', 'false'], root),
    ).toBe(0);
    expect((await getAutomation(root, 'news3'))?.enabled).toBe(false);

    // gardener is reserved — refused with exit 1.
    expect(
      await runAutomationCli(['automation', 'set-enabled', '--id', 'gardener', '--value', 'true'], root),
    ).toBe(1);
  });

  it('set-enabled --json prints {id, enabled}', async () => {
    const file = path.join(root, 'se2.json');
    await writeFile(file, JSON.stringify({ id: 'news4', name: 'N4', kind: 'gardener' }), 'utf-8');
    await runAutomationCli(['automation', 'upsert', '--file', file], root);

    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(
        await runAutomationCli(
          ['automation', 'set-enabled', '--id', 'news4', '--value', 'true', '--json'],
          root,
        ),
      ).toBe(0);
      expect(JSON.parse(spy.mock.calls.map((c) => String(c[0])).join(''))).toEqual({
        id: 'news4',
        enabled: true,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('set-enabled rejects a bad --value (1)', async () => {
    expect(
      await runAutomationCli(['automation', 'set-enabled', '--id', 'x', '--value', 'yes'], root),
    ).toBe(1);
  });

  it('runs lists persisted runs', async () => {
    await upsertAutomation(root, ALPHA);
    await writeRun(root, {
      runId: newRunId(),
      automationId: 'alpha',
      startedAt: new Date().toISOString(),
      status: 'completed',
      exitCode: 0,
    });
    expect(await runAutomationCli(['automation', 'runs', '--id', 'alpha'], root)).toBe(0);
    expect(await listRuns(root, 'alpha')).toHaveLength(1);
  });

  it('pending lists awaiting runs and returns 0', async () => {
    await upsertAutomation(root, SOC);
    await runSocialPost(root, SOC);
    expect(await runAutomationCli(['automation', 'pending'], root)).toBe(0);
  });

  it('approve --allow resolves a pending run and returns 0', async () => {
    await upsertAutomation(root, SOC);
    await runSocialPost(root, SOC);
    const runId = (await listRuns(root, 'soc'))[0].runId;
    expect(await runAutomationCli(['automation', 'approve', runId, '--allow'], root)).toBe(0);
    expect((await listRuns(root, 'soc'))[0].status).toBe('completed');
  });

  it('approve without a decision flag returns 1', async () => {
    expect(await runAutomationCli(['automation', 'approve', 'some-run'], root)).toBe(1);
  });

  it('delete of the reserved gardener id returns 1', async () => {
    await runAutomationCli(['automation', 'list'], root); // migrates gardener
    expect(await runAutomationCli(['automation', 'delete', '--id', 'gardener'], root)).toBe(1);
  });

  it('an unknown subcommand returns 1', async () => {
    expect(await runAutomationCli(['automation', 'bogus'], root)).toBe(1);
  });

  it('login|health|probe reject an unknown channel before touching a browser', async () => {
    // No browser is opened: the channel is validated first (exit 1, not 4/0).
    expect(await runAutomationCli(['automation', 'login', 'tiktok'], root)).toBe(1);
    expect(await runAutomationCli(['automation', 'health', 'tiktok'], root)).toBe(1);
    expect(await runAutomationCli(['automation', 'probe', 'tiktok'], root)).toBe(1);
  });

  it('login|health|probe reject a missing channel argument', async () => {
    expect(await runAutomationCli(['automation', 'login'], root)).toBe(1);
    expect(await runAutomationCli(['automation', 'health'], root)).toBe(1);
    expect(await runAutomationCli(['automation', 'probe'], root)).toBe(1);
  });
});

describe('runAutomationCli — credential website (F3.3)', () => {
  let prevDir: string | undefined;
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevDir = process.env.ZELARI_CHANNELS_DIR;
    prevSecret = process.env.ZELARI_WEBSITE_WEBHOOK_SECRET;
    process.env.ZELARI_CHANNELS_DIR = root;
    delete process.env.ZELARI_WEBSITE_WEBHOOK_SECRET;
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.ZELARI_CHANNELS_DIR;
    else process.env.ZELARI_CHANNELS_DIR = prevDir;
    if (prevSecret === undefined) delete process.env.ZELARI_WEBSITE_WEBHOOK_SECRET;
    else process.env.ZELARI_WEBSITE_WEBHOOK_SECRET = prevSecret;
  });

  it('stores credentials from --endpoint + --secret and returns 0', async () => {
    const code = await runAutomationCli(
      ['automation', 'credential', 'website', '--endpoint', 'https://hook.test/x', '--secret', 's3cr3t-value'],
      root,
    );
    expect(code).toBe(0);
    expect(await loadVault('website')).toEqual({ endpoint: 'https://hook.test/x', secret: 's3cr3t-value' });
  });

  it('reads the secret from the env when --secret is omitted', async () => {
    process.env.ZELARI_WEBSITE_WEBHOOK_SECRET = 'env-secret-value';
    const code = await runAutomationCli(
      ['automation', 'credential', 'website', '--endpoint', 'https://hook.test/x'],
      root,
    );
    expect(code).toBe(0);
    expect(await loadVault('website')).toEqual({ endpoint: 'https://hook.test/x', secret: 'env-secret-value' });
  });

  it('rejects a missing endpoint (1) and a non-https endpoint (1)', async () => {
    expect(await runAutomationCli(['automation', 'credential', 'website', '--secret', 's'], root)).toBe(1);
    expect(
      await runAutomationCli(
        ['automation', 'credential', 'website', '--endpoint', 'http://insecure', '--secret', 's'],
        root,
      ),
    ).toBe(1);
  });

  it('rejects an unsupported channel (1)', async () => {
    expect(
      await runAutomationCli(['automation', 'credential', 'tiktok', '--endpoint', 'https://x.test'], root),
    ).toBe(1);
  });

  it('--show prints the endpoint and a MASKED secret (never the raw secret)', async () => {
    await runAutomationCli(
      ['automation', 'credential', 'website', '--endpoint', 'https://hook.test/x', '--secret', 'supersecretvalue'],
      root,
    );
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await runAutomationCli(['automation', 'credential', 'website', '--show'], root);
      expect(code).toBe(0);
      const printed = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).toContain('https://hook.test/x');
      expect(printed).toContain('supe…alue');
      expect(printed).not.toContain('supersecretvalue');
    } finally {
      spy.mockRestore();
    }
  });

  it('--show on an empty vault returns 0', async () => {
    expect(await runAutomationCli(['automation', 'credential', 'website', '--show'], root)).toBe(0);
  });

  it('--remove deletes stored credentials and returns 0', async () => {
    await runAutomationCli(
      ['automation', 'credential', 'website', '--endpoint', 'https://hook.test/x', '--secret', 's'],
      root,
    );
    expect(await runAutomationCli(['automation', 'credential', 'website', '--remove'], root)).toBe(0);
    expect(await loadVault('website')).toBeNull();
  });

  it('--json prints a machine-readable object with the secret MASKED', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runAutomationCli(
        [
          'automation',
          'credential',
          'website',
          '--endpoint',
          'https://hook.test/x',
          '--secret',
          'supersecretvalue',
          '--json',
        ],
        root,
      );
      const stored = JSON.parse(
        spy.mock.calls.map((c) => String(c[0])).join(''),
      ) as { channel: string; configured: boolean; endpoint: string; secret: string };
      expect(stored).toEqual({
        channel: 'website',
        configured: true,
        endpoint: 'https://hook.test/x',
        secret: 'supe…alue',
      });

      spy.mockClear();
      const code = await runAutomationCli(
        ['automation', 'credential', 'website', '--show', '--json'],
        root,
      );
      expect(code).toBe(0);
      const shown = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(shown).toContain('"configured":true');
      expect(shown).not.toContain('supersecretvalue');

      spy.mockClear();
      expect(
        await runAutomationCli(['automation', 'credential', 'website', '--remove', '--json'], root),
      ).toBe(0);
      expect(JSON.parse(spy.mock.calls.map((c) => String(c[0])).join(''))).toEqual({
        channel: 'website',
        configured: false,
        removed: true,
      });
    } finally {
      spy.mockRestore();
    }
  });
});
