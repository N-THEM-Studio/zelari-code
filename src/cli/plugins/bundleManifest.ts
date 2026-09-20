/**
 * plugins/bundleManifest — the WS6 plugin BUNDLE manifest, format v1.
 *
 * A *bundle* is a DIRECTORY holding one manifest (`zelari-plugin.json`) plus
 * the files it declares:
 *
 * ```json
 * {
 *   "$comment": "optional documentation slot — accepted and stripped",
 *   "formatVersion": 1,
 *   "name": "my-bundle",
 *   "version": "1.0.0",
 *   "description": "what it gives you",
 *   "skills": [{ "id": "repo-hygiene", "path": "skills/repo-hygiene/SKILL.md" }],
 *   "hooks":  [{ "event": "PermissionRequest", "path": "hooks/observer.json" }],
 *   "mcp":    [{ "name": "my-server", "preset": "unreal-mcp" }],
 *   "agents": [{ "id": "auditor", "path": "agents/auditor.md" }]
 * }
 * ```
 *
 * This module is PURE: it parses and validates TEXT. It never touches the
 * filesystem (does a declared `path` EXIST? — see bundleLoad.ts) and never
 * executes anything. Every schema is `.strict()`: an unknown key is a
 * MALFORMED manifest, not a silently ignored option — the `$comment`
 * documentation slot is the one exception, ACCEPTED AND STRIPPED exactly as in
 * `safety/permissionPolicy.ts`, so a comment can never change a decision.
 *
 * Errors always NAME the file and the offending field
 * (`<file>: invalid bundle manifest at 'skills.0.path': …`), and ALL problems
 * are reported — a validator that stops at the first typo turns fixing a
 * manifest into a guessing game.
 *
 * @since v2.58.0 (WS6 / plugin bundle v1)
 */
import path from 'node:path';
import { z } from 'zod';
import type { AnyHookEvent } from '@zelari/core/harness';

/** Manifest file name expected inside a bundle directory. */
export const BUNDLE_MANIFEST_FILE = 'zelari-plugin.json';

/** The only format this CLI understands. A future v2 must not load as v1. */
export const BUNDLE_FORMAT_VERSION = 1;

/** Slug rule for bundle name / skill id / agent id (mirrors skillsMd.ts). */
export const BUNDLE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** MCP server-name rule — mirrors the one `upsertMcpServer` enforces. */
export const BUNDLE_MCP_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Every event a bundle hook may declare: the four v1.32 GATE events plus the
 * four v2.57 OBSERVER events (WS5). `satisfies readonly AnyHookEvent[]` makes
 * the compiler reject a typo or a renamed event here; `OBSERVER_HOOK_EVENTS`
 * has no runtime counterpart for the gate half, so
 * `tests/unit/plugin-bundle.test.ts` additionally asserts this list still
 * contains every event core exports as an observer.
 */
export const BUNDLE_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'SessionEnd',
  'PermissionRequest',
  'SubagentStart',
  'SubagentEnd',
  'Notification',
] as const satisfies readonly AnyHookEvent[];
export type BundleHookEvent = (typeof BUNDLE_HOOK_EVENTS)[number];

/**
 * `$comment` — the ONE non-config key these schemas tolerate. ACCEPTED AND
 * STRIPPED: never validated, never reaching any consumer, so documentation can
 * never change behaviour. Every other unknown key stays fatal (same contract
 * as the WS1 permission policy).
 */
const commentSchema = z.string().optional();

/** Shallow copy of a validated object without its documentation slot. */
function stripComment<T extends object>(value: T & { $comment?: string }): Omit<T, '$comment'> {
  const { $comment: _comment, ...rest } = value;
  return rest;
}

/**
 * A declared path must stay INSIDE the bundle directory: relative, no drive
 * letter / root, no `..` segment. `path.win32.isAbsolute` is checked too, so a
 * `C:\…` path is rejected even when the validator itself runs on POSIX.
 */
function escapesBundleRoot(p: string): boolean {
  if (path.isAbsolute(p) || path.win32.isAbsolute(p)) return true;
  return p.split(/[\\/]+/).includes('..');
}

const bundleRelativePath = z
  .string()
  .min(1)
  .refine((p) => !escapesBundleRoot(p), {
    message: 'must be a path relative to the bundle directory (no absolute path, no "..")',
  });

const bundleSlug = (what: string) =>
  z.string().regex(BUNDLE_SLUG_RE, `${what} must be a slug: lowercase letters, digits, hyphens (max 64)`);

/** `skills: [{ id, path }]` — one SKILL.md the bundle ships. */
export const BundleSkillRefSchema = z
  .object({
    $comment: commentSchema,
    id: bundleSlug('skill id'),
    path: bundleRelativePath,
  })
  .strict()
  .transform(stripComment);
export type BundleSkillRef = z.infer<typeof BundleSkillRefSchema>;

/**
 * `hooks: [{ event, path, config? }]` — one hook definition FILE plus an
 * optional overlay.
 *
 * `config` may set ONLY `timeoutMs` / `cwd`: the hook file stays authoritative
 * for `command` / `url` / `match` / `name`, so a manifest can never smuggle an
 * executable that the hook file does not already declare.
 */
