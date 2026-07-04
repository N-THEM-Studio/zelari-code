import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleSlashCommand } from '../../src/cli/slashCommands.js';

describe('slashCommands /provider + /model (Task 15.3)', () => {
  let testProvider: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    testProvider = path.join(
      os.tmpdir(),
      `anathema-prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    savedEnv = process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
    process.env.ANATHEMA_PROVIDER_CONFIG_FILE = testProvider;
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.ANATHEMA_PROVIDER_CONFIG_FILE;
    else process.env.ANATHEMA_PROVIDER_CONFIG_FILE = savedEnv;
    await fs.rm(testProvider, { force: true });
  });

  describe('/provider', () => {
    it('/provider without args returns kind=provider_picker with usage hint (v0.7.10)', () => {
      const result = handleSlashCommand('/provider', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('provider_picker');
      expect(result.message).toMatch(/Usage/i);
      expect(result.provider).toBeUndefined();
    });

    it('/provider list returns kind=provider_list (text summary path)', () => {
      const result = handleSlashCommand('/provider list', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('provider_list');
    });

    it('/provider <name> returns kind=provider_set + provider name', () => {
      const result = handleSlashCommand('/provider grok', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('provider_set');
      expect(result.provider).toBe('grok');
    });

    it('/provider minimax → provider_set with minimax', () => {
      const result = handleSlashCommand('/provider minimax', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('provider_set');
      expect(result.provider).toBe('minimax');
    });

    it('/provider glm → provider_set with glm', () => {
      const result = handleSlashCommand('/provider glm', []);
      expect(result.handled).toBe(true);
      expect(result.provider).toBe('glm');
    });
  });

  describe('/model', () => {
    it('/model without args returns kind=model_picker with usage hint (v0.7.10)', () => {
      const result = handleSlashCommand('/model', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('model_picker');
      expect(result.message).toMatch(/Usage/i);
      expect(result.model).toBeUndefined();
    });

    it('/model show returns kind=model_show (text path)', () => {
      const result = handleSlashCommand('/model show', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('model_show');
      expect(result.model).toBeUndefined();
    });

    it('/discover returns kind=models_refresh (alias, v0.7.10)', () => {
      const result = handleSlashCommand('/discover', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('models_refresh');
    });

    it('/model <name> returns kind=model_set + model name', () => {
      const result = handleSlashCommand('/model grok-4-fast', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('model_set');
      expect(result.model).toBe('grok-4-fast');
    });

    it('/model grok-3-turbo preserves the full name (no split)', () => {
      const result = handleSlashCommand('/model grok-3-turbo', []);
      expect(result.kind).toBe('model_set');
      expect(result.model).toBe('grok-3-turbo');
    });
  });

  describe('slashCommands total kinds', () => {
    it('/provider kind discriminates from old /model and /council', () => {
      const r1 = handleSlashCommand('/provider grok', []);
      const r2 = handleSlashCommand('/model grok-4', []);
      const r3 = handleSlashCommand('/council foo', []);
      expect(r1.kind).toBe('provider_set');
      expect(r2.kind).toBe('model_set');
      expect(r3.kind).toBe('council');
    });

    // v3-F: refresh + status subcommands
    it('/provider <id> refresh returns kind=provider_refresh + provider name', () => {
      const result = handleSlashCommand('/provider grok refresh', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('provider_refresh');
      expect(result.provider).toBe('grok');
    });

    it('/provider <id> status returns kind=provider_status + provider name', () => {
      const result = handleSlashCommand('/provider minimax status', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('provider_status');
      expect(result.provider).toBe('minimax');
    });

    it('/provider <id> unknown-sub returns kind=provider_set (fallthrough)', () => {
      // Subcommands we don't recognize fall through to the legacy provider_set path.
      const result = handleSlashCommand('/provider glm bogus', []);
      expect(result.handled).toBe(true);
      expect(result.kind).toBe('provider_set');
      expect(result.provider).toBe('glm');
    });
  });
});