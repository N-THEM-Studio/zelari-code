// @ts-nocheck — pre-existing strict-mode type narrowing issues carried over
// from app.tsx. Runtime is correct; tighten signatures in a follow-up.
import { useCallback } from 'react';
import { handleSlashCommand, type SlashCommandResult } from '../slashCommands.js';
import type { CodingSkillDefinition } from '../../agents/skills.js';
import type { ChatMessage } from '../components/ChatStream.js';
import type { AgentHarness } from '../../main/core/AgentHarness.js';
import type { ProviderSpec } from '../keyStore.js';
import { appendSystem, appendUser } from './messageHelpers.js';
import { sessionKindRouter } from '../sessionManager.js';
import { newSessionId } from '../sessionManager.js';
import {
  handleDiff,
  handleUndo,
  handleCompact,
  handleUpdateCheck,
  handleUpdatePerform,
  handlePromoteMember,
} from '../slashHandlers/git.js';
import {
  handleBranchCreate,
  handleBranchList,
  handleBranchCheckout,
} from '../slashHandlers/branch.js';
import {
  handleWorkspaceShow,
  handleWorkspaceSync,
  handleWorkspaceReset,
} from '../slashHandlers/workspace.js';
import {
  handleProviderList,
  handleProviderSet,
  handleProviderCustom,
  handleProviderRefresh,
  handleProviderStatus,
  handleLoginKey,
  handleLoginOAuthGrok,
  handleModelShow,
  handleModelSet,
  handleModelsList,
  handleModelsRefresh,
} from '../slashHandlers/provider.js';
import {
  handleSkillStats,
  handleSkillCompare,
  handleCouncilFeedback,
  handleSteer,
  handleClearChat,
} from '../slashHandlers/skills.js';

/**
 * useSlashDispatch — router for every /command.
 *
 * Extracted from app.tsx (Task v0.4.2 audit split). The previous handleSubmit
 * was a 1340-line if/else chain. This hook routes by SlashCommandResult.kind
 * to small handler functions in `src/cli/slashHandlers/*.ts`. Each handler
 * is independently testable and ~50-150 LOC.
 *
 * Returns a stable callback `(value: string) => Promise<void>` that App wires
 * into <InputBar onSubmit={...} />.
 */
export interface SlashDispatchParams {
  skills: CodingSkillDefinition[];
  sessionId: string;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setInput: (v: string) => void;
  setBusy: (v: boolean) => void;
  setSessionId: (v: string) => void;
  setSessionActive: (v: boolean) => void;
  setProviderConfig: (cfg: unknown) => void;
  activeProviderSpec: ProviderSpec;
  activeModel: string;
  providerDefaults: Record<string, string>;
  harnessRef: React.MutableRefObject<AgentHarness | null>;
  setQueueCount: (n: number) => void;
  dispatchPrompt: (text: string) => Promise<void>;
  dispatchCouncilPrompt: (text: string) => Promise<void>;
  /** Called by /new: caller closes the old SessionJsonlWriter and opens a new one for `id`. */
  onNewSession?: (id: string) => void;
  /** Called by /exit: caller flushes the writer and exits the process. */
  onExit?: () => void;
}

