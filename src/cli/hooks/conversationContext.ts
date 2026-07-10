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
 */
export function formatHistoryForCouncil(maxTurns = 4): string {
  if (history.length === 0) return '';
  const lines: string[] = [];
  // Walk from the end; collect up to maxTurns user+assistant pairs.
  let turns = 0;
  const chunk: string[] = [];
  for (let i = history.length - 1; i >= 0 && turns < maxTurns; i--) {
    const m = history[i];
    if (m.role === 'user') {
      chunk.push(`User: ${truncate(m.content, 400)}`);
      turns += 1;
    } else if (m.role === 'assistant' && m.content.trim()) {
      chunk.push(`Assistant: ${truncate(m.content, 600)}`);
    }
  }
  if (chunk.length === 0) return '';
  lines.push('## Prior conversation (rolling context)');
  lines.push(...chunk.reverse());
  return lines.join('\n');
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
