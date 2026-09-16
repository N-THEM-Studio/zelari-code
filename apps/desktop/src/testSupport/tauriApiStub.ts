/**
 * tauriApiStub.ts — canonical `@tauri-apps/*` stub for the ROOT vitest run.
 *
 * CI runs `npm test` at the monorepo root and NEVER installs
 * `apps/desktop/node_modules` (see `apps/desktop/src/liveTasks/workspacePlanIo.ts`:
 * "do not pull `@tauri-apps/api` — CI `npm test` never installs desktop").
 * Any desktop component whose import graph reaches a static `@tauri-apps/*`
 * import (e.g. `agentClient.ts` -> `invoke`) fails at vite:import-analysis
 * time on CI even when the import is never exercised by the test.
 *
 * `vitest.config.ts` aliases every `@tauri-apps/*` specifier used by
 * `apps/desktop/src` to this single stub, so unit tests resolve on any
 * machine with or without the desktop install. The stub exports the full
 * surface mapped by the alias list — keep both in sync when adding a new
 * Tauri API to desktop source files.
 */

export const invoke = async (_cmd: string, _args?: unknown): Promise<unknown> =>
  undefined;

export const convertFileSrc = (filePath: string, _protocol = "asset"): string =>
  filePath;

export type UnlistenFn = () => void;

export const listen = async (
  _event: string,
  _handler: (payload: unknown) => void,
): Promise<UnlistenFn> => () => undefined;

export const emit = async (_event: string, _payload?: unknown) => undefined;

export const getVersion = async (): Promise<string> => "0.0.0-stub";

export class LogicalSize {
  constructor(
    public width: number,
    public height: number,
  ) {}
}

const windowStub = {
  listen: async () => () => undefined,
  unlisten: async () => undefined,
  emit: async () => undefined,
  setTitle: async () => undefined,
  scaleFactor: 1,
  innerPosition: { x: 0, y: 0 },
  outerPosition: { x: 0, y: 0 },
  innerSize: { width: 0, height: 0 },
  outerSize: { width: 0, height: 0 },
  isFullscreen: false,
  isFocused: true,
};

export const getCurrentWindow = () => windowStub;

export const availableMonitors = async () => [];
export const currentMonitor = async () => null;

export class WebviewWindow {
  constructor(
    public label: string,
    _options?: unknown,
  ) {}
  static async getByLabel(_label: string): Promise<WebviewWindow | null> {
    return null;
  }
  async setTitle(_title: string) {}
  async close() {}
  async listen() {
    return () => undefined;
  }
}

export const open = async (
  _options?: unknown,
): Promise<string | string[] | null> => null;

export const revealItemInDir = async (_path: string) => undefined;
export const openUrl = async (_url: string) => undefined;

export interface Update {
  version: string;
  body?: string;
  downloadAndInstall: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
}

export const check = async (): Promise<Update | null> => null;

export const relaunch = async () => undefined;
