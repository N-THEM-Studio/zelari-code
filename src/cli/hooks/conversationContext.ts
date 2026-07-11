/**
 * conversationContext — shared rolling provider history for all dispatch modes
 * (agent / council / zelari).
 *
 * v1.6.0 fixed single-agent context loss with an in-hook historyRef. That left
 * council/zelari stateless across turns, and /clear|/new never reset history —
 * so the model could still "forget" answers or leak prior sessions.
 *
 * This module is the single source of truth for provider-side AgentMessage[]
 * history. Hooks read/write it; slash handlers call clear() on /clear|/new.
 *
 * @since v1.8.0 (PR-A context unification)
 */

import type { AgentMessage } from '@zelari/core/harness';
import { compactHistory } from './historyCompaction.js';

/** Snapshot of the last assistant clarifying question (for short-answer anchoring). */
export interface LastClarification {
  question: string;
  choices: string[];
  /** Epoch ms when recorded. */
  at: number;
}

let history: AgentMessage[] = [];
let lastClarification: LastClarification | null = null;

/** Current rolling history (read-only view — callers must not mutate). */
export function getHistory(): readonly AgentMessage[] {
  return history;
}

/** Replace history after compaction / hydrate. */
export function setHistory(messages: readonly AgentMessage[]): void {
  history = [...messages];
}

/** Compact in place using the same rules as the agent loop. */
export function compactInPlace(): void {
  history = compactHistory(history);
}

/** Append messages (e.g. this turn's assistant+tool tail). */
export function appendMessages(msgs: readonly AgentMessage[]): void {
  if (msgs.length === 0) return;
  history = history.concat(msgs);
}

/** Drop everything ( /clear, /new ). */
export function clearHistory(): void {
  history = [];
  lastClarification = null;
}

/** Serialize for session sidecar / tests. */
export function serializeHistory(): AgentMessage[] {
  return [...history];
}

/** Hydrate from session restore. */
export function hydrateHistory(messages: readonly AgentMessage[]): void {
  history = [...messages];
}

export function getLastClarification(): LastClarification | null {
  return lastClarification;
}

export function setLastClarification(
  c: { question: string; choices: string[] } | null,
): void {
  lastClarification = c
    ? { question: c.question, choices: c.choices, at: Date.now() }
    : null;
}

/**
 * If the user sends a short reply that likely answers the last clarifying
 * question, return a rewritten user message that re-anchors the question so
 * the model cannot treat "full" / "2" / "sì" as a brand-new request.
 *
 * Returns null when no rewrite is needed (long free-form message, no prior
 * question, or history already carries enough context).
 */
export function maybeAnchorShortAnswer(userText: string): string | null {
  const clar = lastClarification;
  if (!clar) return null;
  const trimmed = userText.trim();
  if (!trimmed) return null;
  // Long free-form answers already carry intent — don't wrap.
  if (trimmed.length > 80 || trimmed.includes('\n')) return null;

  const lower = trimmed.toLowerCase();
  const choices = clar.choices;
  const matched =
    choices.find((c) => c.toLowerCase() === lower) ??
    choices.find((c) => c.toLowerCase().startsWith(lower)) ??
    choices.find((c) => lower.startsWith(c.toLowerCase().slice(0, Math.min(4, c.length))));

  // Also treat numeric picks ("1", "2") as choice indices (1-based).
  let choiceLabel = matched ?? null;
  if (!choiceLabel && /^\d{1,2}$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10) - 1;
    if (idx >= 0 && idx < choices.length) choiceLabel = choices[idx] ?? null;
  }

  // Very short replies without a choice match still get anchored if ≤ 24 chars
  // (e.g. "sì", "ok", "la seconda") — the model needs the prior question.
  if (!choiceLabel && trimmed.length > 24) return null;

  const picked = choiceLabel ?? trimmed;
  return (
    `The user is answering your previous clarifying question.\n` +
    `Question: ${clar.question}\n` +
    `Choices were: ${choices.join(' | ')}\n` +
    `User's answer: ${picked}\n` +
    `Proceed using this answer; do not re-ask the same question unless the answer is still ambiguous.`
  );
}

/**
 * Build a compact text block of recent conversation for council/zelari paths
 * that do not feed full AgentMessage[] into every member (token control).
 * Includes the last few user/assistant turns only.
 *
 * Uses **module** history (TUI long-lived process).
 */
export function formatHistoryForCouncil(maxTurns = 4): string {
  return formatHistoryMessages(history, maxTurns);
}

/**
 * Same as formatHistoryForCouncil but from an explicit message list
 * (Desktop headless: each spawn is a new process, module history is empty).
 */
export function formatHistoryMessages(
  messages: readonly AgentMessage[],
  maxTurns = 6,
  maxTotalChars = 12_000,
): string {
  if (messages.length === 0) return '';
  let turns = 0;
  const chunk: string[] = [];
  for (let i = messages.length - 1; i >= 0 && turns < maxTurns; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      chunk.push(`User: ${truncate(m.content, 800)}`);
      turns += 1;
    } else if (m.role === 'assistant' && m.content.trim()) {
      chunk.push(`Assistant: ${truncate(m.content, 2000)}`);
    }
  }
  if (chunk.length === 0) return '';
  let body = ['## Prior conversation (rolling context)', ...chunk.reverse()].join(
    '\n',
  );
  if (body.length > maxTotalChars) {
    body = `…\n${body.slice(body.length - maxTotalChars)}`;
  }
  return body;
}

const SHORT_CONTINUE =
  /^(procedi|continua|continue|go\s*ahead|go|ok|okay|sì|si|yes|vai|avanti|next|proceed)$/i;

/**
 * Build the user task for headless council/zelari with multi-turn context.
 * Desktop spawns a fresh process each message — history must come from
 * `opts.history`, not the in-process module store.
 */
export function buildCouncilTaskWithHistory(
  task: string,
  prior: readonly AgentMessage[] | undefined,
): string {
  const messages = prior ?? [];
  const trimmed = task.trim();

  // Prefer explicit short-answer anchor when a clarifying question was stored
  // (TUI). For headless, also treat continue-verbs against last assistant.
  let userPart = maybeAnchorShortAnswer(task) ?? task;

  if (
    messages.length > 0 &&
    (SHORT_CONTINUE.test(trimmed) ||
      (trimmed.length <= 40 && !trimmed.includes('\n')))
  ) {
    const lastAsst = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.content.trim());
    if (lastAsst && SHORT_CONTINUE.test(trimmed)) {
      userPart =
        `The user says "${trimmed}" — continue from the prior conversation. ` +
        `Do NOT restart from zero, do NOT re-ask for the overall goal, and do NOT ignore the prior plan/risks/decisions.\n\n` +
        `## Prior assistant output (authoritative context)\n` +
        `${truncate(lastAsst.content, 4500)}\n\n` +
        `## Instruction\n` +
        `Proceed with the next concrete steps implied by that context ` +
        `(implementation when the work phase is build; otherwise the next planned actions).`;
    }
  }

  const block = formatHistoryMessages(messages, 6, 12_000);
  if (!block) return userPart;
  // Avoid triple-duplicating if userPart already embeds prior assistant
  if (userPart.includes('Prior assistant output')) {
    return userPart;
  }
  return `${block}\n\n## Current user request\n${userPart}`;
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Test-only: reset module state. */
export function _resetConversationContextForTests(): void {
  history = [];
  lastClarification = null;
}
