/**
 * automations/osSchedule.ts — OS scheduler materialization (ADR-0037 §2).
 *
 * Per-id entries, with back-compat names for the reserved `gardener` id so
 * existing installs are not orphaned:
 *   Windows  schtasks /TN ZelariAutomation:<id>   (gardener: ZelariGardener)
 *   macOS    ~/Library/LaunchAgents/<label>.plist (gardener: com.zelari.gardener)
 *   Linux    crontab line tagged # ZelariAutomation:<id> (gardener: # ZelariGardener)
 *
 * The `build*`/`filter*` helpers are PURE (no fs, no spawn) and unit-tested.
 * Only `registerOsSchedule` / `removeOsSchedule` / `osScheduleStatus` touch the
 * OS, and only when the CLI `automation register|remove|status` runs.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Error text for the not-yet-implemented cron path (F2). */
export const CRON_F2_MESSAGE = 'cron schedule materialization lands in F2 (ADR-0037)';

/** Windows task name (back-compat for `gardener`). */
export function winTaskName(id: string): string {
  return id === 'gardener' ? 'ZelariGardener' : `ZelariAutomation:${id}`;
}

/** macOS LaunchAgent label (back-compat for `gardener`). */
export function darwinLabel(id: string): string {
  return id === 'gardener' ? 'com.zelari.gardener' : `com.zelari.automation.${id}`;
}

/** Linux crontab line tag (back-compat for `gardener`). */
export function crontabTag(id: string): string {
  return id === 'gardener' ? '# ZelariGardener' : `# ZelariAutomation:${id}`;
}

/** schtasks `/Create` args (program is `schtasks`). */
export function buildSchtasksCreate(id: string, intervalMin: number, launcherPath: string): string[] {
  return [
    '/Create',
    '/TN',
    winTaskName(id),
    '/SC',
    'MINUTE',
    '/MO',
    String(intervalMin),
    '/TR',
    launcherPath,
    '/F',
  ];
}

/** schtasks `/Delete` args. */
export function buildSchtasksDelete(id: string): string[] {
  return ['/Delete', '/TN', winTaskName(id), '/F'];
}

/** schtasks `/Query` args (exit 0 ⇒ registered). */
export function buildSchtasksQuery(id: string): string[] {
  return ['/Query', '/TN', winTaskName(id)];
}

/** macOS LaunchAgent plist XML (Label + ProgramArguments + StartInterval secs). */
export function buildLaunchdPlist(id: string, intervalMin: number, launcherPath: string): string {
  const label = darwinLabel(id);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    `  <key>Label</key>\n  <string>${label}</string>\n` +
    '  <key>ProgramArguments</key>\n' +
    '  <array>\n' +
    `    <string>${launcherPath}</string>\n` +
    '  </array>\n' +
    `  <key>StartInterval</key>\n  <integer>${intervalMin * 60}</integer>\n` +
    '</dict>\n' +
    '</plist>\n'
  );
}

/** Linux crontab entry line. */
export function buildCrontabLine(id: string, intervalMin: number, launcherPath: string): string {
  return `*/${intervalMin} * * * * ${launcherPath} ${crontabTag(id)}`;
}

/** schtasks `/Create` args for an ONLOGON trigger (program is `schtasks`). */
export function buildSchtasksCreateOnLogon(id: string, launcherPath: string): string[] {
  return ['/Create', '/TN', winTaskName(id), '/SC', 'ONLOGON', '/TR', launcherPath, '/F'];
}

/** macOS LaunchAgent plist that runs at login (`RunAtLoad`). */
export function buildLaunchdPlistAtLoad(id: string, launcherPath: string): string {
  const label = darwinLabel(id);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    `  <key>Label</key>\n  <string>${label}</string>\n` +
    '  <key>ProgramArguments</key>\n' +
    '  <array>\n' +
    `    <string>${launcherPath}</string>\n` +
    '  </array>\n' +
    '  <key>RunAtLoad</key>\n  <true/>\n' +
    '</dict>\n' +
    '</plist>\n'
  );
}

/** Linux crontab entry that runs once at boot (`@reboot`). */
export function buildCrontabLineAtReboot(id: string, launcherPath: string): string {
  return `@reboot ${launcherPath} ${crontabTag(id)}`;
}

/**
 * Remove every line whose trailing (trimmed) tag matches `crontabTag(id)`.
 * Trim-tolerant: surrounding whitespace is ignored; unrelated lines are kept.
 */
export function filterCrontab(content: string, id: string): string {
  const tag = crontabTag(id);
  return content
    .split('\n')
    .filter((line) => !line.trimEnd().endsWith(tag))
    .join('\n');
}