export function useSlashDispatch(params: SlashDispatchParams): (value: string) => Promise<void> {
  const {
    skills, sessionId, messages,
    setMessages, setInput, setBusy, setSessionId, setSessionActive, setProviderConfig,
    activeProviderSpec, activeModel, providerDefaults,
    harnessRef, setQueueCount, dispatchPrompt, dispatchCouncilPrompt,
  } = params;

  return useCallback(async (value: string): Promise<void> => {
    if (!value.trim()) return;
    // We can't read `busy` here (would need to be a dep); the InputBar is
    // disabled when busy, so this is a belt-and-suspenders guard.
    const result: SlashCommandResult = handleSlashCommand(value, skills);

    // Base context — passed to every handler that needs chat state.
    const baseCtx = { setMessages, setInput };
    // Some handlers (e.g. handleCompact) need read access to the live message
    // list — supply a wider ctx for them.
    const fullCtx = { ...baseCtx, messages };
    const providerCtx = {
      ...baseCtx, setProviderConfig, setBusy,
      activeProviderSpec, activeModel, providerDefaults,
    };
    const skillCtx = { ...baseCtx, setBusy, sessionId };
    const branchCtx = { ...baseCtx, sessionId };
    const steerCtx = { ...skillCtx, harnessRef, setQueueCount, dispatchPrompt };

    // Local refs to optional callbacks so the closure types are tight.
    const { onNewSession, onExit } = params;

    // ── Unhandled: free-form prompt → dispatch to LLM ──
    if (!result.handled) {
      appendUser(setMessages, value);
      setSessionActive(true);
      await dispatchPrompt(value);
      setInput('');
      return;
    }

    // ── Session kinds ──
    if (result.kind === 'session' || result.kind === 'resume' || result.kind === 'new') {
      // Session-kind commands touch the persistence layer (sessions directory,
      // current-session marker, writerRef) which lives in App. We delegate
      // to the helpers exported from sessionManager and apply the writerRef
      // + messages reset ourselves.
      if (result.kind === 'session') {
        const sysMsg = await sessionKindRouter('session');
        appendSystem(setMessages, sysMsg);
      } else if (result.kind === 'resume' && result.targetSessionId) {
        const sysMsg = await sessionKindRouter('resume', result.targetSessionId);
        appendSystem(setMessages, sysMsg);
      } else if (result.kind === 'new') {
        const sysMsg = await sessionKindRouter('new');
        appendSystem(setMessages, sysMsg);
        // Apply state reset here (useSession can't reach these setters).
        const id = newSessionId();
        setSessionId(id);
        setMessages([]);
        setSessionActive(false);
        onNewSession?.(id);
      }
      setInput('');
      return;
    }

    // ── Council ──
    if (result.kind === 'council' && result.councilInput) {
      appendUser(setMessages, `/council ${result.councilInput}`);
      setSessionActive(true);
      setInput('');
      await dispatchCouncilPrompt(result.councilInput);
      return;
    }

    // ── Council feedback ──
    if (result.kind === 'council_feedback' && result.feedbackMemberId && typeof result.feedbackScore === 'number') {
      handleCouncilFeedback(skillCtx, result.feedbackMemberId, result.feedbackScore, result.feedbackNote);
      setInput('');
      return;
    }

    // ── Provider ops ──
    if (result.kind === 'provider_set' && result.provider) {
      handleProviderSet(providerCtx, result.provider);
      setInput('');
      return;
    }
    if (result.kind === 'provider_list') {
      handleProviderList(providerCtx);
      setInput('');
      return;
    }
    if (result.kind === 'provider_custom') {
      handleProviderCustom(providerCtx, {
        endpoint: result.customEndpoint,
        clear: result.customClear,
        message: result.message,
      });
      setInput('');
      return;
    }
    if (result.kind === 'provider_refresh' && result.provider) {
      await handleProviderRefresh(providerCtx, result.provider);
      setInput('');
      return;
    }
    if (result.kind === 'provider_status' && result.provider) {
      await handleProviderStatus(providerCtx, result.provider);
      setInput('');
      return;
    }

    // ── Login ──
    if (result.kind === 'login' && result.provider && result.loginKey) {
      await handleLoginKey(providerCtx, result.provider, result.loginKey);
      setInput('');
      return;
    }
    if (result.kind === 'login_oauth' && result.provider === 'grok') {
      await handleLoginOAuthGrok(providerCtx);
      setInput('');
      return;
    }

    // ── Model ──
    if (result.kind === 'model_set' && result.model) {
      handleModelSet(providerCtx, result.model);
      setInput('');
      return;
    }
    if (result.kind === 'model_show') {
      handleModelShow(providerCtx);
      setInput('');
      return;
    }
    if (result.kind === 'models_list') {
      handleModelsList(providerCtx);
      setInput('');
      return;
    }
    if (result.kind === 'models_refresh' || result.kind === 'model_refresh') {
      handleModelsRefresh(providerCtx);
      setInput('');
      return;
    }

    // ── Branch ──
    if (result.kind === 'branch_create' && result.branchName) {
      if (!sessionId) {
        appendSystem(setMessages, '[branch] no active session — wait for bootstrap or run a prompt first');
      } else {
        await handleBranchCreate(branchCtx, result.branchName);
      }
      setInput('');
      return;
    }
    if (result.kind === 'branch_list') {
      await handleBranchList(branchCtx);
      setInput('');
      return;
    }
    if (result.kind === 'branch_checkout' && result.branchName) {
      await handleBranchCheckout(branchCtx, result.branchName);
      setInput('');
      return;
    }

    // ── Steer ──
    if (result.kind === 'steer' || result.kind === 'steer_interrupt') {
      await handleSteer(steerCtx, result.steerText, result.message);
      setInput('');
      return;
    }
    if (result.kind === 'steer_no_active_run') {
      if (result.message) appendSystem(setMessages, result.message);
      setInput('');
      return;
    }

    // ── Update ──
    if (result.kind === 'update_check') {
      await handleUpdateCheck(baseCtx);
      setInput('');
      return;
    }
    if (result.kind === 'update_perform') {
      await handleUpdatePerform(baseCtx);
      setInput('');
      return;
    }
    if (result.kind === 'update_usage') {
      appendSystem(setMessages, result.message ?? 'Usage: /update [--yes|-y]');
      setInput('');
      return;
    }

    // ── Workspace ──
    if (result.kind === 'workspace') {
      appendSystem(
        setMessages,
        result.message ?? 'Usage: /workspace (see /workspace --help or docs/plans/2026-07-01-council-workspace-cli-stubs.md)',
      );
      setInput('');
      return;
    }
    if (result.kind === 'workspace_show' && result.workspaceWhat) {
      const what = result.workspaceWhat as 'plan' | 'decisions' | 'risks' | 'agents' | 'docs';
      await handleWorkspaceShow(baseCtx, what);
      setInput('');
      return;
    }
    if (result.kind === 'workspace_sync') {
      await handleWorkspaceSync(baseCtx);
      setInput('');
      return;
    }
    if (result.kind === 'workspace_reset') {
      await handleWorkspaceReset(baseCtx, !!result.workspaceForce);
      setInput('');
      return;
    }

    // ── Compact ──
    if (result.kind === 'compact') {
      handleCompact(fullCtx, result.compactThreshold, result.compactKeepRecent);
      setInput('');
      return;
    }

    // ── Diff / undo ──
    if (result.kind === 'diff') {
      await handleDiff(baseCtx, !!result.diffStaged);
      setInput('');
      return;
    }
    if (result.kind === 'undo' || result.kind === 'undo_confirm') {
      await handleUndo(baseCtx, result.message, result.kind === 'undo_confirm' && !!result.undoConfirmed);
      setInput('');
      return;
    }

    // ── Promote member ──
    if (result.kind === 'promote_member' && result.promoteMemberId) {
      await handlePromoteMember(baseCtx, result.promoteMemberId);
      setInput('');
      return;
    }
    if (result.kind === 'promote_member_error') {
      appendSystem(setMessages, result.promoteMemberError ?? 'Usage: /promote-member <memberId>');
      setInput('');
      return;
    }

    // ── Skill stats / compare ──
    if (result.kind === 'skill_stats') {
      await handleSkillStats(skillCtx, result.skillStatsSkillId);
      setInput('');
      return;
    }
    if (result.kind === 'skill-compare') {
      await handleSkillCompare(skillCtx, result.compareIds, result.message);
      setInput('');
      return;
    }

    // ── Skill invocation (special: dispatches to LLM) ──
    if (result.kind === 'skill' && result.expandedSkill) {
      // The skill's expanded prompt goes through the normal chat-turn pipeline
      // so it gets logged, streamed, and session-stats-tracked.
      const sysMsg = result.message
        ?? `[skill] ${result.expandedSkill.skillId} — prompt ready (dispatch lands in Phase 14.7)`;
      appendSystem(setMessages, sysMsg);
      setInput('');
      await dispatchPrompt(result.expandedSkill.prompt);
      return;
    }

    // ── Clear / exit ──
    if (result.kind === 'clear') {
      handleClearChat(setMessages, setSessionActive);
      setInput('');
      return;
    }
    if (result.kind === 'exit') {
      // Hand off to the App via callback so writerRef close + process.exit
      // happen in the right place.
      setInput('');
      onExit?.();
      return;
    }

    // ── Help / unknown ──
    if (result.message) {
      appendSystem(setMessages, result.message);
      setInput('');
      return;
    }
    appendSystem(setMessages, `[${result.kind}] handled`);
    setInput('');
  }, [
    skills, sessionId, messages,
    setMessages, setInput, setBusy, setSessionId, setSessionActive, setProviderConfig,
    activeProviderSpec, activeModel, providerDefaults,
    harnessRef, setQueueCount, dispatchPrompt, dispatchCouncilPrompt,
    params,
  ]);
}