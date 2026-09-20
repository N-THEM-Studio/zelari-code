/**
 * plugins/bundleHookDef — validate a hook definition FILE a bundle declares.
 *
 * The core runner (`LifecycleHookRunner.loadDir`) checks only `name` + `match`
 * before loading a `*.json` hook, so a file missing `command`/`url` loads fine
 * and then fails at CALL time. A bundle is validated up front instead:
 *
 *   - shape: `name`, `match.events` (non-empty), exactly one of `command`|`url`;
 *   - the event the MANIFEST declares must be one of the events the FILE
 *     subscribes to — otherwise the hook would be "loaded" and never fire,
 *     which is the failure mode a static validator exists to catch;
 *   - events outside the bundle vocabulary are reported as warnings, never as
 *     errors: they are the hook file's business, not the bundle's.
 *
 * It never spawns anything: this module only reads JSON text.
 *
 * @since v2.58.0 (WS6 / plugin bundle v1)
 */
import type { AnyHookEvent, HookDefinition } from '@zelari/core/harness';
import { BUNDLE_HOOK_EVENTS, type BundleHookEvent } from './bundleManifest.js';
import { isRecord } from './bundleFs.js';

/** Runtime guard for the bundle hook-event vocabulary. */
export function isBundleHookEvent(value: unknown): value is BundleHookEvent {
  return typeof value === 'string' && (BUNDLE_HOOK_EVENTS as readonly string[]).includes(value);
}

export interface HookDefinitionReadResult {
  definition?: HookDefinition;
  error?: string;
}

/**
 * Validate `raw` (the hook file's text) as a `HookDefinition` that subscribes
 * to `event`. Returns either a definition ready for `runner.addHook` or an
 * error naming the FILE and what is wrong — never both, never a partial one.
 *
 * `warnings` collects non-fatal observations (e.g. an event the bundle
 * vocabulary does not know).
 */
export function readHookDefinition(
  raw: string,
  file: string,
  event: BundleHookEvent,
  warnings: string[],
): HookDefinitionReadResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { error: `${file}: invalid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!isRecord(json)) return { error: `${file}: hook definition must be a JSON object` };

  const name = json['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    return { error: `${file}: hook definition is missing a non-empty "name"` };
  }
  const match = json['match'];
  if (!isRecord(match)) {
    return { error: `${file}: hook definition is missing a "match" object` };
  }
  const events = match['events'];
  if (!Array.isArray(events) || events.length === 0) {
    return { error: `${file}: hook "match.events" must be a non-empty array` };
  }
  if (!events.includes(event)) {
    return {
      error: `${file}: hook does not subscribe to '${event}' (match.events: ${events.join(', ')})`,
    };
  }
  const hasCommand = typeof json['command'] === 'string' && json['command'].trim() !== '';
  const hasUrl = typeof json['url'] === 'string' && (json['url'] as string).trim() !== '';
  if (hasCommand === hasUrl) {
    return { error: `${file}: exactly one of "command" or "url" is required` };
  }
  for (const extra of events) {
    if (isBundleHookEvent(extra)) continue;
    warnings.push(`${file}: hook also lists non-bundle event '${String(extra)}' (ignored by the bundle)`);
  }

  const tools = match['tools'];
  const definition: HookDefinition = {
    name,
    match: {
      tools: Array.isArray(tools) ? tools.map(String) : ['*'],
      events: events as AnyHookEvent[],
    },
  };
  if (hasCommand) definition.command = json['command'] as string;
  if (hasUrl) definition.url = json['url'] as string;
  if (typeof json['timeoutMs'] === 'number') definition.timeoutMs = json['timeoutMs'];
  if (typeof json['cwd'] === 'string') definition.cwd = json['cwd'];
  return { definition };
}
