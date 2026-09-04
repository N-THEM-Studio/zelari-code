/**
 * W3.3 (t48) — permission presets: UX sugar over the category policy.
 * Acceptance: `standard` reproduces the pre-preset defaults byte-for-byte;
 * strict/yolo change ONLY the defaults; per-category env still wins.
 */
import { describe, expect, it } from 'vitest';
import {
  activePermissionPreset,
  defaultPermissionPolicy,
  parsePermissionPreset,
  PERMISSION_PRESETS,
} from './toolPermissions.js';

const ENV_KEYS = [
  'ZELARI_PERMISSION_PRESET',
  'ZELARI_PERMISSION_READ',
  'ZELARI_PERMISSION_WRITE',
  'ZELARI_PERMISSION_EXECUTE',
  'ZELARI_PERMISSION_NETWORK',
  'ZELARI_AUTO',
] as const;

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('permission presets (W3.3 / t48)', () => {
  it('standard preset reproduces the historical defaults exactly', () => {
    withEnv({}, () => {
      expect(activePermissionPreset()).toBe('standard');
      expect(defaultPermissionPolicy()).toEqual({
        read: 'allow',
        write: 'allow',
        execute: 'ask',
        network: 'ask',
        ui: 'allow',
        auto: false,
      });
    });
  });

  it('strict: write/network tighten, read stays usable', () => {
    withEnv({ ZELARI_PERMISSION_PRESET: 'strict' }, () => {
      expect(defaultPermissionPolicy()).toMatchObject({
        read: 'allow',
        write: 'ask',
        execute: 'ask',
        network: 'deny',
      });
    });
  });

  it('yolo: everything allowed by default (still not auto)', () => {
    withEnv({ ZELARI_PERMISSION_PRESET: 'yolo' }, () => {
      expect(defaultPermissionPolicy()).toMatchObject({
        read: 'allow',
        write: 'allow',
        execute: 'allow',
        network: 'allow',
        auto: false,
      });
    });
  });

  it('per-category env beats the preset in BOTH directions', () => {
    withEnv(
      {
        ZELARI_PERMISSION_PRESET: 'yolo',
        ZELARI_PERMISSION_EXECUTE: 'deny',
      },
      () => {
        expect(defaultPermissionPolicy().execute).toBe('deny'); // env restricts yolo
      },
    );
    withEnv(
      {
        ZELARI_PERMISSION_PRESET: 'strict',
        ZELARI_PERMISSION_NETWORK: 'allow',
      },
      () => {
        expect(defaultPermissionPolicy().network).toBe('allow'); // env relaxes strict (explicit user act)
      },
    );
  });

  it('parsePermissionPreset: case-insensitive, null on garbage', () => {
    expect(parsePermissionPreset('STRICT')).toBe('strict');
    expect(parsePermissionPreset('Standard')).toBe('standard');
    expect(parsePermissionPreset('yolo')).toBe('yolo');
    expect(parsePermissionPreset('nope')).toBeNull();
    expect(parsePermissionPreset(undefined)).toBeNull();
  });

  it('preset table is complete and every value is a valid action', () => {
    const actions = new Set(['allow', 'ask', 'deny']);
    for (const p of ['strict', 'standard', 'yolo'] as const) {
      const v = PERMISSION_PRESETS[p];
      expect(actions.has(v.read)).toBe(true);
      expect(actions.has(v.write)).toBe(true);
      expect(actions.has(v.execute)).toBe(true);
      expect(actions.has(v.network)).toBe(true);
    }
  });
});
