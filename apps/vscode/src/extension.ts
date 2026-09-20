/**
 * extension — the THIN VS Code adapter (layer b): commands, OutputChannel,
 * status bar and lifecycle. All protocol risk lives in layer (a):
 * acpClient.ts / ndjson.ts / protocol.ts / acpTransport.ts, which import no
 * `vscode` and are unit-tested without an extension host.
 *
 * Commands:
 *   zelari.startSession  spawn `zelari-code acp`, initialize, session/new
 *   zelari.sendPrompt    showInputBox -> session/prompt (one turn at a time)
 *   zelari.stopSession   graceful shutdown: stdin EOF, then kill as fallback
 *
 * Shutdown is deliberately EOF-first: stdin EOF is what makes the CLI exit 0
 * (it is the same path scripts/smoke-acp.mjs and the server unit tests pin
 * down). `kill()` only fires if the agent is still alive after a grace
 * window, so a clean stop stays clean. `deactivate()` awaits the same path.
 */
import * as vscode from 'vscode';
import { AcpClient } from './acpClient.js';
import { AcpClientClosedError } from './acpTransport.js';
import { spawnAcpTransport } from './childTransport.js';
import { ACP_PROTOCOL_VERSION } from './protocol.js';
import { createSessionView, type SessionView } from './sessionView.js';
import type { ZelariLaunchConfig } from './launch.js';

const OUTPUT_CHANNEL_NAME = 'Zelari ACP';
/** How long a graceful stop (stdin EOF) gets before the agent is killed. */
const KILL_GRACE_MS = 2_000;

interface ActiveSession {
  client: AcpClient;
  view: SessionView;
  sessionId: string;
}

let active: ActiveSession | undefined;
let output: vscode.OutputChannel | undefined;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shortId(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : `${sessionId.slice(0, 8)}…`;
}

function channel(): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  return output;
}

/** Settings → launch configuration (resolution rules live in launch.ts). */
function readLaunchConfig(): Partial<ZelariLaunchConfig> {
  const config = vscode.workspace.getConfiguration('zelari');
  return {
    command: config.get<string>('command', 'zelari-code'),
    args: config.get<string[]>('args', ['acp']),
    cliPath: config.get<string>('cliPath', ''),
    nodePath: config.get<string>('nodePath', 'node'),
  };
}

function workspaceCwd(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0) return undefined;
  return folders[0]?.uri.fsPath;
}

function attach(session: ActiveSession): void {
  const { client, view } = session;
  client.on('update', (params) => view.update(params));
  client.on('stderr', (line) => view.stderr(line));
  client.on('exit', (info) =>
    view.log(`agent exited (code ${info.code ?? 'null'}, signal ${info.signal ?? 'none'})`),
  );
  client.on('closed', (info) => {
    if (active === session) active = undefined;
    view.log(`session closed: ${info.reason}${info.message === undefined ? '' : ` — ${info.message}`}`);
    if (info.reason === 'shutdown' || (info.reason === 'exit' && info.code === 0)) {
      view.setState('stopped');
      return;
    }
    view.setState('failed', info.reason);
  });
}

async function startSession(): Promise<void> {
  if (active !== undefined) {
    void vscode.window.showInformationMessage(
      `Zelari: a session is already running (${shortId(active.sessionId)}). Stop it first.`,
    );
    return;
  }

  const cwd = workspaceCwd();
  const view = createSessionView(channel());
  view.setState('starting');
  channel().show(true);

  const spawned = spawnAcpTransport({
    config: readLaunchConfig(),
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (!spawned.ok) {
    view.log(`launch failed: ${spawned.reason}`);
    view.setState('failed', 'launch failed');
    void vscode.window.showErrorMessage(`Zelari: ${spawned.reason}`);
    return;
  }

  const { program, args, useShell } = spawned.spec;
  view.log(`launching: ${program} ${args.join(' ')}${useShell ? '  (through a shell)' : ''}`);

  const client = new AcpClient(spawned.transport, (line) => view.log(line));
  const session: ActiveSession = { client, view, sessionId: '' };
  active = session;
  attach(session);

  try {
    const init = await client.initialize();
    view.log(
      `initialize: protocolVersion ${init.protocolVersion}` +
        ` (this extension speaks v${ACP_PROTOCOL_VERSION}), loadSession ` +
        `${String(init.agentCapabilities?.loadSession ?? false)}`,
    );
    if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
      view.log(
        `warning: the agent reports protocol v${init.protocolVersion}; ` +
          `only v${ACP_PROTOCOL_VERSION} is exercised by this PoC`,
      );
    }
    const sessionId = await client.newSession(cwd);
    session.sessionId = sessionId;
    view.log(`session ready: ${sessionId}${cwd === undefined ? ' (agent default cwd)' : ` (cwd: ${cwd})`}`);
    view.setState('running', shortId(sessionId));
  } catch (err) {
    if (err instanceof AcpClientClosedError) {
      view.log(`the session closed during startup: ${err.message}`);
      view.setState('stopped');
      return;
    }
    view.log(`handshake failed: ${messageOf(err)}`);
    view.setState('failed', 'handshake failed');
    void vscode.window.showErrorMessage(`Zelari: ${messageOf(err)}`);
    await stopSession('failed handshake', 'kill');
  }
}

async function sendPrompt(): Promise<void> {
  const session = active;
  if (session === undefined || session.sessionId.length === 0) {
    void vscode.window.showWarningMessage(
      'Zelari: no session is running — run "Zelari: Start ACP Session" first.',
    );
    return;
  }
  const text = await vscode.window.showInputBox({
    prompt: 'Prompt for Zelari Code (one turn; the tool-call stream shows in the “Zelari ACP” channel)',
    placeHolder: 'Describe the task…',
    ignoreFocusOut: true,
  });
  const trimmed = text?.trim() ?? '';
  if (trimmed.length === 0) return;

  session.view.log(`user> ${trimmed}`);
  channel().show(true);
  try {
    const stopReason = await session.client.prompt(session.sessionId, trimmed);
    session.view.log(`turn> ${stopReason}`);
  } catch (err) {
    session.view.log(`turn failed: ${messageOf(err)}`);
    void vscode.window.showErrorMessage(`Zelari: ${messageOf(err)}`);
  }
}

/**
 * Stop the session: close the agent's stdin (its clean-shutdown signal), wait
 * for the process to exit, and only then — after `KILL_GRACE_MS` — kill it.
 */
async function stopSession(reason: string, fallback: 'kill' | 'none' = 'kill'): Promise<void> {
  const session = active;
  if (session === undefined) return;
  active = undefined;
  session.view.log(`stopping (${reason}): closing the agent's stdin (EOF)`);

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (fallback === 'kill') {
        session.view.log(`the agent did not exit within ${KILL_GRACE_MS}ms: killing it`);
        session.client.kill();
      }
      finish();
    }, KILL_GRACE_MS);
    session.client.on('closed', finish);
    session.client.shutdown();
  });

  session.view.setState('stopped');
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('zelari.startSession', () => startSession()),
    vscode.commands.registerCommand('zelari.sendPrompt', () => sendPrompt()),
    vscode.commands.registerCommand('zelari.stopSession', () => stopSession('command')),
  );
}

/** VS Code awaits this: the agent gets a graceful stop before the host unloads. */
export function deactivate(): Promise<void> {
  return stopSession('deactivate');
}
