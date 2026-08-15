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
 *   - snapshots deep-clone their payload: later mutation of the live
 *     message array must not rewrite history.
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
  purpose?: 'conversation' | 'compaction';
  temperature?: number;
  maxTokens?: number;
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

function cloneMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return structuredClone(messages as AgentMessage[]);
}

/** Canonical tool order — must match the wire order (openai-compatible.ts). */
export function canonicalTools(tools: readonly AgentToolSpec[]): AgentToolSpec[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build a snapshot from the parameters of a provider call.
 * The snapshot owns deep clones — mutating `messages`/`tools` afterwards
 * does not affect it.
 */
export function createRoutedRequestSnapshot(params: {
  messages: readonly AgentMessage[];
  model: string;
  provider: string;
  tools: readonly AgentToolSpec[];
}): RoutedRequestSnapshot {
  // Split at the FIRST non-system message: the system prefix is whatever
  // leading run of role:'system' the request carried (1 or 2 messages in
  // the current builders — the split must not assume a fixed count).
  let split = 0;
  while (split < params.messages.length && params.messages[split].role === 'system') {
    split++;
  }
  const systemMessages = cloneMessages(params.messages.slice(0, split));
  const conversation = cloneMessages(params.messages.slice(split));
  const tools = canonicalTools(params.tools).map((t) => structuredClone(t));

  const header = stableStringify({
    provider: params.provider,
    model: params.model,
    systemMessages,
    tools,
  });
  const request = stableStringify({
    provider: params.provider,
    model: params.model,
    systemMessages,
    tools,
    conversation,
  });

  return {
    provider: params.provider,
    model: params.model,
    systemMessages,
    conversation,
    tools,
    headerFingerprint: sha256Hex(header),
    requestFingerprint: sha256Hex(request),
    createdAt: Date.now(),
  };
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
