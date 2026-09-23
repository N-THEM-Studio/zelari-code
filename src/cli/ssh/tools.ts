/**
 * Agent tools: ssh_status, ssh_run — OpenSSH via PATH.
 */
import { z } from 'zod';
import type { ToolDefinition } from '@zelari/core/harness/tools/toolTypes';
import { typedOk, typedErr } from '@zelari/core/harness/tools/toolTypes';
import {
  getSshTarget,
  isSshCommandAllowed,
  runSsh,
} from './targets.js';
import { verifyPlan, checkPlanConstraints } from './remoteJobPlan.js';

const STATUS_REMOTE =
  'set -e; echo "=== host ==="; hostname 2>/dev/null || true; uname -a 2>/dev/null || true; echo "=== uptime ==="; uptime 2>/dev/null || true; echo "=== disk / ==="; df -h / 2>/dev/null | tail -1 || true';

export function createSshTools(): ToolDefinition[] {
  if (process.env.ZELARI_SSH === '0') return [];

  const sshStatus: ToolDefinition = {
    name: 'ssh_status',
    description:
      'Run a fixed safe status probe on a configured SSH target (hostname, uname, uptime, disk). Use targetId from configured SSH targets.',
    permissions: ['network'],
    inputSchema: z.object({
      targetId: z.string().describe('Id of the SSH target from config'),
    }),
    execute: async (input) => {
      const { targetId } = input as { targetId: string };
      const t = getSshTarget(targetId);
      if (!t) {
        return typedErr(
          `Unknown SSH target "${targetId}". Configure targets in Desktop Settings → Connections or ~/.zelari-code/ssh-targets.json`,
        );
      }
      if (t.enabled === false) {
        return typedErr(`SSH target "${targetId}" is disabled`);
      }
      const r = await runSsh(t, STATUS_REMOTE, 30_000);
      const body = [
        `target=${t.id} ${t.user}@${t.host}:${t.port ?? 22}`,
        `exit=${r.code}`,
        r.stdout.trim(),
        r.stderr.trim() ? `stderr:\n${r.stderr.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      if (r.code !== 0) return typedErr(body || `ssh exit ${r.code}`);
      return typedOk(body);
    },
  };

  const sshRun: ToolDefinition = {
    name: 'ssh_run',
    description:
      'Run a remote command on a configured SSH target. Command must match the target allowlist (allowedCommands). ' +
      'Optionally pass a sealed RemoteJobPlan for anti-tamper verification (B6).',
    permissions: ['network'],
    inputSchema: z.object({
      targetId: z.string().describe('Id of the SSH target'),
      command: z
        .string()
        .describe('Remote command (must be allowlisted on the target)'),
      plan: z
        .object({
          type: z.string(),
          version: z.number(),
          data: z.record(z.string(), z.unknown()).optional(),
          maxOutputBytes: z.number().optional(),
          seal: z.string(),
        })
        .optional()
        .describe('Optional sealed RemoteJobPlan for anti-tamper verification'),
    }),
    execute: async (input) => {
      const { targetId, command, plan: rawPlan } = input as {
        targetId: string;
        command: string;
        plan?: unknown;
      };
      const t = getSshTarget(targetId);
      if (!t) {
        return typedErr(`Unknown SSH target "${targetId}"`);
      }
      if (t.enabled === false) {
        return typedErr(`SSH target "${targetId}" is disabled`);
      }
      // B6: verify plan integrity before execution (when provided).
      if (rawPlan) {
        const vr = verifyPlan(rawPlan);
        if (!vr.ok) return typedErr(`[remote-job-plan] ${vr.error} (code=${vr.code})`);
        const cr = checkPlanConstraints(vr.plan, {});
        if (!cr.ok) return typedErr(`[remote-job-plan] ${cr.error} (code=${cr.code})`);
      }
      const allow = isSshCommandAllowed(t, command);
      if (!allow.ok) return typedErr(allow.error);
      const r = await runSsh(t, command, 60_000);
      const body = [
        `target=${t.id} exit=${r.code}`,
        `$ ${command}`,
        r.stdout.trim(),
        r.stderr.trim() ? `stderr:\n${r.stderr.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      if (r.code !== 0) return typedErr(body || `ssh exit ${r.code}`);
      return typedOk(body);
    },
  };

  return [sshStatus, sshRun];
}
