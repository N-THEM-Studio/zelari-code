/**
 * selfKillGuard tests — lethal patterns must be blocked, the safe per-port
 * alternative and read-only commands must pass untouched.
 */
import { describe, expect, it } from 'vitest';
import { inspectCommand, SELF_KILL_DENIAL_MESSAGE } from './selfKillGuard.js';

const CTX = { selfPid: 111, parentPid: 222, extraProtectedPids: [333] };

function blocked(command: string, reason?: string): void {
  const v = inspectCommand(command, CTX);
  expect(v.blocked, `expected BLOCKED: ${command}`).toBe(true);
  expect(v.message).toBe(SELF_KILL_DENIAL_MESSAGE);
  if (reason) expect(v.reason).toBe(reason);
}

function allowed(command: string): void {
  const v = inspectCommand(command, CTX);
  expect(v.blocked, `expected ALLOWED: ${command}`).toBe(false);
}

describe('inspectCommand — lethal image kills (Windows)', () => {
  it('blocks taskkill by image, any slash/casing/flags', () => {
    blocked('taskkill /IM node.exe', 'node-image');
    blocked('taskkill //IM node.exe', 'node-image'); // Git Bash double slash
    blocked('taskkill /F /IM NODE.EXE', 'node-image');
    blocked('taskkill /IM node', 'node-image');
    blocked('TaskKill /IM "node.exe" /T /F', 'node-image');
    blocked('taskkill /FI "IMAGENAME eq node.exe" /F', 'node-image');
  });

  it('blocks PowerShell Stop-Process -Name node', () => {
    blocked('Stop-Process -Name node', 'node-image');
    blocked('Stop-Process -Name node.exe -Force', 'node-image');
    blocked('stop-process -name "node"', 'node-image');
    blocked('powershell -Command "Stop-Process -Name node"', 'node-image');
    blocked('kill -Name node', 'node-image'); // PowerShell alias
  });

  it('blocks Get-Process node piped into a kill', () => {
    blocked('Get-Process node | Stop-Process', 'node-image');
    blocked('Get-Process node | Stop-Process -Force', 'node-image');
    blocked('Get-Process node | % { $_.Kill() }', 'node-image');
    blocked('get-process -Name node.exe | kill', 'node-image');
  });

  it('blocks wmic image delete', () => {
    blocked('wmic process where name="node.exe" delete', 'node-image');
    blocked("wmic process where name='node.exe' delete", 'node-image');
    blocked('wmic process where name="node.exe" call terminate', 'node-image');
  });
});

describe('inspectCommand — lethal image kills (POSIX)', () => {
  it('blocks pkill targeting node', () => {
    blocked('pkill node', 'node-image');
    blocked('pkill -f node', 'node-image');
    blocked('pkill -f node.exe', 'node-image');
    blocked('pkill -9 node', 'node-image');
    blocked('pkill -f "node server.js"', 'node-image');
  });

  it('blocks killall node', () => {
    blocked('killall node', 'node-image');
    blocked('killall node.exe', 'node-image');
    blocked('sudo killall node', 'node-image');
  });

  it('blocks ps→grep node→kill pipelines (pids from stdin)', () => {
    blocked('ps -W | grep node | awk \'{print $1}\' | xargs kill', 'ps-pipeline');
    blocked('ps aux | grep node.exe | xargs kill', 'ps-pipeline');
    blocked('ps aux | grep node | xargs taskkill //F', 'ps-pipeline');
    blocked('ps -ef | findstr node.exe && taskkill //IM node.exe', 'node-image');
  });
});

describe('inspectCommand — protected PID kills', () => {
  it('blocks kills of self / parent / extra protected pids', () => {
    blocked('kill 111', 'protected-pid');
    blocked('kill -9 111', 'protected-pid');
    blocked('kill -s TERM 222', 'protected-pid');
    blocked('kill 222 111', 'protected-pid');
    blocked('taskkill //PID 111', 'protected-pid');
    blocked('taskkill /PID 111 /T /F', 'protected-pid');
    blocked('taskkill //PID 333', 'protected-pid');
    blocked('Stop-Process -Id 111', 'protected-pid');
    blocked('Stop-Process -Id 222 -Force', 'protected-pid');
  });

  it('never misjudges command substitution (kill $(lsof -t -i:PORT))', () => {
    allowed('kill $(lsof -t -i:4173)');
    allowed('kill -9 $(lsof -t -i:3000)');
  });
});

describe('inspectCommand — negative cases (must stay allowed)', () => {
  it('allows PID kills of non-protected processes', () => {
    allowed('kill 4173');
    allowed('kill -9 999999');
    allowed('taskkill //PID 4173');
    allowed('taskkill /PID 12345 /F');
    allowed('Stop-Process -Id 4173');
  });

  it('allows kills of other images', () => {
    allowed('taskkill /IM chrome.exe');
    allowed('taskkill //IM chrome.exe /F');
    allowed('Stop-Process -Name chrome');
    allowed('pkill vite');
    allowed('pkill -f python');
    allowed('killall chrome');
    allowed('wmic process where name="chrome.exe" delete');
  });

  it('allows read-only process inspection', () => {
    allowed('netstat -ano | findstr :4173');
    allowed('ps aux | grep node');
    allowed('ps -W | grep node.exe');
    allowed('lsof -i:4173');
    allowed('Get-Process node');
  });

  it('allows the SAFE per-port kill pattern end-to-end', () => {
    allowed('netstat -ano | findstr :4173 && taskkill //PID 4173');
    allowed('lsof -t -i:4173 | xargs kill');
    allowed('kill $(netstat -ano | findstr :4173)');
  });

  it('allows ordinary commands', () => {
    allowed('npm run typecheck');
    allowed('git status');
    allowed('node -e "console.log(1)"');
    allowed('');
  });
});
