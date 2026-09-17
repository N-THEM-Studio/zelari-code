/**
 * automations/cli.ts — `zelari-code automation <sub>` dispatch (ADR-0037 §8/F1).
 *
 * Invoked by the CLI pre-parser in main.ts. Prints human-readable lines and
 * returns a numeric exit code (0 ok, 1 error, 4 unproven). Never throws.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { formatCalibrationReport, runCalibration } from './browser/calibrate.js';
import { formatDoctorReport, runDoctor } from './browser/doctor.js';
import { formatProbeReport, runProbe } from './browser/probe.js';
import { ChannelSchema } from './browser/selectors.js';
import { checkLogin, DEFAULT_LOGIN_TIMEOUT_SEC, openLoginSession } from './browser/session.js';
import { runCredentialCommand } from './channels/credentialCli.js';
import { ensureGardenerSpec } from './gardenerMigration.js';
import { resolveLauncherPath, writeLauncher } from './launcher.js';
import { osScheduleStatus, registerOsSchedule, removeOsSchedule } from './osSchedule.js';
import {
  deleteAutomation,
  getAutomation,
  listAutomations,
  listRuns,
  setAutomationEnabled,
  upsertAutomation,
} from './registry.js';
import { readOnlyJson, setEnabledJson, upsertJson } from './jsonOutput.js';
import { runAutomation } from './runAutomation.js';
import { listPending, resolveApproval } from './social/approvals.js';
import { AutomationSpecSchema } from './types.js';

/** `--timeout-sec` bound for `automation login`. */
const TimeoutSecSchema = z.coerce.number().int().min(5).max(86_400);

const USAGE = `zelari-code automation <subcommand>

  list [--json]              List automations (migrates gardener if missing)
  show --id <id>             Print one automation spec as JSON
  upsert --file <spec.json>  Create/update an automation from a JSON spec
                             (--json echoes the saved spec; social_post.prompt
                             + model {provider,id} = per-task LLM)
  set-enabled --id <id> --value <true|false> [--json]
                             Enable/disable an automation (gardener is reserved)
  delete --id <id>           Delete an automation (gardener is reserved)
  register --id <id>         Materialize the OS schedule + write the launcher
  remove --id <id>           Remove the OS schedule (tolerant)
  status --id <id> [--json]  Print whether the OS schedule is registered
  run --id <id>              Run one automation now (exit 0/1/4)
  runs --id <id> [--limit n] [--json]  List recent runs (newest first)
  pending [--json]           List runs awaiting human approval
  approve <runId> --allow|--deny|--edit="<text>"
                             Resolve one pending run (exit 0/1/4)
  login <channel> [--timeout-sec n]
                             Manual login on a persistent browser profile (headed)
  health <channel>           Exit 0 if logged in, 4 relogin_required, 1 env error
  probe <channel> [--json] [--publish]
                             Diagnose session/selectors (exit 0 ok / 1 otherwise)
                             --publish also opens the composer + checks the Post button
  doctor [--sessions] [--kill] [--json]
                             Environment diagnostic: playwright, chromium,
                             selectors, profiles, and LIVE chrome processes
                             holding the profiles (--kill terminates only those)
  calibrate <channel> [--headed] [--json]
                             Dump the LIVE composer controls (role/aria/text)
                             for selector calibration. Never types, never posts
  credential website --endpoint <https-url> [--secret <s>] [--json]
                             Store website-webhook credentials (--show | --remove)

channels: x, facebook`;

/** Value of `--name value` or `--name=value` (undefined when absent/empty). */
function optValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) {
      const v = argv[i + 1];
      return v && !v.startsWith('--') ? v : undefined;
    }
    if (a.startsWith(`${name}=`)) {
      const v = a.slice(name.length + 1);
      return v.length > 0 ? v : undefined;
    }
  }
  return undefined;
}

/** The token immediately after the literal `automation`. */
function subcommand(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('automation');
  return at >= 0 ? argv[at + 1] : undefined;
}

