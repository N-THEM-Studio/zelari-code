/**
 * requestSnapshot — deterministic snapshots of the routed provider request.
 *
 * Cache-aware context management (DSH-style) needs to know EXACTLY what was
 * sent to the provider on the previous request:
 *   - which system prefix was used (stable + volatile),
 *   - which tool schemas were advertised (and in which order),
 *   - which provider/model pair served the request,
 *   - how many prompt tokens it billed (and how many came from cache).
 *
 * `RoutedRequestSnapshot` captures that, plus two deterministic fingerprints:
 *   - `headerFingerprint`  — provider + model + system messages + tools.
 *     Changes when anything that shapes the request PREFIX changes.
 *   - `requestFingerprint` — header + full conversation. Changes when the
 *     tail changes while the header stays stable (the normal append case).
 *
 * Fingerprint stability rules:
 *   - object keys are sorted recursively (`stableStringify`) so key order
 *     in tool schemas / args cannot change the hash,
 *   - tools are sorted by `name.localeCompare` — the same canonical order
 *     the OpenAI-compatible provider applies on the wire, so the snapshot
 *     reflects the actual request bytes,
 *   - snapshots deep-clone their payload in `full` mode: later mutation of
 *     the live message array must not rewrite history.
 *
 * Int4b (`ZELARI_REQUEST_SNAPSHOT=full|lite|off`, default `full`):
 *   - `full` — current behavior (eager fingerprints, structuredClone).
 *   - `lite` — shallow first-level copies; fingerprints are lazy getters
 *     (same digest as `full` when read); header fingerprint memoized on
 *     tools-array identity + system key. Messages are not mutated after
 *     append in the tool loop, so shallow copies are safe on the hot path.
 *   - `off` — harness skips snapshot construction (metering stays; audit
 *     trail of routed requests is reduced).
 *
 * @since v1.36.0 — context/cache upgrade (routed request snapshots)
 */

import { createHash } from 'node:crypto';
import type { AgentMessage, AgentToolSpec } from './AgentHarness.js';

/** Provider-reported usage for the request a snapshot describes. */
export interface RequestUsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider prefix cache (DeepSeek/OpenAI). */
  cachedPromptTokens?: number;
}

/**
 * Immutable clone of one routed provider request.
 * Built by the harness right before every providerStream call.
 */
export interface RoutedRequestSnapshot {
  /** Provider id as routed (e.g. 'deepseek' — NOT the transport family). */
  provider: string;
  /** Model id as routed. */
  model: string;
  /** Leading `role:'system'` messages of the request (stable + volatile). */
  systemMessages: AgentMessage[];
  /** The conversation after the system prefix (user/assistant/tool). */
  conversation: AgentMessage[];
  /** Tool schemas as sent, in canonical lexicographic order. */
  tools: AgentToolSpec[];
  /** SHA-256 over {provider, model, systemMessages, tools}. */
  headerFingerprint: string;
  /** SHA-256 over {provider, model, systemMessages, tools, conversation}. */
  requestFingerprint: string;
  /** Epoch ms when the request was routed. */
  createdAt: number;
}

/** Optional generation knobs for a provider call (P3, context upgrade). */
export interface ProviderGenerationOptions {
  /** Who is asking: normal turns vs the compaction engine. */
  purpose?: 'conversation' | 'compaction' | 'build-recovery';
  temperature?: number;
  maxTokens?: number;
  /** Provider-neutral request for a tool call on a liveness recovery turn. */
  toolChoice?: 'auto' | 'required';
  /** One-based recovery attempt; provider profiles may force only an initial subset. */
  recoveryAttempt?: number;
}

export type RequestSnapshotMode = 'full' | 'lite' | 'off';

