/**
 * automations/launcher.ts — generate the OS-scheduler launcher (ADR-0037 §3).
 *
 * The OS entry point is a thin launcher that cd's into the project and runs the
 * CLI headless with the automation id:
 *   <node> <cliEntry> --headless --once --automation <id>
 *
 * Both a `.cmd` (Windows) and a `.sh` (POSIX) launcher are written so a spec is
 * portable across machines — the OS scheduler picks via `resolveLauncherPath`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { automationsDir } from './registry.js';

/** Windows `.cmd` body. */
export function buildLauncherCmd(
  id: string,
  root: string,
  cliEntry: string,
  nodeBin: string,
): string {
  return [
    '@echo off',
    `cd /d "${root}"`,
    `"${nodeBin}" "${cliEntry}" --headless --once --automation ${id}`,
    '',
  ].join('\r\n');
}

/** POSIX `sh` body. */
export function buildLauncherSh(id: string, root: string, cliEntry: string, nodeBin: string): string {
  return [
    '#!/bin/sh',
    `cd "${root}"`,
    `exec "${nodeBin}" "${cliEntry}" --headless --once --automation ${id}`,
    '',
  ].join('\n');
}

/** Paths of the two launchers written for an id. */
export interface LauncherPaths {
  cmdPath: string;
  shPath: string;
}

/**
 * Write both launchers under `.zelari/automations/`. `nodeBin` is the running
 * interpreter (`process.execPath`); `cliEntry` is `<root>/bin/zelari-code.js`.
 */
export async function writeLauncher(root: string, id: string): Promise<LauncherPaths> {
  const nodeBin = process.execPath;
  const cliEntry = path.join(root, 'bin', 'zelari-code.js');
  const dir = automationsDir(root);
  await mkdir(dir, { recursive: true });
  const cmdPath = path.join(dir, `${id}.launcher.cmd`);
  const shPath = path.join(dir, `${id}.launcher.sh`);
  await writeFile(cmdPath, buildLauncherCmd(id, root, cliEntry, nodeBin), 'utf-8');
  await writeFile(shPath, buildLauncherSh(id, root, cliEntry, nodeBin), 'utf-8');
  return { cmdPath, shPath };
}

/** Launcher path the OS scheduler should invoke on `platform`. */
export function resolveLauncherPath(
  root: string,
  id: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const ext = platform === 'win32' ? 'cmd' : 'sh';
  return path.join(automationsDir(root), `${id}.launcher.${ext}`);
}
