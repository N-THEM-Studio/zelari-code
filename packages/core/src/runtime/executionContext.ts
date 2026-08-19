/**
 * runtime/executionContext.ts — the seam bundle handed to engines and tools.
 *
 * Everything with side effects enters through here: session writer,
 * workspace (jailed), fs/shell/subagent providers, active profile and the
 * experimental flag gate. Built by `createExecutionContext`; the CLI may
 * inject its own providers (e.g. the real task-tool subagent path).
 */

import path from 'node:path';
import type { SessionEventInput, SessionEventEnvelope } from '../session/types.js';
import type { SessionLogWriter } from '../session/writer.js';
import { SessionStore } from '../session/store.js';
import { isExperimentalEnabled, type ExperimentalFlag } from '../experimental.js';
import {
  LocalWorkspace,
  NOOP_SUBAGENT_PROVIDER,
  type FsProvider,
  type ShellProvider,
  type SubagentProvider,
  type WorkspaceProvider,
} from './providers.js';
import { NodeFsProvider, NodeShellProvider } from './nodeProviders.js';
import { resolveProfile, toolManifestHash, type Profile } from './profiles.js';

export interface ExecutionContext {
  readonly sessionId: string;
  readonly profile: Profile;
  readonly workspace: WorkspaceProvider;
  readonly fs: FsProvider;
  readonly shell: ShellProvider;
  readonly subagent: SubagentProvider;
  /** Append an event to the session spine (verification, notes, tasks…). */
  appendSessionEvent(input: SessionEventInput): Promise<SessionEventEnvelope>;
  experimental(flag: ExperimentalFlag): boolean;
}

export interface CreateExecutionContextOptions {
  workspaceRoot?: string;
  sessionsDir?: string;
  profileId?: string;
  workspace?: WorkspaceProvider;
  fs?: FsProvider;
  shell?: ShellProvider;
  subagent?: SubagentProvider;
  env?: Record<string, string | undefined>;
  reason?: string;
}

export interface ExecutionContextHandle {
  readonly ctx: ExecutionContext;
  readonly writer: SessionLogWriter;
  readonly store: SessionStore;
  /** End the session cleanly and release the writer lock. */
  close(reason?: string): Promise<void>;
}

/** Create a session + providers bundle. `close()` ends the session. */
export async function createExecutionContext(
  options: CreateExecutionContextOptions = {},
): Promise<ExecutionContextHandle> {
  const workspace = options.workspace ?? new LocalWorkspace(path.resolve(options.workspaceRoot ?? process.cwd()));
  const profile = resolveProfile(options.profileId ?? 'kraken/v1');
  const store = SessionStore.withDefaults({
    baseDir: options.sessionsDir,
    workspaceRoot: options.workspaceRoot,
    env: options.env,
  });
  const { sessionId, writer } = await store.create({
    reason: options.reason ?? 'execution-context',
    profile: profile.id,
    workspace: workspace.root,
  });
  await writer.append({
    kind: 'note',
    actor: { type: 'system', role: 'profiles' },
    data: {
      note: 'profile manifest',
      profileId: profile.id,
      toolManifestHash: toolManifestHash(profile.tools),
      workspaceKind: workspace.kind,
    },
  });
  const fs = options.fs ?? new NodeFsProvider(workspace);
  const shell = options.shell ?? new NodeShellProvider(workspace);
  const subagent = options.subagent ?? NOOP_SUBAGENT_PROVIDER;
  const env = options.env ?? process.env;
  const ctx: ExecutionContext = {
    sessionId,
    profile,
    workspace,
    fs,
    shell,
    subagent,
    appendSessionEvent: (input) => writer.append(input),
    experimental: (flag) => isExperimentalEnabled(flag, env),
  };
  return {
    ctx,
    writer,
    store,
    close: async (reason = 'completed') => {
      await writer.append({ kind: 'session.ended', actor: { type: 'system' }, data: { reason } });
      await writer.close();
    },
  };
}
