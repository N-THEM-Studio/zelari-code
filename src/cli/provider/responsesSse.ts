/**
 * Shared SSE event loop for the OpenAI Responses wire format — used by both
 * `chatgpt.ts` (ChatGPT OAuth) and `responsesApi.ts` (API-key providers,
 * muse). One loop, one contract: the two adapters used to carry byte-identical
 * copies that drifted into the same bug.
 *
 * Tool-call args (2026-09-24, muse tentacles lost every tool arg):
 *   - Correlation: per the Responses spec a function_call item has TWO ids —
 *     `item.id` (`fc_…`) and `item.call_id` (`call_…`) — and
 *     `response.function_call_arguments.delta|done` reference `item_id`, i.e.
 *     `item.id`, not `call_id`. The old loop keyed calls by `call_id` only, so
 *     every delta from a spec-conformant server missed its call and args were
 *     silently dropped (`{}`). Calls are now indexed by call_id, item id and
 *     output_index; the emitted `toolCallId` stays `call_id` (the id
 *     `function_call_output` must echo back).
 *   - Completion channels: `response.function_call_arguments.done.arguments`
 *     and `response.output_item.done.item.arguments` carry the FULL args. When
 *     non-empty they are authoritative (for delta-streaming servers they equal
 *     the concatenated deltas, so behaviour is unchanged); servers that never
 *     stream deltas now work. Object-shaped args are JSON-encoded.
 *   - A `done` item with no prior `added` is still a call (never dropped).
 *   - `tool_args_missing` (advisory, loud): an empty payload for a tool whose
 *     declared schema has `required` params is reported on the error channel,
 *     and the call still flows to validation so the model gets actionable
 *     feedback (schema-repair hints) instead of a dropped call.
 *
 * Diagnostics: `ZELARI_PROVIDER_FRAME_DEBUG=1` writes one stderr line per SSE
 * event — type, correlation ids and the SHAPE of any args (typeof + length),
 * never their content. Zero cost when unset.
 */
import type { ProviderDelta } from '@zelari/core/harness';
import {
  PROVIDER_STREAM_IDLE_MS,
  PROVIDER_STREAM_MAX_MS,
  parseCachedPromptTokens,
  readChunkWithTimeout,
} from './openai-compatible.js';
import { formatToolArgsParseError, parseToolArgsJson } from './toolArgs.js';

/** Guard code for a call whose args arrived empty although the tool requires some. */
export const TOOL_ARGS_MISSING_CODE = 'tool_args_missing';

export interface ResponsesSseOptions {
  signal?: AbortSignal;
  /** Tools declared on the request — used only for the `required` check. */
  tools?: ReadonlyArray<{ name: string; parameters?: unknown }>;
  /** Adapter label for frame-debug lines (`chatgpt`, `responses:muse`, …). */
  label: string;
}

interface PendingCall {
  callId: string;
  name: string;
  argsJson: string;
}

type Json = Record<string, unknown>;

/** Full-args payload from a `done` channel: strings as-is, objects encoded. */
function fullArgs(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw !== null && typeof raw === 'object') return JSON.stringify(raw);
  return '';
}

function requiredParams(tools: ResponsesSseOptions['tools'], name: string): string[] {
  const schema = tools?.find((t) => t.name === name)?.parameters as { required?: unknown } | undefined;
  return Array.isArray(schema?.required)
    ? schema.required.filter((r): r is string => typeof r === 'string')
    : [];
}

function argsShape(raw: unknown): string {
  if (raw === undefined) return '-';
  return typeof raw === 'string' ? `string(${raw.length})` : raw === null ? 'null' : typeof raw;
}

function describeFrame(type: string, ev: Json): string {
  const item = (ev.item ?? {}) as Json;
  const parts = [type || '(untyped)'];
  const add = (k: string, v: unknown) => {
    if (v !== undefined) parts.push(`${k}=${String(v)}`);
  };
  add('item_id', ev.item_id);
  add('call_id', ev.call_id);
  add('output_index', ev.output_index);
  if (ev.item) {
    add('item.type', item.type);
    add('item.id', item.id);
    add('item.call_id', item.call_id);
    add('item.name', item.name);
    parts.push(`item.arguments=${argsShape(item.arguments)}`);
  }
  if ('delta' in ev) parts.push(`delta=${argsShape(ev.delta)}`);
  if ('arguments' in ev) parts.push(`arguments=${argsShape(ev.arguments)}`);
  return parts.join(' ');
}

