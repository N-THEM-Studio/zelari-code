import type { CodingSkillDefinition } from '@zelari/core/skills';

export type SlashCommand =
  | 'login' | 'model' | 'model_refresh' | 'models' | 'discover' | 'skill' | 'skill_stats' | 'skill-compare' | 'compact' | 'clear' | 'help' | 'exit' | 'sessions' | 'resume' | 'new' | 'council' | 'council-feedback' | 'zelari' | 'mode' | 'plan' | 'build' | 'view-plan' | 'provider' | 'branch' | 'branches' | 'checkout' | 'steer' | 'steer_interrupt' | 'diff' | 'undo' | 'checkpoint' | 'rollback' | 'index' | 'promote-member' | 'update' | 'plugins' | 'workspace' | 'workspace_show' | 'workspace_sync' | 'workspace_reset';

export interface SlashCommandResult {
  /** Whether the command was recognized. */
  handled: boolean;
  /** Discriminated kind for what the caller should do. */
  kind: 'unknown' | 'login' | 'login_oauth' | 'model' | 'model_show' | 'model_set' | 'model_refresh' | 'model_picker' | 'models_list' | 'models_refresh' | 'skill' | 'skill_stats' | 'skill-compare' | 'compact' | 'clear' | 'help' | 'exit' | 'session' | 'resume' | 'new' | 'council' | 'council_feedback' | 'zelari' | 'provider' | 'provider_set' | 'provider_list' | 'provider_picker' | 'provider_custom' | 'provider_refresh' | 'provider_status' | 'branch_create' | 'branch_list' | 'branch_checkout' | 'steer' | 'steer_interrupt' | 'steer_no_active_run' | 'diff' | 'undo' | 'undo_confirm' | 'checkpoint_create' | 'rollback' | 'rollback_list' | 'index_build' | 'index_status' | 'mode_set' | 'phase_set' | 'view_plan' | 'promote_member' | 'promote_member_error' | 'update_check' | 'update_perform' | 'update_usage' | 'plugins_list' | 'plugins_install' | 'plugins_usage' | 'workspace' | 'workspace_show' | 'workspace_sync' | 'workspace_reset';
  /** Optional human-readable message (e.g. for `clear` or `help`). */
  message?: string;
  /** For `model`: the new model name. */
  model?: string;
  /** For `login` / `login_oauth`: the provider name (e.g. 'grok'). */
  provider?: string;
  /** For `login`: the API key to store for the provider (Task 14.9). */
  loginKey?: string;
  /** For `skill`: the expanded skill ready to dispatch to AgentHarness. */
  expandedSkill?: ExpandedSkill;
  /** For `skill_stats`: optional skill id filter (Task C.2.3). */
  skillStatsSkillId?: string;
  /** For `skill_compare`: the two skill IDs to compare (Task H.3.1). */
  compareIds?: [string, string];
  /** For `skill` errors: error message. */
  skillError?: string;
  /** For `resume`: the target session ID to load. */
  targetSessionId?: string;
  /** For `council`: the user prompt to dispatch to the council. */
  councilInput?: string;
  /** For `zelari`: the mission prompt to drive the autonomous loop. */
  zelariInput?: string;
  /** For `council_feedback`: the target member id (e.g. 'charont'). */
  feedbackMemberId?: string;
  /** For `council_feedback`: the score 1-5. */
  feedbackScore?: number;
  /** For `council_feedback`: optional note from the user. */
  feedbackNote?: string;
  /** For `branch_create` / `branch_checkout`: the branch name. */
  branchName?: string;
  /** For `provider_custom`: the target provider id whose endpoint is being set. */
  customProvider?: string;
  /** For `provider_custom`: the new base URL (undefined when clearing). */
  customEndpoint?: string;
  /** For `provider_custom`: true if the user wants to clear the custom endpoint. */
  customClear?: boolean;
  /** For `steer`: the user prompt to enqueue on the active harness. */
  steerText?: string;
  /** For `diff`: include staged changes too (`git diff --cached`). */
  diffStaged?: boolean;
  /** For `undo`: user passed --yes / -y to skip the confirmation warning. */
  undoConfirmed?: boolean;
  /** For `rollback`: target checkpoint id (undefined / 'latest' → newest). */
  rollbackId?: string;
  /** For `plugins_install`: the plugin id to install (e.g. 'eslint'). */
  pluginId?: string;
  /** For `mode_set`: target mode; undefined → cycle to the next mode. */
  modeTarget?: 'agent' | 'council' | 'zelari';
  /** For `phase_set`: target work phase (plan | build). */
  phaseTarget?: 'plan' | 'build';
  /** For `phase_set`/`plan`/`build`: optional goal to dispatch after switching. */
  phaseGoal?: string;
  /** For `checkpoint_create`: optional label for the new checkpoint. */
  checkpointLabel?: string;
  /** For `compact`: number of recent messages to keep (Task B.3.2). */
  compactKeepRecent?: number;
  /** For `compact`: messages-count threshold to trigger compaction. */
  compactThreshold?: number;
  /** For `promote_member`: the target member id (e.g. 'geryon'). */
  promoteMemberId?: string;
  /** For `promote_member_error`: error message (e.g. unknown member). */
  promoteMemberError?: string;
  /** For `update`: true if `--yes` / `-y` was passed (perform the update). */
  updateForce?: boolean;
  /** For `workspace_show`: which artifact to render (`plan`|`decisions`|`risks`|`agents`|`docs`). */
  workspaceWhat?: string;
  /** For `workspace_reset`: true if `--yes` was passed (skip confirmation). */
  workspaceForce?: boolean;
}

