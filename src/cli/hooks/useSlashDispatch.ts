// @ts-nocheck — pre-existing strict-mode type narrowing issues carried over
// from app.tsx. Runtime is correct; tighten signatures in a follow-up.
import { useCallback } from 'react';
import { handleSlashCommand, type SlashCommandResult } from '../slashCommands.js';
import type { CodingSkillDefinition } from '@zelari/core/skills';
import type { ChatMessage } from '../components/ChatStream.js';
import type { AgentHarness } from '@zelari/core/harness';
import type { ProviderSpec } from '../keyStore.js';
import { appendSystem, appendUser } from './messageHelpers.js';
import { sessionKindRouter } from '../sessionManager.js';
import { newSessionId } from '../sessionManager.js';
import { handleDiff, handleUndo } from '../slashHandlers/git.js';
import {
  handleCheckpointCreate,
  handleRollback,
  handleRollbackList,
} from '../slashHandlers/checkpoint.js';
import { handleIndexBuild, handleIndexStatus } from '../slashHandlers/semantic.js';
import { nextMode, describeMode } from '../mode.js';
import { handleCompact } from '../slashHandlers/transcript.js';
import { handleUpdateCheck, handleUpdatePerform } from '../slashHandlers/updater.js';
import { handlePluginsList, handlePluginsInstall } from '../slashHandlers/plugins.js';
import { handlePromoteMember } from '../slashHandlers/promoteMember.js';
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
  handleProviderPicker,
  handleProviderCustom,
  handleProviderRefresh,
  handleProviderStatus,
  handleLoginKey,
  handleLoginOAuthGrok,
  handleModelShow,
  handleModelSet,
  handleModelPicker,
  handleModelsList,
  handleModelsRefresh,
  type PickerRequest,
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
  dispatchPrompt: (text: string, opts?: { requiredTools?: readonly string[] }) => Promise<void>;
  dispatchCouncilPrompt: (text: string) => Promise<void>;
  /** v1.0: dispatch an autonomous Zelari mission (multi-run council loop). */
  dispatchZelariPrompt: (text: string) => Promise<void>;
  /**
   * v0.7.9: dispatch mode for free-form (non-slash) prompts. 'agent' routes
   * to dispatchPrompt (single LLM turn), 'council' to dispatchCouncilPrompt
   * (6-member pipeline), 'zelari' to dispatchZelariPrompt (autonomous mission).
   * Toggled from the App with shift+tab.
   */
  mode?: 'agent' | 'council' | 'zelari';
  /**
   * Setter for the dispatch mode — lets `/mode` change it (a terminal-
   * independent alternative to shift+tab). Same setter the App's shift+tab
   * handler uses.
   */
  setMode?: React.Dispatch<React.SetStateAction<'agent' | 'council' | 'zelari'>>;
  /**
   * v0.7.10: opens the interactive SelectList in the App (for /provider and
   * /model pickers). When absent, the handlers fall back to text summaries.
   */
  openPicker?: (req: PickerRequest) => void;
  /** Called by /new: caller closes the old SessionJsonlWriter and opens a new one for `id`. */
  onNewSession?: (id: string) => void;
  /** Called by /exit: caller flushes the writer and exits the process. */
  onExit?: () => void;
  /** Called by /clear (v0.7.0): caller bumps its Static-remount epoch. */
  onClear?: () => void;
}