export const BundleHookRefSchema = z
  .object({
    $comment: commentSchema,
    event: z.enum(BUNDLE_HOOK_EVENTS, {
      message: `unknown hook event (expected one of: ${BUNDLE_HOOK_EVENTS.join(', ')})`,
    }),
    path: bundleRelativePath,
    config: z
      .object({
        timeoutMs: z.number().int().positive().optional(),
        cwd: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .transform(stripComment);
export type BundleHookRef = z.infer<typeof BundleHookRefSchema>;

/**
 * `mcp: [{ name, preset | command, args? }]` — exactly ONE of `preset`
 * (a repo preset id, resolved by `mcp/mcpPresets.ts`) or `command` (a stdio
 * server) must be given. No `env`: secrets never travel inside a bundle — a
 * preset factory reads its key from the environment at APPLY time.
 */
export const BundleMcpRefSchema = z
  .object({
    $comment: commentSchema,
    name: z
      .string()
      .regex(BUNDLE_MCP_NAME_RE, 'mcp name must use letters, digits, underscore or hyphen'),
    preset: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
  })
  .strict()
  .transform(stripComment)
  .refine((m) => (m.preset === undefined) !== (m.command === undefined), {
    message: 'exactly one of "preset" (repo preset id) or "command" (stdio server) is required',
    path: ['preset'],
  });
export type BundleMcpRef = z.infer<typeof BundleMcpRefSchema>;

/**
 * `agents: [{ id, path, description? }]` — declared, validated, surfaced as a
 * contribution, NOT executed: WS6 ships no agent loader (see the debt in
 * docs/TOOLS.md).
 */
export const BundleAgentRefSchema = z
  .object({
    $comment: commentSchema,
    id: bundleSlug('agent id'),
    path: bundleRelativePath,
    description: z.string().min(1).optional(),
  })
  .strict()
  .transform(stripComment);
export type BundleAgentRef = z.infer<typeof BundleAgentRefSchema>;

/** The bundle manifest envelope (`.strict()`: unknown key ⇒ malformed). */
export const BundleManifestSchema = z
  .object({
    $comment: commentSchema,
    formatVersion: z
      .literal(BUNDLE_FORMAT_VERSION, {
        message: `unsupported bundle format — this CLI reads formatVersion ${BUNDLE_FORMAT_VERSION}`,
      })
      .optional()
      .default(BUNDLE_FORMAT_VERSION),
    name: bundleSlug('bundle name'),
    version: z.string().min(1),
    description: z.string().min(1).optional(),
    skills: z.array(BundleSkillRefSchema).default([]),
    hooks: z.array(BundleHookRefSchema).default([]),
    mcp: z.array(BundleMcpRefSchema).default([]),
    agents: z.array(BundleAgentRefSchema).default([]),
  })
  .strict()
  .transform(stripComment);
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

/** Format every zod issue as `<file>: invalid bundle manifest at '<field>': <why>`. */
function formatIssues(error: z.ZodError, filePath: string): string[] {
  return error.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.join('.') : 'file';
    return `${filePath}: invalid bundle manifest at '${at}': ${issue.message}`;
  });
}

/**
 * Cross-field rules zod cannot express per-field: an ambiguous manifest
 * (two entries fighting for the same id / server name) is REJECTED rather than
 * silently resolved, so "which one won" can never depend on array order.
 */
function duplicateErrors(manifest: BundleManifest, filePath: string): string[] {
  const errors: string[] = [];
  const check = (
    values: readonly string[],
    kind: string,
    field: string,
  ): void => {
    const seen = new Set<string>();
    values.forEach((value, i) => {
      if (seen.has(value)) {
        errors.push(`${filePath}: invalid bundle manifest at '${field}.${i}': duplicate ${kind} '${value}'`);
      }
      seen.add(value);
    });
  };
  check(manifest.skills.map((s) => s.id), 'skill id', 'skills');
  check(manifest.mcp.map((m) => m.name), 'mcp server name', 'mcp');
  check(manifest.agents.map((a) => a.id), 'agent id', 'agents');
  return errors;
}

export interface BundleManifestParseResult {
  /** Present only when `errors` is empty. */
  manifest?: BundleManifest;
  errors: string[];
}

/**
 * Parse manifest TEXT (already read from disk). Invalid JSON, a schema
 * violation, an unknown key (`$comment` aside), a declared path escaping the
 * bundle root, or a duplicate id all come back as `errors` naming the file and
 * the field; `manifest` is then absent — never a half-usable manifest.
 */
export function parseBundleManifest(raw: string, filePath: string): BundleManifestParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { errors: [`${filePath}: invalid JSON (${detail})`] };
  }
  const parsed = BundleManifestSchema.safeParse(json);
  if (!parsed.success) return { errors: formatIssues(parsed.error, filePath) };
  const errors = duplicateErrors(parsed.data, filePath);
  if (errors.length > 0) return { errors };
  return { manifest: parsed.data, errors: [] };
}
