import path from 'node:path';
import os from 'node:os';
import { SkillHistoryLogger, readSkillHistory, getSkillStats } from '../skillHistory.js';
import { FeedbackStore } from '../councilFeedback.js';
import { compareSkillsFromFile } from '../hooks/skillCompare.js';
import { appendSystem } from '../hooks/messageHelpers.js';
import { applySteerInterrupt } from '../hooks/steer.js';
import type { ChatMessage } from '../components/ChatStream.js';
import type { AgentHarness } from '@zelari/core/harness';
import type { CodingSkillDefinition } from '@zelari/core/skills';
import type { PickerRequest } from './provider.js';
import { formatSkillList } from '../slashCommands.js';

/**
 * Slash command handlers — skill invocation, stats, compare, council feedback,
 * steer / steer --interrupt. Extracted from app.tsx (Task v0.4.2 audit split).
 */
export interface SkillSlashContext {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setInput: (v: string) => void;
  setBusy: (v: boolean) => void;
  sessionId: string;
}

type OpenPicker = (req: PickerRequest) => void;

/**
 * `/skills` or `/skill` with no args — interactive SelectList of skills.
 * Selection re-enters the slash pipeline as `/skill <id>`.
 */
export function handleSkillPicker(
  ctx: SkillSlashContext,
  skills: readonly CodingSkillDefinition[],
  openPicker?: OpenPicker,
  fallbackMessage?: string,
): void {
  if (!openPicker) {
    appendSystem(
      ctx.setMessages,
      fallbackMessage ?? formatSkillList(skills),
    );
    return;
  }
  if (skills.length === 0) {
    appendSystem(ctx.setMessages, '[skills] no skills registered');
    return;
  }
  const items = [...skills]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({
      value: s.id,
      label: s.name || s.id,
      hint: [s.category, s.estimatedCost, s.description?.slice(0, 60)]
        .filter(Boolean)
        .join(' · '),
    }));
  openPicker({
    kind: 'skill',
    title: 'Select a skill',
    items,
    commandPrefix: '/skill',
  });
}

export async function handleSkillStats(
  ctx: SkillSlashContext,
  skillId: string | undefined,
): Promise<void> {
  const historyFile = process.env.ANATHEMA_SKILL_HISTORY_FILE
    ?? path.join(os.homedir(), '.tmp', 'zelari-code', 'skill-history.jsonl');
  try {
    const records = await readSkillHistory(historyFile);
    const stats = getSkillStats(records, skillId);
    const label = skillId ?? 'all skills';
    const formatted = stats.count === 0
      ? `[skill-stats] ${label}: no invocations recorded yet`
      : `[skill-stats] ${label}: ${stats.count} invocations, ${(stats.successRate * 100).toFixed(1)}% success, avg ${stats.avgDurationMs.toFixed(0)}ms, ${stats.totalTokens} tokens total`;
    appendSystem(ctx.setMessages, formatted);
  } catch (err) {
    appendSystem(ctx.setMessages, `[skill-stats error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleSkillCompare(
  ctx: SkillSlashContext,
  ids: [string, string] | undefined,
  fallbackMessage?: string,
): Promise<void> {
  if (!ids) {
    appendSystem(ctx.setMessages, fallbackMessage ?? '[skill-compare] missing args');
    return;
  }
  const historyFile = process.env.ANATHEMA_SKILL_HISTORY_FILE
    ?? path.join(os.homedir(), '.tmp', 'zelari-code', 'skill-history.jsonl');
  try {
    const formatted = await compareSkillsFromFile(ids[0], ids[1], historyFile);
    appendSystem(ctx.setMessages, formatted);
  } catch (err) {
    appendSystem(ctx.setMessages, `[skill-compare error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function handleCouncilFeedback(
  ctx: SkillSlashContext,
  memberId: string,
  score: number,
  note: string | undefined,
): void {
  try {
    const store = new FeedbackStore();
    const entry = store.record({
      memberId,
      score,
      ...(note ? { note } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    });
    const stats = store.getStats(memberId);
    appendSystem(
      ctx.setMessages,
      `[council-feedback] ${memberId} rated ${entry.score}/5` +
        ` — running avg ${stats.avg.toFixed(2)} over ${stats.count} rating(s).`,
    );
  } catch (err) {
    appendSystem(
      ctx.setMessages,
      `[council-feedback] failed: ${err instanceof Error ? err.message : 'Unknown'}`,
    );
  }
}

export interface SteerContext extends SkillSlashContext {
  harnessRef: React.MutableRefObject<AgentHarness | null>;
  setQueueCount: (n: number) => void;
  dispatchPrompt: (text: string) => Promise<void>;
}

export async function handleSteer(
  ctx: SteerContext,
  text: string | undefined,
  usageHint: string | undefined,
): Promise<void> {
  if (!text) {
    if (usageHint) appendSystem(ctx.setMessages, usageHint);
    return;
  }
  // Route through the shared interrupt helper so /steer --interrupt and
  // /steer stay behaviorally consistent.
  await applySteerInterrupt({
    text,
    harness: ctx.harnessRef.current
      ? {
          enqueue: (t: string) => ctx.harnessRef.current?.enqueue(t),
          cancel: () => ctx.harnessRef.current?.cancel(),
          queueLength: ctx.harnessRef.current?.queueLength ?? 0,
        }
      : null,
    appendMessage: (content) => appendSystem(ctx.setMessages, content),
    setQueueCount: ctx.setQueueCount,
    dispatchPrompt: ctx.dispatchPrompt,
  });
}

export function handleClearChat(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setSessionActive: (v: boolean) => void,
): void {
  // v0.7.0 static-scrollback: <Static> can't retro-erase the lines it already
  // printed to real stdout (they are in the terminal's native scrollback).
  // Emit ANSI clear-screen + scrollback-wipe + cursor-home so the visible
  // pane and the scrollback are cleared together. Windows Terminal honors all
  // three; legacy conhost ignores `3J` (scrollback wipe) — acceptable
  // degradation, the visible pane still clears.
  //
  //   \x1b[2J  — clear visible screen
  //   \x1b[3J  — clear scrollback history
  //   \x1b[H   — cursor home
  try {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  } catch {
    // Best-effort — never block a /clear on a stdout write error.
  }
  setMessages([]);
  setSessionActive(false);
}