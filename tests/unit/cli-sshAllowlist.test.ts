import { describe, it, expect } from 'vitest';
import { isSshCommandAllowed, type SshTarget } from '../../src/cli/ssh/targets.js';

const base: SshTarget = {
  id: 't',
  name: 't',
  host: 'h',
  user: 'u',
  auth: 'agent',
  allowedCommands: ['systemctl status *', 'uptime', 'docker ps*'],
};

describe('isSshCommandAllowed', () => {
  it('allows exact and prefix matches', () => {
    expect(isSshCommandAllowed(base, 'uptime').ok).toBe(true);
    expect(isSshCommandAllowed(base, 'systemctl status nginx').ok).toBe(true);
    expect(isSshCommandAllowed(base, 'docker ps -a').ok).toBe(true);
  });

  it('denies unknown commands', () => {
    const r = isSshCommandAllowed(base, 'cat /etc/shadow');
    expect(r.ok).toBe(false);
  });

  it('denies metacharacters on prefix rules', () => {
    const r = isSshCommandAllowed(base, 'systemctl status nginx; rm -rf /');
    expect(r.ok).toBe(false);
  });

  it('status-only when allowlist empty', () => {
    const r = isSshCommandAllowed({ ...base, allowedCommands: [] }, 'uptime');
    expect(r.ok).toBe(false);
  });
});