export interface ExpandedSkill {
  /** Skill ID that was expanded. */
  skillId: string;
  /** The prompt string to send to the council via AgentHarness. */
  prompt: string;
  /** Roles required to run this skill (for routing). */
  requiredRoles: string[];
  /** Tools required (for enabling). */
  requiredTools: string[];
  /** Cost estimate (for budget display). */
  estimatedCost: 'low' | 'medium' | 'high';
}

/**
 * Parse a user input string starting with '/' into a SlashCommand + args.
 * Returns { command, args } or null if not a slash command.
 */
function parseSlashCommand(text: string): { command: SlashCommand; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0] as SlashCommand;
  const args = parts.slice(1);
  return { command, args };
}

/**
 * Expand a skill's systemPromptFragment + the user's input into a complete
 * prompt ready to send to AgentHarness. If the skill is invoked WITHOUT
 * an input arg (e.g. just `/skill architect-feature`), generate a placeholder
 * prompt asking the user for the input.
 */
export function expandSkillTemplate(
  skill: CodingSkillDefinition,
  options: { input?: string } = {},
): ExpandedSkill {
  const userInput = options.input?.trim() ?? '';
  const prompt = userInput
    ? `${skill.systemPromptFragment}\n\n## User input\n${userInput}`
    : `${skill.systemPromptFragment}\n\n## User input\n(Please provide the task description or input for this skill.)`;
  return {
    skillId: skill.id,
    prompt,
    requiredRoles: skill.requiredRoles,
    requiredTools: skill.requiredTools,
    estimatedCost: skill.estimatedCost,
  };
}

/**
 * Format the list of available skills for `/skill` autocomplete or `/help`.
 * Group by category.
 */
export function formatSkillList(skills: readonly CodingSkillDefinition[]): string {
  if (skills.length === 0) return '(no skills available)';
  const byCategory = new Map<string, CodingSkillDefinition[]>();
  for (const skill of skills) {
    const list = byCategory.get(skill.category) ?? [];
    list.push(skill);
    byCategory.set(skill.category, list);
  }
  const lines: string[] = ['Available skills:'];
  for (const [category, list] of [...byCategory.entries()].sort()) {
    lines.push(`\n[${category}]`);
    for (const skill of list) {
      const costLabel = skill.estimatedCost;
      lines.push(`  /skill ${skill.id} — ${skill.name} (${costLabel} cost)`);
    }
  }
  return lines.join('\n');
}

/**
 * Handle a slash command from the CLI user. Returns a SlashCommandResult
 * describing what the caller should do. Pure function — no side effects,
 * no I/O. The caller (Phase 14's Ink UI) is responsible for actually
 * performing the action (e.g. sending the expandedSkill.prompt to
 * AgentHarness, clearing the transcript, etc.).
 */
