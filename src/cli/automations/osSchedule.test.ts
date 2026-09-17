/**
 * osSchedule.test.ts — pure builders + the F2 cron guard.
 * No OS scheduling is attempted: only the exported pure helpers and a
 * guard-path rejection (which fires before the platform switch) run here.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCrontabLine,
  buildCrontabLineAtReboot,
  buildLaunchdPlist,
  buildLaunchdPlistAtLoad,
  buildSchtasksCreate,
  buildSchtasksCreateOnLogon,
  buildSchtasksDelete,
  buildSchtasksQuery,
  crontabTag,
  darwinLabel,
  filterCrontab,
  registerOsSchedule,
  winTaskName,
} from './osSchedule.js';

describe('osSchedule — names (back-compat for gardener)', () => {
  it('uses legacy names for gardener', () => {
    expect(winTaskName('gardener')).toBe('ZelariGardener');
    expect(darwinLabel('gardener')).toBe('com.zelari.gardener');
    expect(crontabTag('gardener')).toBe('# ZelariGardener');
  });

  it('uses per-id names otherwise', () => {
    expect(winTaskName('news')).toBe('ZelariAutomation:news');
    expect(darwinLabel('news')).toBe('com.zelari.automation.news');
    expect(crontabTag('news')).toBe('# ZelariAutomation:news');
  });
});

describe('osSchedule — schtasks argv', () => {
  it('builds /Create with the legacy gardener task name', () => {
    expect(buildSchtasksCreate('gardener', 60, 'C:\\l.cmd')).toEqual([
      '/Create',
      '/TN',
      'ZelariGardener',
      '/SC',
      'MINUTE',
      '/MO',
      '60',
      '/TR',
      'C:\\l.cmd',
      '/F',
    ]);
  });

  it('builds /Create for a named id', () => {
    expect(buildSchtasksCreate('news', 30, '/x.sh')).toEqual([
      '/Create',
      '/TN',
      'ZelariAutomation:news',
      '/SC',
      'MINUTE',
      '/MO',
      '30',
      '/TR',
      '/x.sh',
      '/F',
    ]);
  });

  it('builds /Delete and /Query', () => {
    expect(buildSchtasksDelete('gardener')).toEqual(['/Delete', '/TN', 'ZelariGardener', '/F']);
    expect(buildSchtasksQuery('gardener')).toEqual(['/Query', '/TN', 'ZelariGardener']);
  });
});

describe('osSchedule — launchd plist', () => {
  it('contains Label, ProgramArguments and StartInterval (seconds)', () => {
    const plist = buildLaunchdPlist('news', 15, '/l.sh');
    expect(plist).toContain('<string>com.zelari.automation.news</string>');
    expect(plist).toContain('<string>/l.sh</string>');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>900</integer>');
  });
});

describe('osSchedule — crontab', () => {
  it('formats a tagged line', () => {
    expect(buildCrontabLine('news', 30, '/l.sh')).toBe('*/30 * * * * /l.sh # ZelariAutomation:news');
  });

  it('filters the tagged line (incl. legacy gardener) and keeps the rest', () => {
    const content = [
      'MAILTO=me@x',
      '*/30 * * * * /l.sh # ZelariAutomation:news',
      '0 1 * * * /other.sh # something',
      '# ZelariGardener',
      '17 3 * * * /keepme',
    ].join('\n');

    expect(filterCrontab(content, 'news')).toBe(
      ['MAILTO=me@x', '0 1 * * * /other.sh # something', '# ZelariGardener', '17 3 * * * /keepme'].join(
        '\n',
      ),
    );
    expect(filterCrontab(content, 'gardener')).toBe(
      [
        'MAILTO=me@x',
        '*/30 * * * * /l.sh # ZelariAutomation:news',
        '0 1 * * * /other.sh # something',
        '17 3 * * * /keepme',
      ].join('\n'),
    );
  });

  it('is trim-tolerant on trailing whitespace', () => {
    const content = '*/5 * * * * /l.sh # ZelariAutomation:news   \n17 3 * * * /keepme';
    expect(filterCrontab(content, 'news')).toBe('17 3 * * * /keepme');
  });
});

describe('osSchedule — atLogon builders', () => {
  it('schtasks /Create ONLOGON carries the per-id task name', () => {
    expect(buildSchtasksCreateOnLogon('news', '/l.cmd')).toEqual([
      '/Create',
      '/TN',
      'ZelariAutomation:news',
      '/SC',
      'ONLOGON',
      '/TR',
      '/l.cmd',
      '/F',
    ]);
  });

  it('schtasks /Create ONLOGON keeps the legacy gardener task name', () => {
    expect(buildSchtasksCreateOnLogon('gardener', 'C:\\l.cmd')).toEqual([
      '/Create',
      '/TN',
      'ZelariGardener',
      '/SC',
      'ONLOGON',
      '/TR',
      'C:\\l.cmd',
      '/F',
    ]);
  });

  it('launchd at-logon plist sets RunAtLoad and no StartInterval', () => {
    const plist = buildLaunchdPlistAtLoad('news', '/l.sh');
    expect(plist).toContain('<string>com.zelari.automation.news</string>');
    expect(plist).toContain('<string>/l.sh</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
    expect(plist).not.toContain('StartInterval');
  });

  it('crontab @reboot line keeps the per-id tag (incl. legacy gardener)', () => {
    expect(buildCrontabLineAtReboot('news', '/l.sh')).toBe('@reboot /l.sh # ZelariAutomation:news');
    expect(buildCrontabLineAtReboot('gardener', '/l.sh')).toBe('@reboot /l.sh # ZelariGardener');
  });
});

describe('osSchedule — cron F2 guard', () => {
  it('throws when intervalMin is missing (before touching the OS)', async () => {
    await expect(
      registerOsSchedule({ root: '/tmp/x', id: 'news', launcherPath: '/l.sh' }),
    ).rejects.toThrow(/F2/);
  });
});