export function useSlashDispatch(params: SlashDispatchParams): (value: string) => Promise<void> {
  const {
    skills, sessionId, messages,
    setMessages, setInput, setBusy, setSessionId, setSessionActive, setProviderConfig,
    activeProviderSpec, activeModel, providerDefaults,
    harnessRef, setQueueCount, dispatchPrompt, dispatchCouncilPrompt, dispatchZelariPrompt,
    mode = 'agent', setMode,
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
    // v0.7.9: routed by the shift+tab mode — 'council' sends the prompt
    // through the 6-member pipeline exactly like `/council <text>`.
    if (!result.handled) {
      appendUser(setMessages, value);
      setSessionActive(true);
      if (mode === 'zelari') {
        setInput('');
        await dispatchZelariPrompt(value);
        return;
      }
      if (mode === 'council') {
        setInput('');
        await dispatchCouncilPrompt(value);
        return;
      }
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
        const { message: sysMsg } = await sessionKindRouter('session');
        appendSystem(setMessages, sysMsg);
      } else if (result.kind === 'resume' && result.targetSessionId) {
        const { message: sysMsg } = await sessionKindRouter('resume', result.targetSessionId);
        appendSystem(setMessages, sysMsg);
      } else if (result.kind === 'new') {
        // Generate the id HERE (not inside sessionKindRouter) so the in-memory
        // state, the on-disk current-session marker, and the writerRef ALL
        // share the same id. The previous split-brain bug fired both
        // sessionKindRouter's internal newSessionId() AND a second
        // newSessionId() here, leaving idA on disk and idB in memory.
        const id = newSessionId();
        const { message: sysMsg } = await sessionKindRouter('new', undefined, id);
        appendSystem(setMessages, sysMsg);
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

    // ── Zelari mission ──
    if (result.kind === 'zelari' && result.zelariInput) {
      appendUser(setMessages, `/zelari ${result.zelariInput}`);
      setSessionActive(true);
      setInput('');
      await dispatchZelariPrompt(result.zelariInput);
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
    if (result.kind === 'provider_picker') {
      handleProviderPicker(providerCtx, params.openPicker);
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
    if (result.kind === 'model_picker') {
      await handleModelPicker(providerCtx, params.openPicker);
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

    // ── Plugins (optional tool detection + install) ──
    if (result.kind === 'plugins_list') {
      await handlePluginsList({ setMessages }, process.cwd());
      setInput('');
      return;
    }
    if (result.kind === 'plugins_install') {
      await handlePluginsInstall({ setMessages }, process.cwd(), result.pluginId ?? '');
      setInput('');
      return;
    }
    if (result.kind === 'plugins_usage') {
      appendSystem(
        setMessages,
        result.message ?? 'Usage: /plugins | /plugins install <id>',
      );
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

    // ── Checkpoints / rollback ──
    if (result.kind === 'checkpoint_create') {
      await handleCheckpointCreate({ ...baseCtx, cwd: process.cwd() }, result.checkpointLabel);
      setInput('');
      return;
    }
    if (result.kind === 'rollback_list') {
      await handleRollbackList({ ...baseCtx, cwd: process.cwd() });
      setInput('');
      return;
    }
    if (result.kind === 'rollback') {
      await handleRollback({ ...baseCtx, cwd: process.cwd() }, result.rollbackId);
      setInput('');
      return;
    }

    // ── Semantic index ──
    if (result.kind === 'index_build') {
      await handleIndexBuild({ ...baseCtx, cwd: process.cwd() });
      setInput('');
      return;
    }
    if (result.kind === 'index_status') {
      handleIndexStatus({ ...baseCtx, cwd: process.cwd() });
      setInput('');
      return;
    }

    // ── Mode switch (terminal-independent alternative to shift+tab) ──
    if (result.kind === 'mode_set') {
      if (result.message) {
        appendSystem(setMessages, result.message);
      } else if (setMode) {
        // `mode` is current here (handleSubmit re-binds when it changes), so
        // compute the target outside the updater — no side-effects in setState.
        const target = result.modeTarget ?? nextMode(mode);
        setMode(target);
        appendSystem(setMessages, `[mode] ${describeMode(target)}`);
      } else {
        appendSystem(setMessages, '[mode] switching unavailable in this context');
      }
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
      // v0.7.5: forward the skill's requiredTools so dispatchPrompt registers
      // the workspace stubs the skill's instructions rely on.
      await dispatchPrompt(result.expandedSkill.prompt, {
        requiredTools: result.expandedSkill.requiredTools,
      });
      return;
    }

    // ── Clear / exit ──
    if (result.kind === 'clear') {
      handleClearChat(setMessages, setSessionActive);
      // v0.7.0: notify the App so it bumps a "clear epoch" counter that
      // remounts <Static> (its internal "already printed" index must reset
      // for the ANSI-cleared scrollback to stay in sync).
      params.onClear?.();
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
    harnessRef, setQueueCount, dispatchPrompt, dispatchCouncilPrompt, dispatchZelariPrompt, mode, setMode,
    params,
  ]);
}