/** Default stays `full` until lite is dogfooded (Int4b). Unknown values → full. */
export function resolveRequestSnapshotMode(
  env: Record<string, string | undefined> = process.env,
): RequestSnapshotMode {
  const raw = env.ZELARI_REQUEST_SNAPSHOT?.trim().toLowerCase();
  if (raw === 'lite' || raw === 'off') return raw;
  return 'full';
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays in order.
 * No external deps (AGENTS.MD: zero new heavy dependencies).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    const items = value.map((v) => stableStringify(v));
    return `[${items.join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/** Short SHA-256 hex of a string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32);
}

function cloneMessagesDeep(messages: readonly AgentMessage[]): AgentMessage[] {
  return structuredClone(messages as AgentMessage[]);
}

function cloneMessagesLite(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((m) => ({ ...m }));
}

/** Canonical tool order — must match the wire order (openai-compatible.ts). */
export function canonicalTools(tools: readonly AgentToolSpec[]): AgentToolSpec[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

function cloneToolsDeep(tools: readonly AgentToolSpec[]): AgentToolSpec[] {
  return canonicalTools(tools).map((t) => structuredClone(t));
}

function cloneToolsLite(tools: readonly AgentToolSpec[]): AgentToolSpec[] {
  return canonicalTools(tools).map((t) => ({ ...t }));
}

interface HeaderMemo {
  toolsRef: readonly AgentToolSpec[];
  provider: string;
  model: string;
  systemKey: string;
  tools: AgentToolSpec[];
  headerFingerprint: string;
}

let headerMemo: HeaderMemo | null = null;

/** Test-only: drop the lite header memo. */
export function __resetRequestSnapshotMemoForTests(): void {
  headerMemo = null;
}

/**
 * Build a snapshot from the parameters of a provider call.
 * `full` (default): the snapshot owns deep clones.
 * `lite`: shallow first-level copies + lazy fingerprints (same digest).
 */
export function createRoutedRequestSnapshot(params: {
  messages: readonly AgentMessage[];
  model: string;
  provider: string;
  tools: readonly AgentToolSpec[];
  mode?: RequestSnapshotMode;
}): RoutedRequestSnapshot {
  const mode = params.mode ?? resolveRequestSnapshotMode();
  let split = 0;
  while (split < params.messages.length && params.messages[split].role === 'system') {
    split++;
  }
  const lite = mode === 'lite';
  const cloneMsg = lite ? cloneMessagesLite : cloneMessagesDeep;
  const systemMessages = cloneMsg(params.messages.slice(0, split));
  const conversation = cloneMsg(params.messages.slice(split));

  const createdAt = Date.now();
  const { provider, model } = params;

  if (!lite) {
    const tools = cloneToolsDeep(params.tools);
    const header = stableStringify({ provider, model, systemMessages, tools });
    const request = stableStringify({
      provider,
      model,
      systemMessages,
      tools,
      conversation,
    });
    return {
      provider,
      model,
      systemMessages,
      conversation,
      tools,
      headerFingerprint: sha256Hex(header),
      requestFingerprint: sha256Hex(request),
      createdAt,
    };
  }

  const systemKey = sha256Hex(stableStringify(systemMessages));
  let tools: AgentToolSpec[];
  let headerFp: string | undefined;
  if (
    headerMemo &&
    headerMemo.toolsRef === params.tools &&
    headerMemo.provider === provider &&
    headerMemo.model === model &&
    headerMemo.systemKey === systemKey
  ) {
    tools = headerMemo.tools;
    headerFp = headerMemo.headerFingerprint;
  } else {
    tools = cloneToolsLite(params.tools);
  }

  let requestFp: string | undefined;
  const snap = {
    provider,
    model,
    systemMessages,
    conversation,
    tools,
    createdAt,
    get headerFingerprint(): string {
      if (headerFp === undefined) {
        headerFp = sha256Hex(stableStringify({ provider, model, systemMessages, tools }));
        headerMemo = {
          toolsRef: params.tools,
          provider,
          model,
          systemKey,
          tools,
          headerFingerprint: headerFp,
        };
      }
      return headerFp;
    },
    get requestFingerprint(): string {
      if (requestFp === undefined) {
        requestFp = sha256Hex(
          stableStringify({ provider, model, systemMessages, tools, conversation }),
        );
      }
      return requestFp;
    },
  };
  return snap;
}

/**
 * Best-effort check (P11): is `messages` an exact prefix-extension of the
 * snapshot's conversation? Used for compaction telemetry — the cache reuse
 * expectation is informational, NEVER a correctness precondition.
 */
export function compareReplayPrefix(
  snapshot: RoutedRequestSnapshot,
  messages: readonly AgentMessage[],
): {
  exact: boolean;
  matchingMessages: number;
  mismatchIndex?: number;
} {
  const base = snapshot.conversation;
  const n = Math.min(base.length, messages.length);
  let matching = 0;
  for (let i = 0; i < n; i++) {
    if (stableStringify(base[i]) !== stableStringify(messages[i])) {
      return { exact: false, matchingMessages: matching, mismatchIndex: i };
    }
    matching++;
  }
  // Exact prefix (messages may be longer — that's the normal append case).
  return { exact: true, matchingMessages: matching };
}
