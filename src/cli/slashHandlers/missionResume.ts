/**
 * missionResume.ts — /resume-mission slash handler (experimental/cursor-learn 2.3).
 *
 * TUI twin of the headless `--resume-mission` flag and of the Desktop
 * "Riprendi" pill: resumes (or inspects) the mission persisted in
 * `.zelari/mission-state.json` (state file owned by zelariMission.ts).
 *
 *   /resume-mission          — resume the persisted mission in this TUI
 *   /resume-mission status   — show the persisted mission status (no run)
 *
 * The actual resume run is dispatched by useChatTurn.dispatchZelariResume
 * (same resumeZelariMission seam as src/cli/runHeadless.ts --resume-mission).
 *
 * @since experimental/cursor-learn (2.3)
 */

import type { ChatMessage } from '../components/ChatStream.js';
import { appendSystem } from '../hooks/messageHelpers.js';
import {
  loadMissionState,
  type MissionState,
  type MissionStatus,
} from '../zelariMission.js';

export interface MissionResumeHandlerCtx {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

/** Italian one-word label per mission status (mirrors Desktop missionState). */
export function missionStatusLabel(status: MissionStatus): string {
  switch (status) {
    case 'running':
      return 'in corso';
    case 'success':
      return 'completata';
    case 'stopped':
      return 'ferma';
    case 'stalled':
      return 'in stallo';
    case 'cancelled':
      return 'annullata';
    case 'error':
      return 'in errore';
  }
}

/** Pure formatter for the persisted mission block (unit-tested). */
export function formatMissionStatus(state: MissionState): string {
  const prompt = state.userPrompt;
  const truncated =
    prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt;
  return [
    `[zelari] missione ${state.missionId} · ${missionStatusLabel(state.status)}`,
    `  iterazione: ${state.iteration} · slice corrente: ${state.currentSliceId}`,
    `  aggiornata: ${state.updatedAt}`,
    `  prompt: ${truncated}`,
  ].join('\n');
}

/** `/resume-mission status` — render the persisted mission (or its absence). */
export async function handleResumeMissionStatus(
  ctx: MissionResumeHandlerCtx,
  projectRoot: string = process.cwd(),
): Promise<void> {
  const state = await loadMissionState(projectRoot);
  appendSystem(
    ctx.setMessages,
    state
      ? formatMissionStatus(state)
      : '[zelari] nessuna missione persistita (.zelari/mission-state.json assente).\n' +
        '  Aviane una con /zelari <prompt> oppure `zelari-code --mode zelari <prompt>`.',
  );
}