export function handleSlashCommand(
  text: string,
  availableSkills: readonly CodingSkillDefinition[],
): SlashCommandResult {
  const parsed = parseSlashCommand(text);
  if (!parsed) {
    return { handled: false, kind: 'unknown' };
  }
  const { command, args } = parsed;

  switch (command) {
    case 'help':
      return {
        handled: true,
        kind: 'help',
        message: `Available commands:\n  /login <provider> — authenticate with provider (grok, minimax, glm, custom)\n  /model — pick the active model from a list (auto-discovers, v0.7.10)\n  /model <name> — switch the active model directly\n  /model show — print the current model\n  /models — list discovered models for the active provider (v3-U)\n  /models refresh (or /discover) — re-discover models for the active provider\n  /provider — pick the active provider from a list (v0.7.10)\n  /provider <name> — switch the active provider directly\n  /provider custom <baseUrl> — point the active provider at a self-hosted endpoint (Ollama, LM Studio, vLLM, ...)\n  /provider custom clear — clear the custom endpoint override\n  /skill <name> [input] — invoke a skill (autocomplete with /skill <TAB>)\n  /skill-stats [name] — show invocation stats (success rate, avg duration, total tokens)\n  /council <input> — invoke the multi-agent council on input\n  /zelari <input> — run an autonomous mission (multi-run council until the MVP slice is complete)\n  /council-feedback <memberId> <1-5> [note] — rate a council member for future ranking (Task I.2)
  /promote-member <memberId> — promote a council member to a standalone skill (v3-K)
  /update [--yes|-y] — check for zelari-code updates; --yes performs the update (v3-N)\n  /plugins — list optional tool plugins (Playwright, eslint, ruff, LSP servers)\n  /plugins install <id> — install a plugin now (e.g. /plugins install eslint)\n  /steer <text> — enqueue a follow-up prompt on the active run (Task 18.2)\n  /steer --interrupt <text> — cancel current run + enqueue <text> for next dispatch (Task C.3.2)\n  /compact — compact the session transcript\n  /clear — clear the visible transcript (session is preserved)\n  /sessions — list past sessions\n  /resume <id> — load a past session\n  /branch <name> — snapshot the current session into a new branch\n  /branches — list branches\n  /checkout <name> — switch the active branch\n  /new — start a fresh session\n  /diff [--staged] — show uncommitted changes (or staged with --staged)\n  /undo [--yes] — revert working-tree changes (destructive! requires --yes)\n  /checkpoint [label] — snapshot the working tree as a restore point\n  /rollback [id|latest] — restore the working tree to a checkpoint (no arg: list)\n  /index [status] — build the semantic code index for semantic_search\n  /mode [agent|council|zelari] — switch dispatch mode (same as shift+tab; no arg cycles)\n  /help — show this help\n  /exit — exit the CLI\n\n${formatSkillList(availableSkills)}`,
      };

    case 'exit':
      return { handled: true, kind: 'exit', message: 'Goodbye.' };

    case 'clear':
      return { handled: true, kind: 'clear', message: 'Transcript cleared.' };

    case 'login': {
      const provider = args[0];
      if (!provider) {
        return { handled: true, kind: 'login', message: 'Usage: /login <provider> [key] (or /login <provider> for OAuth if supported)' };
      }
      const key = args.slice(1).join(' ').trim();
      if (!key) {
        // No key supplied: if provider supports OAuth, signal OAuth flow;
        // otherwise, show env-var hint as before.
        if (provider === 'grok') {
          return { handled: true, kind: 'login_oauth', provider };
        }
        return {
          handled: true,
          kind: 'login',
          provider,
          message: `[login] no key supplied — set ${provider.toUpperCase()}_API_KEY env or pass the key: /login ${provider} <key>`,
        };
      }
      return { handled: true, kind: 'login', provider, loginKey: key };
    }

    case 'model': {
      const model = args[0];
      if (!model) {
        // v0.7.10: no-arg /model opens the interactive picker (discovered
        // models, arrow-key selectable). /model show keeps the old text path.
        return {
          handled: true,
          kind: 'model_picker',
          message: 'Usage: /model — pick from a list, /model <name> to set directly, /model show for the current one',
        };
      }
      if (model === 'show') {
        return { handled: true, kind: 'model_show' };
      }
      if (model === 'refresh') {
        return { handled: true, kind: 'model_refresh' };
      }
      return { handled: true, kind: 'model_set', model };
    }

    case 'models': {
      const sub = args[0];
      if (sub === 'refresh') {
        return { handled: true, kind: 'models_refresh' };
      }
      return { handled: true, kind: 'models_list' };
    }

    // v0.7.10: /discover — explicit alias for /models refresh.
    case 'discover':
      return { handled: true, kind: 'models_refresh' };

    case 'provider': {
      const subcommand = args[0];
      if (!subcommand) {
        // v0.7.10: no-arg /provider opens the interactive picker.
        // /provider list keeps the old text summary.
        return {
          handled: true,
          kind: 'provider_picker',
          message: 'Usage: /provider — pick from a list\n         /provider <name> — switch active provider\n         /provider list — print the current provider + available ids\n         /provider custom <baseUrl> — set custom base URL (Ollama, LM Studio, vLLM, ...)\n         /provider custom clear — clear the custom override\n         /provider <name> refresh — force token refresh (v3-F)\n         /provider <name> status — show key source, expiry, refresh impl (v3-F)\nAvailable: openai-compatible, minimax, glm, grok, deepseek, custom',
        };
      }
      if (subcommand === 'list') {
        return {
          handled: true,
          kind: 'provider_list',
          message: 'Usage: /provider <name> — switch active provider\nAvailable: openai-compatible, minimax, glm, grok, deepseek, custom',
        };
      }
      if (subcommand === 'custom') {
        const target = args[1];
        if (!target || target === 'show') {
          return {
            handled: true,
            kind: 'provider_custom',
            message: 'Usage: /provider custom <baseUrl> — set custom base URL for the active provider\n         /provider custom clear — clear the custom override for the active provider',
          };
        }
        if (target === 'clear') {
          return {
            handled: true,
            kind: 'provider_custom',
            customClear: true,
          };
        }
        // Treat the rest of the line as the URL (supports paths with spaces
        // in user-typed input, though unusual).
        const url = args.slice(1).join(' ').trim();
        // Identify the provider id from the active provider at handler time.
        // The caller (app.tsx) resolves this from providerConfig.activeProviderId.
        return {
          handled: true,
          kind: 'provider_custom',
          customEndpoint: url,
        };
      }
      // v3-F: /provider <id> refresh | status subcommands.
      // subcommand is the provider id here; args[1] is the sub-subcommand.
      const providerId = subcommand;
      const sub = args[1];
      if (sub === 'refresh') {
        return { handled: true, kind: 'provider_refresh', provider: providerId };
      }
      if (sub === 'status') {
        return { handled: true, kind: 'provider_status', provider: providerId };
      }
      return { handled: true, kind: 'provider_set', provider: subcommand };
    }

    case 'branch': {
      const name = args[0];
      if (!name) {
        return {
          handled: true,
          kind: 'branch_create',
          message: 'Usage: /branch <name> — snapshots the current session into a new branch',
        };
      }
      return { handled: true, kind: 'branch_create', branchName: name };
    }

    case 'branches':
      return { handled: true, kind: 'branch_list' };

    case 'checkout': {
      const name = args[0];
      if (!name) {
        return {
          handled: true,
          kind: 'branch_checkout',
          message: 'Usage: /checkout <name> — switch the active branch',
        };
      }
      return { handled: true, kind: 'branch_checkout', branchName: name };
    }

    case 'compact': {
      // Optional flags: --threshold N, --keep N
      let compactThreshold: number | undefined;
      let compactKeepRecent: number | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--threshold' || a === '-t') {
          const v = Number.parseInt(args[++i] ?? '', 10);
          if (Number.isFinite(v) && v > 0) compactThreshold = v;
        } else if (a === '--keep' || a === '-k') {
          const v = Number.parseInt(args[++i] ?? '', 10);
          if (Number.isFinite(v) && v > 0) compactKeepRecent = v;
        }
      }
      return {
        handled: true,
        kind: 'compact',
        message: 'Compacting session...',
        compactThreshold,
        compactKeepRecent,
      };
    }

    case 'sessions':
      return { handled: true, kind: 'session' };

    case 'resume': {
      const targetId = args[0];
      if (!targetId) {
        return { handled: true, kind: 'resume', message: 'Usage: /resume <id>' };
      }
      return {
        handled: true,
        kind: 'resume',
        targetSessionId: targetId,
        message: `[resume] session ${targetId} ready — restart zelari-code to load`,
      };
    }

    case 'new':
      return {
        handled: true,
        kind: 'new',
        message: '[new] session reset — next prompt starts fresh',
      };

    case 'council': {
      const input = args.join(' ').trim();
      if (!input) {
        return {
          handled: true,
          kind: 'council',
          message: 'Usage: /council <input> — invokes the multi-agent council on the input',
        };
      }
      return { handled: true, kind: 'council', councilInput: input };
    }

    case 'zelari': {
      const input = args.join(' ').trim();
      if (!input) {
        return {
          handled: true,
          kind: 'zelari',
          message:
            'Usage: /zelari <prompt> — runs an autonomous Zelari mission (multi-run council until the MVP slice is complete)',
        };
      }
      return { handled: true, kind: 'zelari', zelariInput: input };
    }

    case 'council-feedback': {
      // Usage: /council-feedback <memberId> <1-5> [note...]
      const memberId = args[0];
      const scoreStr = args[1];
      if (!memberId || !scoreStr) {
        return {
          handled: true,
          kind: 'council_feedback',
          message:
            'Usage: /council-feedback <memberId> <1-5> [note...] — rate a council member (e.g. /council-feedback sisyphus 4 great framing)',
        };
      }
      const score = Number.parseInt(scoreStr, 10);
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        return {
          handled: true,
          kind: 'council_feedback',
          message: `Invalid score "${scoreStr}" — must be an integer in [1, 5].`,
        };
      }
      const note = args.slice(2).join(' ').trim() || undefined;
      return {
        handled: true,
        kind: 'council_feedback',
        feedbackMemberId: memberId,
        feedbackScore: score,
        ...(note ? { feedbackNote: note } : {}),
      };
    }

    case 'skill': {
      const skillId = args[0];
      if (!skillId) {
        return {
          handled: true,
          kind: 'skill',
          skillError: 'Usage: /skill <name> [input]',
          message: formatSkillList(availableSkills),
        };
      }
      const skill = availableSkills.find((s) => s.id === skillId);
      if (!skill) {
        return {
          handled: true,
          kind: 'skill',
          skillError: `Unknown skill: "${skillId}". Use /skill <TAB> for autocomplete.`,
          message: formatSkillList(availableSkills),
        };
      }
      const input = args.slice(1).join(' ');
      const expandedSkill = expandSkillTemplate(skill, { input });
      return { handled: true, kind: 'skill', expandedSkill };
    }

    case 'skill_stats': {
      // `/skill-stats [name]` — show aggregated stats from skill-history.jsonl.
      // name is optional; when omitted, returns stats across all skills.
      const skillId = args[0];
      return {
        handled: true,
        kind: 'skill_stats',
        skillStatsSkillId: skillId,
        message: skillId ? `Computing stats for skill "${skillId}"…` : 'Computing stats for all skills…',
      };
    }

    case 'skill-compare': {
      // `/skill-compare <id1> <id2>` — side-by-side stats for two skills.
      // Args: exactly 2 IDs (whitespace-separated).
      const id1 = args[0];
      const id2 = args[1];
      if (!id1 || !id2) {
        return {
          handled: true,
          kind: 'skill-compare',
          message: '⚠ /skill-compare requires exactly 2 skill IDs (e.g. `/skill-compare debug refactor`).',
        };
      }
      return {
        handled: true,
        kind: 'skill-compare',
        compareIds: [id1, id2],
        message: `Comparing skills "${id1}" vs "${id2}"…`,
      };
    }

    case 'steer': {
      // /steer <text>           → enqueue follow-up prompt (queue-only)
      // /steer --interrupt <text>  → enqueue + cancel current run (Task C.3.2)
      // /steer -i <text>        → short form of --interrupt
      let interrupt = false;
      const filtered: string[] = [];
      for (const a of args) {
        if (a === '--interrupt' || a === '-i') {
          interrupt = true;
        } else {
          filtered.push(a);
        }
      }
      const text = filtered.join(' ').trim();
      if (!text) {
        return {
          handled: true,
          kind: interrupt ? 'steer_interrupt' : 'steer',
          message: 'Usage: /steer [--interrupt|-i] <text> — enqueue (and optionally cancel) a follow-up prompt',
        };
      }
      return {
        handled: true,
        kind: interrupt ? 'steer_interrupt' : 'steer',
        steerText: text,
      };
    }

    case 'diff': {
      const staged = args.includes('--staged') || args.includes('--cached');
      return { handled: true, kind: 'diff', diffStaged: staged ? true : undefined };
    }

    case 'promote-member': {
      // Usage: /promote-member <memberId>
      // Validates the id against the AGENT_ROLES registry; if invalid,
      // surfaces a usage-style error (the parser is pure, so we don't
      // throw — the dispatcher can render the error message).
      const memberId = args[0];
      if (!memberId) {
        return {
          handled: true,
          kind: 'promote_member_error',
          promoteMemberError:
            'Usage: /promote-member <memberId> — e.g. /promote-member geryon',
        };
      }
      // Quick sanity check — the dispatcher will do the full UnknownMemberError
      // handling via promoteMember(). Here we just echo the id.
      return { handled: true, kind: 'promote_member', promoteMemberId: memberId };
    }

    case 'update': {
      // Usage:
      //   /update                  → check for updates (silent current vs latest)
      //   /update --yes | /update -y → perform the update
      // Any other args → usage hint
      let force = false;
      for (const a of args) {
        if (a === '--yes' || a === '-y') {
          force = true;
        }
      }
      if (args.length > 0 && !force) {
        return {
          handled: true,
          kind: 'update_usage',
          message:
            'Usage: /update — check for the latest zelari-code version\n' +
            '       /update --yes (or -y) — install the latest version (will ask you to restart manually)',
        };
      }
      return {
        handled: true,
        kind: force ? 'update_perform' : 'update_check',
        updateForce: force,
      };
    }

    case 'plugins': {
      // Usage:
      //   /plugins                → list all optional plugins (status + install hints)
      //   /plugins install <id>   → install a specific plugin now
      if (args.length === 0) {
        return { handled: true, kind: 'plugins_list' };
      }
      if (args[0] === 'install' && args[1]) {
        return { handled: true, kind: 'plugins_install', pluginId: args[1] };
      }
      return {
        handled: true,
        kind: 'plugins_usage',
        message:
          'Usage: /plugins — list optional tool plugins (Playwright, eslint, ruff, LSP servers)\n' +
          '       /plugins install <id> — install a plugin now (e.g. /plugins install eslint)',
      };
    }

    case 'undo': {
      const confirmed = args.includes('--yes') || args.includes('-y');
      if (confirmed) {
        return { handled: true, kind: 'undo_confirm', undoConfirmed: true };
      }
      // Without --yes, surface a destructive warning. The caller (app.tsx)
      // can still emit the actual git operation but should prefix with a
      // "are you sure?" banner. We keep two distinct kinds so the UI can
      // ask before acting.
      return {
        handled: true,
        kind: 'undo',
        message:
          '⚠ /undo is DESTRUCTIVE — it reverts all unstaged modifications ' +
          'and unstages everything.\nUse `/undo --yes` (or `/undo -y`) to confirm.',
      };
    }

    case 'mode': {
      // `/mode`                → cycle agent → council → zelari
      // `/mode <agent|council|zelari>` → set directly
      // Terminal-independent fallback for shift+tab (some terminals don't
      // emit a shift+Tab sequence).
      const target = args[0]?.trim().toLowerCase();
      if (target && ['agent', 'council', 'zelari'].includes(target)) {
        return { handled: true, kind: 'mode_set', modeTarget: target as 'agent' | 'council' | 'zelari' };
      }
      if (target) {
        return { handled: true, kind: 'mode_set', message: `[mode] unknown: ${target}. Use agent, council, or zelari (or /mode to cycle).` };
      }
      return { handled: true, kind: 'mode_set' };
    }

    case 'plan': {
      // `/plan` or `/plan <goal>` — enter plan phase; optional goal dispatches.
      const goal = args.join(' ').trim();
      return {
        handled: true,
        kind: 'phase_set',
        phaseTarget: 'plan',
        ...(goal ? { phaseGoal: goal } : {}),
      };
    }

    case 'build': {
      const goal = args.join(' ').trim();
      return {
        handled: true,
        kind: 'phase_set',
        phaseTarget: 'build',
        ...(goal ? { phaseGoal: goal } : {}),
      };
    }

    case 'view-plan': {
      return { handled: true, kind: 'view_plan' };
    }

    case 'index': {
      // `/index`         → build/rebuild the semantic code index
      // `/index status`  → show current index stats
      return args[0] === 'status'
        ? { handled: true, kind: 'index_status' }
        : { handled: true, kind: 'index_build' };
    }

    case 'checkpoint': {
      // `/checkpoint [label]` — snapshot the working tree now.
      const label = args.join(' ').trim();
      return {
        handled: true,
        kind: 'checkpoint_create',
        ...(label ? { checkpointLabel: label } : {}),
      };
    }

    case 'rollback': {
      // `/rollback`           → list checkpoints
      // `/rollback <id>`      → restore that checkpoint
      // `/rollback latest`    → restore the newest checkpoint
      const target = args[0]?.trim();
      if (!target) {
        return { handled: true, kind: 'rollback_list' };
      }
      return {
        handled: true,
        kind: 'rollback',
        ...(target === 'latest' ? {} : { rollbackId: target }),
      };
    }

    case 'workspace': {
      // Usage:
      //   /workspace                      → list artifacts + sizes
      //   /workspace show <name>          → render plan | decisions | risks | agents | docs
      //   /workspace sync                 → re-run AGENTS.MD auto-maintenance
      //   /workspace reset                → clear .zelari/ (destructive)
      //   /workspace --help               → usage hint
      const sub = args[0];
      if (!sub || sub === '--help' || sub === 'help') {
        return {
          handled: true,
          kind: 'workspace',
          message:
            'Workspace commands (`.zelari/` + `AGENTS.MD`):\n' +
            '  /workspace              — list artifacts (plan, decisions, risks, reviews, docs)\n' +
            '  /workspace show plan    — render plan.md\n' +
            '  /workspace show decisions — list ADRs (Architecture Decision Records)\n' +
            '  /workspace show risks    — render risks.md\n' +
            '  /workspace show agents   — render AGENTS.MD\n' +
            '  /workspace show docs     — list docs drafts\n' +
            '  /workspace sync          — re-run AGENTS.MD auto-curation now\n' +
            '  /workspace reset         — delete .zelari/ (destructive — confirmation required)\n' +
            '\nSee `docs/plans/2026-07-01-council-workspace-cli-stubs.md` for schema.',
        };
      }
      if (sub === 'show') {
        const what = args[1];
        if (!what) {
          return {
            handled: true,
            kind: 'workspace_show',
            workspaceWhat: '',
            message: 'Usage: /workspace show <plan|decisions|risks|agents|docs>',
          };
        }
        if (!['plan', 'decisions', 'risks', 'agents', 'docs'].includes(what)) {
          return {
            handled: true,
            kind: 'workspace_show',
            workspaceWhat: '',
            message: `Unknown artifact "${what}". Available: plan | decisions | risks | agents | docs`,
          };
        }
        return {
          handled: true,
          kind: 'workspace_show',
          workspaceWhat: what,
        };
      }
      if (sub === 'sync') {
        return { handled: true, kind: 'workspace_sync' };
      }
      if (sub === 'reset') {
        const force = args.includes('--yes') || args.includes('-y');
        if (force) {
          return { handled: true, kind: 'workspace_reset', workspaceForce: true };
        }
        return {
          handled: true,
          kind: 'workspace_reset',
          message: '⚠ /workspace reset is DESTRUCTIVE — deletes the entire `.zelari/` directory.\n'
            + 'Use `/workspace reset --yes` to confirm.',
        };
      }
      return {
        handled: true,
        kind: 'workspace',
        message: `Unknown /workspace subcommand: "${sub}". Type /workspace for usage.`,
      };
    }

    default:
      return {
        handled: false,
        kind: 'unknown',
        message: `Unknown command: /${command}. Type /help for available commands.`,
      };
  }
}
