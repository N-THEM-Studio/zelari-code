import { describe, expect, it } from 'vitest';
import { REDACTED, redactRuntimePayload, redactString } from './Redactor.js';

describe('redactString', () => {
  it('redacts Bearer tokens', () => {
    expect(redactString('Authorization: Bearer abc123XYZ_-')).toBe('Authorization: [REDACTED]');
    expect(redactString('bearer eyJhbGciOi.very.long.token')).toBe('bearer [REDACTED]');
  });

  it('redacts OpenAI-style keys', () => {
    expect(redactString('key sk-proj-0123456789abcdefGHIJ end')).toBe('key sk-[REDACTED] end');
    expect(redactString('sk-abcdefgh12345678')).toBe('sk-[REDACTED]');
  });

  it('redacts GitHub / Slack / AWS / Google tokens', () => {
    expect(redactString('ghp_' + 'a'.repeat(30))).toBe('[REDACTED]');
    expect(redactString('xoxb-1234567890-abcdef')).toBe('[REDACTED]');
    expect(redactString('AKIA' + 'ABCDEFGH01234567')).toBe('[REDACTED]');
    expect(redactString('ya29.a0ARrdaM-token-here')).toBe('[REDACTED]');
  });

  it('redacts secret-looking assignments', () => {
    expect(redactString('MY_API_KEY=supersecret123')).toBe('MY_API_KEY=[REDACTED]');
    expect(redactString('password: hunter2,')).toBe('password=[REDACTED],');
    expect(redactString('SSH_PASSWORD="dont-look"')).toBe('SSH_PASSWORD=[REDACTED]');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'npm test -- auth passed in 8.2s';
    expect(redactString(text)).toBe(text);
  });
});

describe('redactRuntimePayload', () => {
  it('replaces whole values under secret-ish keys', () => {
    const out = redactRuntimePayload({
      apiKey: 'whatever',
      nested: { authorization: 'Bearer x', note: 'fine' },
    }) as Record<string, any>;
    expect(out.apiKey).toBe(REDACTED);
    expect(out.nested.authorization).toBe(REDACTED);
    expect(out.nested.note).toBe('fine');
  });

  it('walks arrays and scrubs embedded strings', () => {
    const out = redactRuntimePayload(['ok', 'sk-abcdefghijklmnopqrst']) as unknown[];
    expect(out[0]).toBe('ok');
    expect(out[1]).toBe('sk-[REDACTED]');
  });

  it('passes primitives through', () => {
    expect(redactRuntimePayload(42)).toBe(42);
    expect(redactRuntimePayload(null)).toBeNull();
  });
});