/** Where the macOS plist for `id` lives. */
function darwinPlistPath(id: string): string {
  return path.join(homedir(), 'Library', 'LaunchAgents', `${darwinLabel(id)}.plist`);
}

/** Read the current crontab; a non-zero exit (no crontab yet) degrades to "". */
async function readCrontab(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('crontab', ['-l']);
    return stdout;
  } catch {
    return '';
  }
}

/** Install a crontab by piping the full content into `crontab -` (no shell). */
async function writeCrontab(content: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('crontab', ['-'], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`crontab - exited with code ${code}`)),
    );
    child.stdin.write(content);
    child.stdin.end();
  });
}

/** Options for {@link registerOsSchedule}. */
export interface RegisterOsScheduleOptions {
  root: string;
  id: string;
  /** Interval trigger (minutes). Required unless `atLogon` is true (cron → F2). */
  intervalMin?: number;
  /** On-logon trigger: when true an intervalMin is not required. */
  atLogon?: boolean;
  launcherPath: string;
}

/** Result of a successful registration. */
export interface OsScheduleRegistration {
  platform: NodeJS.Platform;
  /** OS-side identifier (task name / launchd label / crontab tag). */
  name: string;
  /** Plist path on darwin; launcher path otherwise. */
  path?: string;
  launcherPath: string;
}

/**
 * Materialize the OS schedule for `id`. Windows → schtasks create; macOS →
 * write a LaunchAgent plist (no `launchctl load` in F1); Linux → tagged
 * crontab line. Throws the F2 guard when `intervalMin` is missing.
 */
export async function registerOsSchedule(
  opts: RegisterOsScheduleOptions,
): Promise<OsScheduleRegistration> {
  const { id, launcherPath } = opts;
  const atLogon = opts.atLogon === true;
  const intervalMin = opts.intervalMin;
  if (!atLogon && (intervalMin === undefined || !Number.isFinite(intervalMin))) {
    throw new Error(CRON_F2_MESSAGE);
  }
  switch (process.platform) {
    case 'win32': {
      const args = atLogon
        ? buildSchtasksCreateOnLogon(id, launcherPath)
        : buildSchtasksCreate(id, intervalMin as number, launcherPath);
      await execFileAsync('schtasks', args);
      return { platform: 'win32', name: winTaskName(id), launcherPath };
    }
    case 'darwin': {
      const plistPath = darwinPlistPath(id);
      await mkdir(path.dirname(plistPath), { recursive: true });
      const plist = atLogon
        ? buildLaunchdPlistAtLoad(id, launcherPath)
        : buildLaunchdPlist(id, intervalMin as number, launcherPath);
      await writeFile(plistPath, plist, 'utf-8');
      return { platform: 'darwin', name: darwinLabel(id), path: plistPath, launcherPath };
    }
    default: {
      const current = await readCrontab();
      const filtered = filterCrontab(current, id);
      const prefix = filtered === '' || filtered.endsWith('\n') ? filtered : `${filtered}\n`;
      const line = atLogon
        ? buildCrontabLineAtReboot(id, launcherPath)
        : buildCrontabLine(id, intervalMin as number, launcherPath);
      await writeCrontab(`${prefix}${line}\n`);
      return { platform: process.platform, name: crontabTag(id), launcherPath };
    }
  }
}

/** Remove the OS schedule for `id` (tolerant: not-registered is not an error). */
export async function removeOsSchedule(root: string, id: string): Promise<void> {
  void root;
  switch (process.platform) {
    case 'win32': {
      try {
        await execFileAsync('schtasks', buildSchtasksDelete(id));
      } catch {
        /* not registered → nothing to do */
      }
      return;
    }
    case 'darwin': {
      await rm(darwinPlistPath(id), { force: true });
      return;
    }
    default: {
      const current = await readCrontab();
      await writeCrontab(filterCrontab(current, id));
      return;
    }
  }
}

/** osScheduleStatus result. */
export interface OsScheduleStatus {
  registered: boolean;
  platform: NodeJS.Platform;
  detail?: string;
}

/** Whether the OS schedule for `id` is currently registered. */
export async function osScheduleStatus(id: string): Promise<OsScheduleStatus> {
  switch (process.platform) {
    case 'win32': {
      try {
        await execFileAsync('schtasks', buildSchtasksQuery(id));
        return { registered: true, platform: 'win32' };
      } catch {
        return { registered: false, platform: 'win32' };
      }
    }
    case 'darwin': {
      const plistPath = darwinPlistPath(id);
      return { registered: existsSync(plistPath), platform: 'darwin', detail: plistPath };
    }
    default: {
      const current = await readCrontab();
      const tag = crontabTag(id);
      const registered = current.split('\n').some((line) => line.trimEnd().endsWith(tag));
      return { registered, platform: process.platform };
    }
  }
}
