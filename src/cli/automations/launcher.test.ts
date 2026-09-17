/**
 * launcher.test.ts — pure launcher bodies + the on-disk write.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildLauncherCmd,
  buildLauncherSh,
  resolveLauncherPath,
  writeLauncher,
} from './launcher.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'zelari-ln-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('launcher builders', () => {
  it('.cmd cds into the root and runs the automation headlessly', () => {
    const cmd = buildLauncherCmd('news', '/proj', '/proj/bin/zelari-code.js', '/usr/bin/node');
    expect(cmd).toContain('@echo off');
    expect(cmd).toContain('cd /d "/proj"');
    expect(cmd).toContain('--headless --once --automation news');
  });

  it('.sh cds into the root and execs the automation headlessly', () => {
    const sh = buildLauncherSh('news', '/proj', '/proj/bin/zelari-code.js', '/usr/bin/node');
    expect(sh.startsWith('#!/bin/sh')).toBe(true);
    expect(sh).toContain('cd "/proj"');
    expect(sh).toContain('exec "/usr/bin/node" "/proj/bin/zelari-code.js" --headless --once --automation news');
  });
});

describe('writeLauncher', () => {
  it('writes both launchers with the automation flag', async () => {
    const paths = await writeLauncher(root, 'news');
    expect(await readFile(paths.cmdPath, 'utf-8')).toContain('--automation news');
    expect(await readFile(paths.shPath, 'utf-8')).toContain('--automation news');
    expect(paths.cmdPath.endsWith('news.launcher.cmd')).toBe(true);
    expect(paths.shPath.endsWith('news.launcher.sh')).toBe(true);
  });

  it('resolveLauncherPath picks per platform', () => {
    expect(resolveLauncherPath(root, 'news', 'win32').endsWith('news.launcher.cmd')).toBe(true);
    expect(resolveLauncherPath(root, 'news', 'linux').endsWith('news.launcher.sh')).toBe(true);
    expect(resolveLauncherPath(root, 'news', 'darwin').endsWith('news.launcher.sh')).toBe(true);
  });
});