/** The first non-flag token immediately after the literal `literal`. */
function argAfter(argv: readonly string[], literal: string): string | undefined {
  const at = argv.indexOf(literal);
  const v = at >= 0 ? argv[at + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
}

/** The positional channel token right after `automation <sub>`. */
function channelArg(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('automation');
  const v = at >= 0 ? argv[at + 2] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
}

/** Parse+validate a channel positional against the supported enum. */
function parseChannel(argv: readonly string[], sub: string): string | undefined | null {
  const parsed = ChannelSchema.safeParse(channelArg(argv));
  if (!parsed.success) {
    err(
      `[automation ${sub}] unknown channel: ${channelArg(argv) ?? '(missing)'} ` +
        `(supported: ${ChannelSchema.options.join(', ')})`,
    );
    return null;
  }
  return parsed.data;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Dispatch one `automation <sub>` invocation. */
export async function runAutomationCli(argv: readonly string[], root: string): Promise<number> {
  const sub = subcommand(argv);
  const id = optValue(argv, '--id');
  try {
    if (argv.includes('--json')) {
      const json = await readOnlyJson(sub, root, id, optValue(argv, '--limit'));
      if (json !== undefined) { out(json); return 0; }
    }
    switch (sub) {
      case 'list': {
        await ensureGardenerSpec(root);
        const jobs = await listAutomations(root);
        for (const j of jobs) {
          out(`${j.id}  ${j.kind}  enabled=${j.enabled}  ${j.name}`);
        }
        return 0;
      }

      case 'show': {
        if (!id) {
          err('[automation show] --id is required');
          return 1;
        }
        const spec = await getAutomation(root, id);
        if (!spec) {
          err(`[automation show] unknown automation id: ${id}`);
          return 1;
        }
        out(JSON.stringify(spec, null, 2));
        return 0;
      }

      case 'upsert': {
        const file = optValue(argv, '--file');
        if (!file) {
          err('[automation upsert] --file is required');
          return 1;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(await readFile(file, 'utf-8'));
        } catch (e) {
          err(`[automation upsert] cannot read spec: ${e instanceof Error ? e.message : String(e)}`);
          return 1;
        }
        const parsed = AutomationSpecSchema.safeParse(raw);
        if (!parsed.success) {
          err('[automation upsert] invalid spec:');
          for (const issue of parsed.error.issues) {
            err(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
          }
          return 1;
        }
        await upsertAutomation(root, parsed.data);
        if (argv.includes('--json')) {
          out(upsertJson(parsed.data));
        } else {
          out(`upserted ${parsed.data.id}`);
        }
        return 0;
      }

      case 'delete': {
        if (!id) {
          err('[automation delete] --id is required');
          return 1;
        }
        await deleteAutomation(root, id);
        out(`deleted ${id}`);
        return 0;
      }

      case 'set-enabled': {
        if (!id) {
          err('[automation set-enabled] --id is required');
          return 1;
        }
        const raw = optValue(argv, '--value');
        if (raw !== 'true' && raw !== 'false') {
          err('[automation set-enabled] --value must be true or false');
          return 1;
        }
        const enabled = raw === 'true';
        const spec = await setAutomationEnabled(root, id, enabled);
        if (argv.includes('--json')) {
          out(setEnabledJson(spec));
        } else {
          out(`${id}: ${enabled ? 'enabled' : 'disabled'}`);
        }
        return 0;
      }

      case 'register': {
        if (!id) {
          err('[automation register] --id is required');
          return 1;
        }
        const spec = await getAutomation(root, id);
        if (!spec) {
          err(`[automation register] unknown automation id: ${id}`);
          return 1;
        }
        await writeLauncher(root, id);
        const reg = await registerOsSchedule({
          root,
          id,
          intervalMin: spec.schedule.intervalMin,
          atLogon: spec.schedule.atLogon,
          launcherPath: resolveLauncherPath(root, id),
        });
        out(`registered ${reg.name} (${reg.platform}) → ${reg.path ?? reg.launcherPath}`);
        return 0;
      }

      case 'remove': {
        if (!id) {
          err('[automation remove] --id is required');
          return 1;
        }
        await removeOsSchedule(root, id);
        out(`removed schedule for ${id}`);
        return 0;
      }

      case 'status': {
        if (!id) {
          err('[automation status] --id is required');
          return 1;
        }
        const st = await osScheduleStatus(id);
        out(`${id}: ${st.registered ? 'registered' : 'not registered'} (${st.platform})`);
        return 0;
      }

      case 'run': {
        if (!id) {
          err('[automation run] --id is required');
          return 1;
        }
        return await runAutomation(root, id);
      }

      case 'runs': {
        if (!id) {
          err('[automation runs] --id is required');
          return 1;
        }
        const rawLimit = optValue(argv, '--limit');
        const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 20;
        const runs = await listRuns(root, id, Number.isFinite(limit) ? limit : 20);
        for (const r of runs) {
          out(`${r.runId}  ${r.status}  ${r.exitCode}`);
        }
        return 0;
      }

      case 'pending': {
        const items = await listPending(root);
        for (const it of items) {
          out(
            `${it.automationId}  ${it.runId}  started=${it.startedAt}  ` +
              `expires=${it.expiresAt ?? '-'}  ${it.draftPreview}`,
          );
        }
        return 0;
      }

      case 'approve': {
        const runId = argAfter(argv, 'approve');
        if (!runId) {
          err('[automation approve] <runId> is required');
          return 1;
        }
        const allow = argv.includes('--allow');
        const deny = argv.includes('--deny');
        const editedText = optValue(argv, '--edit');
        const edit = editedText !== undefined;
        if ([allow, deny, edit].filter(Boolean).length !== 1) {
          err('[automation approve] exactly one of --allow | --deny | --edit="<text>" is required');
          return 1;
        }
        if (edit) return await resolveApproval(root, runId, 'edit', editedText);
        if (deny) return await resolveApproval(root, runId, 'deny');
        return await resolveApproval(root, runId, 'allow');
      }

      case 'login': {
        const channel = parseChannel(argv, 'login');
        if (!channel) return 1;
        const rawTimeout = optValue(argv, '--timeout-sec');
        const timeout = rawTimeout === undefined ? DEFAULT_LOGIN_TIMEOUT_SEC : Number(rawTimeout);
        const checked = TimeoutSecSchema.safeParse(timeout);
        if (!checked.success) {
          err('[automation login] --timeout-sec must be an integer between 5 and 86400');
          return 1;
        }
        const res = await openLoginSession(channel, { timeoutSec: checked.data, cwd: root, log: out });
        if (res.ok) {
          out(`[automation login] ${channel}: logged in ✓`);
          return 0;
        }
        out(`[automation login] ${channel}: ${res.reason ?? 'unproven (not logged in)'}`);
        return 4;
      }

      case 'health': {
        const channel = parseChannel(argv, 'health');
        if (!channel) return 1;
        const report = await checkLogin(channel, { cwd: root });
        const message = report.loggedIn
          ? `${channel}: logged-in${report.matched ? ` (${report.matched})` : ''}`
          : `${channel}: relogin_required`;
        if (argv.includes('--json')) {
          out(JSON.stringify({ ...report, exitCode: report.loggedIn ? 0 : 4, message }));
        } else {
          out(message);
        }
        return report.loggedIn ? 0 : 4;
      }

      case 'probe': {
        const channel = parseChannel(argv, 'probe');
        if (!channel) return 1;
        const report = await runProbe(channel, { cwd: root, publish: argv.includes('--publish') });
        if (argv.includes('--json')) out(JSON.stringify(report, null, 2));
        else out(formatProbeReport(report));
        return report.ok ? 0 : 1;
      }

      case 'doctor': {
        const report = await runDoctor({
          cwd: root,
          withSessions: argv.includes('--sessions'),
          kill: argv.includes('--kill'),
        });
        if (argv.includes('--json')) out(JSON.stringify(report, null, 2));
        else out(formatDoctorReport(report));
        return report.ok ? 0 : 1;
      }

      case 'calibrate': {
        const channel = parseChannel(argv, 'calibrate');
        if (!channel) return 1;
        const report = await runCalibration(channel, {
          cwd: root,
          headless: !argv.includes('--headed'),
        });
        if (argv.includes('--json')) out(JSON.stringify(report, null, 2));
        else out(formatCalibrationReport(report));
        if (report.ok) return 0;
        return report.reason?.startsWith('relogin_required') ? 4 : 1;
      }

      case 'credential': {
        return await runCredentialCommand(argv, { out, err });
      }

      default: {
        err(USAGE);
        return 1;
      }
    }
  } catch (e) {
    err(`[automation ${sub ?? ''}] ${e instanceof Error ? e.message : String(e)}`.trim());
    return 1;
  }
}
