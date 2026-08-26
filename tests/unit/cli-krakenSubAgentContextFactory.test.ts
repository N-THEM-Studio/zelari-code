/**
 * createKrakenSubAgentContextFactory — provider/model override behavior.
 *
 * Regression coverage for a bug found while debugging Kraken Graph from
 * Desktop: without an explicit override, every tentacle silently used the
 * persisted provider.json `activeProviderId` instead of whichever
 * provider/model the caller (Desktop's selector, via --provider/--model)
 * actually resolved — for the graph executor, where ~all real work happens
 * in tentacles, that made the provider picker a no-op.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const providerFromEnvMock = vi.fn();
const providerConfigForMock = vi.fn();

vi.mock('../../src/cli/provider/openai-compatible.js', () => ({
  providerFromEnv: (...args: unknown[]) => providerFromEnvMock(...args),
  providerConfigFor: (...args: unknown[]) => providerConfigForMock(...args),
  openaiCompatibleProvider: vi.fn(() => async function* () {}),
}));

vi.mock('../../src/cli/tools/krakenModel.js', () => ({
  resolveKrakenSubModel: vi.fn((_agent: string, parentModel: string) => parentModel),
  // Minimal faithful re-implementation (module is mocked out wholesale).
  parseQualifiedModelRef: (ref: string) => {
    const s = ref?.trim() ?? '';
    const slash = s.indexOf('/');
    if (slash <= 0 || slash === s.length - 1) return null;
    const provider = s.slice(0, slash).trim();
    const model = s.slice(slash + 1).trim();
    if (!provider || !model) return null;
    return { provider, model };
  },
}));

import { createKrakenSubAgentContextFactory } from '../../src/cli/toolRegistry.js';
import { AuditLogger } from '../../src/cli/safety/auditLogger.js';

describe('createKrakenSubAgentContextFactory', () => {
  beforeEach(() => {
    providerFromEnvMock.mockReset();
    providerConfigForMock.mockReset();
  });

  it('uses providerFromEnv() (persisted default) when no override is given', async () => {
    providerFromEnvMock.mockResolvedValue({
      apiKey: 'k',
      baseUrl: 'https://x',
      model: 'persisted-model',
      providerId: 'grok',
    });

    const factory = createKrakenSubAgentContextFactory({
      root: process.cwd(),
      audit: new AuditLogger(),
      sessionId: 'test',
    });
    const ctx = await factory({ agent: 'explore', thoroughness: 'medium', cwd: process.cwd() });

    expect(providerFromEnvMock).toHaveBeenCalled();
    expect(providerConfigForMock).not.toHaveBeenCalled();
    expect(ctx?.model).toBe('persisted-model');
  });

  it('uses providerConfigFor(provider) and the explicit model override when given', async () => {
    providerConfigForMock.mockResolvedValue({
      apiKey: 'k',
      baseUrl: 'https://y',
      model: 'deepseek-default',
      providerId: 'deepseek',
    });

    const factory = createKrakenSubAgentContextFactory({
      root: process.cwd(),
      audit: new AuditLogger(),
      sessionId: 'test',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });
    const ctx = await factory({ agent: 'general', thoroughness: 'medium', cwd: process.cwd() });

    expect(providerConfigForMock).toHaveBeenCalledWith('deepseek');
    expect(providerFromEnvMock).not.toHaveBeenCalled();
    expect(ctx?.model).toBe('deepseek-v4-flash');
  });

  it('falls back to the resolved provider config model when no explicit model override is given', async () => {
    providerConfigForMock.mockResolvedValue({
      apiKey: 'k',
      baseUrl: 'https://y',
      model: 'deepseek-default',
      providerId: 'deepseek',
    });

    const factory = createKrakenSubAgentContextFactory({
      root: process.cwd(),
      audit: new AuditLogger(),
      sessionId: 'test',
      provider: 'deepseek',
    });
    const ctx = await factory({ agent: 'general', thoroughness: 'medium', cwd: process.cwd() });

    expect(ctx?.model).toBe('deepseek-default');
  });

  it('returns null when the resolved provider has no API key', async () => {
    providerFromEnvMock.mockResolvedValue(null);
    const factory = createKrakenSubAgentContextFactory({
      root: process.cwd(),
      audit: new AuditLogger(),
      sessionId: 'test',
    });
    const ctx = await factory({ agent: 'explore', thoroughness: 'medium', cwd: process.cwd() });
    expect(ctx).toBeNull();
  });
});