function failureMessage(ev: Json): string {
  if (typeof ev.message === 'string') return ev.message;
  const nested = ((ev.response as Json | undefined)?.error ?? ev.error) as Json | undefined;
  if (typeof nested?.message === 'string') return nested.message;
  return JSON.stringify(nested ?? ev).slice(0, 200);
}

export async function* readResponsesSse(
  body: ReadableStream<Uint8Array>,
  opts: ResponsesSseOptions,
): AsyncGenerator<ProviderDelta> {
  const frameDebug = process.env.ZELARI_PROVIDER_FRAME_DEBUG === '1';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  /** Every correlation key (call_id, item id, `#output_index`) → its call. */
  const index = new Map<string, PendingCall>();
  /** Pending calls in arrival order (final flush + keyless-delta fallback). */
  const pending: PendingCall[] = [];
  /** Keys of calls already flushed: a late frame for them must not hit another call. */
  const closed = new Set<string>();
  let emittedTool = false;
  let syntheticIds = 0;

  const keysOf = (ids: unknown[], outputIndex: unknown): string[] => {
    const keys = ids.filter((v) => typeof v === 'string' && v.length > 0) as string[];
    if (typeof outputIndex === 'number') keys.push(`#${outputIndex}`);
    return keys;
  };
  const find = (keys: string[]): PendingCall | undefined => {
    for (const k of keys) {
      const hit = index.get(k);
      if (hit) return hit;
    }
    return undefined;
  };
  /**
   * Target of an args event. Falls back to the latest pending call only when
   * that cannot misattribute: the event carries no correlation key, or a
   * single call is open. Otherwise an unmatched delta is ignored and the
   * `done` channels (full args) still settle the call.
   */
  const target = (ev: Json): PendingCall | undefined => {
    const keys = keysOf([ev.item_id, ev.call_id], ev.output_index);
    const hit = find(keys);
    if (hit) return hit;
    if (keys.some((k) => closed.has(k))) return undefined;
    return keys.length === 0 || pending.length === 1 ? pending.at(-1) : undefined;
  };
  const track = (call: PendingCall, keys: string[]) => {
    for (const k of keys) index.set(k, call);
  };
  const open = (item: Json, keys: string[]): PendingCall => {
    const callId = String(item.call_id ?? item.id ?? `fc-${syntheticIds++}`);
    const call: PendingCall = {
      callId,
      name: typeof item.name === 'string' ? item.name : '',
      argsJson: fullArgs(item.arguments),
    };
    pending.push(call);
    track(call, [callId, ...keys]);
    return call;
  };

  const flush = function* (call: PendingCall): Generator<ProviderDelta> {
    const at = pending.indexOf(call);
    if (at < 0) return;
    pending.splice(at, 1);
    for (const [k, v] of index) {
      if (v !== call) continue;
      index.delete(k);
      closed.add(k);
    }
    if (!call.name) return;
    // K4.1: malformed args JSON is a loud typed error (tool_args_parse_failed)
    // on the stream error channel — never a silent `args = {}` degradation.
    const parsed = parseToolArgsJson(call.argsJson, call.callId);
    emittedTool = true;
    if (!parsed.ok) {
      yield { kind: 'error', message: formatToolArgsParseError(parsed.error) };
      return;
    }
    if (call.argsJson.trim() === '') {
      const required = requiredParams(opts.tools, call.name);
      if (required.length > 0) {
        yield {
          kind: 'error',
          message:
            `${TOOL_ARGS_MISSING_CODE}: tool call ${call.callId} (${call.name}) arrived with no ` +
            `arguments but requires [${required.join(', ')}]; forwarded to validation. If the model ` +
            `did send arguments the provider stream dropped them — set ZELARI_PROVIDER_FRAME_DEBUG=1.`,
        };
      }
    }
    yield { kind: 'tool_call', toolCallId: call.callId, toolName: call.name, args: parsed.args };
  };

  /** Handle one SSE event; returns true when the stream reached a terminal event. */
  const handle = function* (ev: Json): Generator<ProviderDelta, boolean> {
    const type = typeof ev.type === 'string' ? ev.type : '';
    if (frameDebug) process.stderr.write(`[frame:${opts.label}] ${describeFrame(type, ev)}\n`);
    if (type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      yield { kind: 'text', delta: ev.delta };
    } else if (type === 'response.reasoning_text.delta' && typeof ev.delta === 'string') {
      yield { kind: 'thinking', delta: ev.delta };
    } else if (type === 'response.output_item.added') {
      const item = ev.item as Json | undefined;
      if (item?.type === 'function_call') {
        const keys = keysOf([item.call_id, item.id], ev.output_index);
        const known = find(keys);
        if (known) {
          track(known, keys);
          if (typeof item.call_id === 'string' && item.call_id) known.callId = item.call_id;
        } else open(item, keys);
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const call = target(ev);
      if (call && typeof ev.delta === 'string') call.argsJson += ev.delta;
    } else if (type === 'response.function_call_arguments.done') {
      const call = target(ev);
      const full = fullArgs(ev.arguments);
      if (call && full.trim() !== '') call.argsJson = full;
      if (call && !call.name && typeof ev.name === 'string') call.name = ev.name;
    } else if (type === 'response.output_item.done') {
      const item = ev.item as Json | undefined;
      if (item?.type === 'function_call') {
        const keys = keysOf([item.call_id, item.id], ev.output_index);
        const call = find(keys) ?? open(item, keys);
        // `call_id` is what function_call_output must echo; adopt it even when
        // the `added` frame only carried the item id.
        if (typeof item.call_id === 'string' && item.call_id) call.callId = item.call_id;
        const full = fullArgs(item.arguments);
        if (full.trim() !== '') call.argsJson = full;
        if (!call.name && typeof item.name === 'string') call.name = item.name;
        yield* flush(call);
      }
    } else if (type === 'response.completed') {
      const usage = (
        ev.response as
          | { usage?: Record<string, number> & { input_tokens_details?: { cached_tokens?: number } } }
          | undefined
      )?.usage;
      for (const call of [...pending]) yield* flush(call);
      if (usage) {
        const cached = parseCachedPromptTokens(usage);
        yield {
          kind: 'usage',
          usage: {
            promptTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
            completionTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
            ...(cached > 0 ? { cachedPromptTokens: cached } : {}),
          },
        };
      }
      yield { kind: 'finish', reason: emittedTool ? 'tool_calls' : 'stop' };
      return true;
    } else if (type === 'response.failed' || type === 'error') {
      yield { kind: 'error', message: failureMessage(ev) };
      return true;
    }
    return false;
  };

  const parseLine = (line: string): Json | null => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return null;
    try {
      return JSON.parse(data) as Json;
    } catch {
      return null;
    }
  };

  // Stream watchdog (same policy as openai-compatible.ts): idle measures
  // silence since the last USEFUL event (SSE pings don't count), max is the
  // absolute cap on the stream.
  const streamStartedAt = Date.now();
  let lastUsefulAt = streamStartedAt;
  const streamDeadline = streamStartedAt + PROVIDER_STREAM_MAX_MS;

  try {
    while (true) {
      const { value, done } = await readChunkWithTimeout(reader, {
        idleMs: PROVIDER_STREAM_IDLE_MS,
        deadlineMs: streamDeadline,
        signal: opts.signal,
        lastUsefulAt: () => lastUsefulAt,
      });
      // At EOF the unterminated tail (a last frame without '\n') still counts.
      if (done) buffer += '\n';
      else buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const ev = parseLine(line);
        if (!ev) continue;
        if (typeof ev.type === 'string' && ev.type) lastUsefulAt = Date.now();
        if (yield* handle(ev)) return;
      }
      if (done) break;
    }
    for (const call of [...pending]) yield* flush(call);
    yield { kind: 'finish', reason: emittedTool ? 'tool_calls' : 'stop' };
  } finally {
    reader.releaseLock();
  }
}
