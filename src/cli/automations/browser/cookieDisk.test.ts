import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { cookieDbCandidates, probeSessionCookiesOnDisk } from './cookieDisk.js';

const PROFILE = path.join('/home/tester', '.zelari-code', 'browser-profiles', 'facebook');

describe('cookieDbCandidates', () => {
  it('lists Chromium Default/Network then Default/Cookies', () => {
    const c = cookieDbCandidates(PROFILE);
    expect(c[0]).toContain(`${path.join('Default', 'Network', 'Cookies')}`);
    expect(c[1]).toContain(`${path.join('Default', 'Cookies')}`);
  });
});

describe('probeSessionCookiesOnDisk', () => {
  it('present when every wanted name is in the DB bytes', async () => {
    const buf = Buffer.from('xxxxc_userxxxxxsxxxxdatr');
    const r = await probeSessionCookiesOnDisk(PROFILE, ['c_user', 'xs'], async () => buf);
    expect(r).toBe('present');
  });

  it('missing when the DB exists but a name is absent', async () => {
    const buf = Buffer.from('xxxxc_userxxxxdatr');
    const r = await probeSessionCookiesOnDisk(PROFILE, ['c_user', 'xs'], async () => buf);
    expect(r).toBe('missing');
  });

  it('locked when the cookie file is EBUSY (Chromium has the profile open)', async () => {
    const r = await probeSessionCookiesOnDisk(PROFILE, ['c_user', 'xs'], async () => {
      const err = new Error('busy') as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    });
    expect(r).toBe('locked');
  });

  it('absent when no cookie DB exists yet', async () => {
    const r = await probeSessionCookiesOnDisk(PROFILE, ['c_user', 'xs'], async () => {
      const err = new Error('nope') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(r).toBe('absent');
  });

  it('absent when wanted is empty', async () => {
    const r = await probeSessionCookiesOnDisk(PROFILE, []);
    expect(r).toBe('absent');
  });
});
