import { describe, expect, it } from 'vitest';
import { describeResolvedShell } from './shellResolver.js';

describe('describeResolvedShell — the prompt names the shell that really runs', () => {
  it('PowerShell 7: says it is not POSIX and gives the replacements for the commands that failed', () => {
    const s = describeResolvedShell({
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      via: 'powershell (C:\\Program Files\\PowerShell\\7\\pwsh.exe)',
      isBash: false,
      isPowerShell: true,
    });
    expect(s).toContain('PowerShell');
    expect(s).toContain('tail, head, grep, wc and sed do not exist');
    expect(s).toContain('Select-Object -Last N');
    expect(s).toContain('&& and || chain commands');
  });

  it('Windows PowerShell 5.1: no && chaining', () => {
    const s = describeResolvedShell({
      shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      via: 'powershell',
      isBash: false,
      isPowerShell: true,
    });
    expect(s).toContain('chain commands with ;');
  });

  it('Git Bash: POSIX syntax', () => {
    const s = describeResolvedShell({
      shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
      via: 'bash',
      isBash: true,
      isPowerShell: false,
    });
    expect(s).toContain('POSIX syntax');
  });
});
