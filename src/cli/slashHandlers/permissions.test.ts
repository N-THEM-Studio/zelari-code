/**
 * ADR-0039 P3b (t149) — `/permissions` after engine A's removal.
 * The handler is list + denials only; add/remove/clear answer that the
 * engine-A session surface is gone.
 */
import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  PERMISSIONS_USAGE,
  formatPermissionsReport,
  handlePermissions,
  listSessionPermissionDenials,
} from './permissions.js';

/** A cwd with NO `.zelari/sessions` — the denials reader must fail soft there. */
const NO_SPINE = path.join(os.tmpdir(), 'zelari-p3b-no-spine');

function ctx() {
  return { setMessages: vi.fn() };
}

describe('ADR-0039 P3b — /permissions surface (engine A removed)', () => {
  it('list renders categories + engine-B pointer, with no project/session rule sections', () => {
    const text = formatPermissionsReport(NO_SPINE);
    expect(text).toContain('[permissions]');
    expect(text).toContain('engine B');
    expect(text).not.toContain('session (');
    expect(text).not.toContain('FAIL-CLOSED');
    expect(text).toContain('(none this session)');
  });

  it('add/remove/clear answer that the engine-A surface is gone', () => {
    for (const sub of ['add', 'remove', 'clear']) {
      const c = ctx();
      const text = handlePermissions(c, sub, ['x'], NO_SPINE);
      expect(text).toContain('ADR-0039 P3b');
      expect(c.setMessages).toHaveBeenCalled();
    }
  });

  it('denials with no spine records none', () => {
    const c = ctx();
    const text = handlePermissions(c, 'denials', [], NO_SPINE);
    expect(text).toContain('no denials recorded this session');
  });

  it('unknown subcommand answers with usage', () => {
    const c = ctx();
    const text = handlePermissions(c, 'bogus', [], NO_SPINE);
    expect(text).toContain("unknown subcommand 'bogus'");
    expect(text).toContain(PERMISSIONS_USAGE);
  });

  it('listSessionPermissionDenials fails soft with no spine', () => {
    expect(listSessionPermissionDenials(NO_SPINE, 5)).toEqual([]);
  });
});
