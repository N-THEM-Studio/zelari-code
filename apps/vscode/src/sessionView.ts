/**
 * sessionView — the VS Code surface of a session: the "Zelari ACP"
 * OutputChannel and the status-bar indicator.
 *
 * Adapter layer only: the line format comes from the PURE formatter in
 * protocol.ts (`describeUpdate`), so what the user sees is unit-tested
 * without an extension host. Nothing here talks protocol or spawns anything.
 */
import * as vscode from 'vscode';
import { describeUpdate, type AcpSessionUpdateParams } from './protocol.js';

export type SessionState = 'starting' | 'running' | 'stopped' | 'failed';

export interface SessionView {
  /** Raw diagnostic line (launch, handshake, turn outcomes). */
  log(line: string): void;
  /** One `session/update`: the message + tool-call stream. */
  update(params: AcpSessionUpdateParams): void;
  /** A line the agent wrote to stderr. */
  stderr(line: string): void;
  /** Status-bar state; `detail` is the short session id (or a failure hint). */
  setState(state: SessionState, detail?: string): void;
  dispose(): void;
}

const ICONS: Record<SessionState, string> = {
  starting: '$(sync~spin)',
  running: '$(pulse)',
  stopped: '$(circle-slash)',
  failed: '$(error)',
};

const LABELS: Record<SessionState, string> = {
  starting: 'starting',
  running: 'running',
  stopped: 'stopped',
  failed: 'failed',
};

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export function createSessionView(output: vscode.OutputChannel): SessionView {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 42);
  // Clicking the indicator stops the session (the command reports "no session"
  // harmlessly when nothing is running).
  status.command = 'zelari.stopSession';
  let state: SessionState = 'stopped';
  let detail: string | undefined;

  const render = (): void => {
    const suffix = detail === undefined || detail.length === 0 ? '' : ` — ${detail}`;
    status.text = `${ICONS[state]} Zelari ACP: ${LABELS[state]}${suffix}`;
    status.tooltip =
      `Zelari Code over ACP (session ${LABELS[state]})\n` +
      'Commands: Zelari: Start / Send Prompt / Stop ACP Session\n' +
      'Log: the "Zelari ACP" Output Channel';
    status.show();
  };

  render();

  return {
    log: (line) => output.appendLine(`[${stamp()}] ${line}`),
    update: (params) => output.appendLine(`[${stamp()}] ${describeUpdate(params.update)}`),
    stderr: (line) => output.appendLine(`[${stamp()}] ! ${line}`),
    setState: (next, nextDetail) => {
      state = next;
      detail = nextDetail;
      render();
    },
    dispose: () => status.dispose(),
  };
}
