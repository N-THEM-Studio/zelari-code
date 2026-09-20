/**
 * vscode.d.ts — MINIMAL ambient surface for this PoC.
 *
 * `@types/vscode` is NOT installed and this package must add ZERO
 * dependencies (no network install, no Marketplace tooling): the extension
 * uses five APIs, so five APIs are declared. Real typings are stricter (and
 * the host is the only authority at runtime), but nothing here is invented —
 * every member below exists in the VS Code API with this shape.
 *
 * Add a member ONLY when the adapter actually calls it. If this ever needs to
 * grow beyond a screenful, install `@types/vscode` as a devDependency instead
 * of transcribing the API by hand.
 */
declare module 'vscode' {
  export type Thenable<T> = Promise<T>;

  export interface Disposable {
    dispose(): void;
  }

  export interface OutputChannel extends Disposable {
    append(value: string): void;
    appendLine(value: string): void;
    show(preserveFocus?: boolean): void;
  }

  export interface StatusBarItem extends Disposable {
    text: string;
    tooltip: string | undefined;
    command: string | undefined;
    show(): void;
    hide(): void;
  }

  export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
  }

  export interface Uri {
    readonly fsPath: string;
    readonly path: string;
    readonly scheme: string;
  }

  export interface WorkspaceFolder {
    readonly uri: Uri;
    readonly name: string;
    readonly index: number;
  }

  export interface WorkspaceConfiguration {
    get<T>(section: string): T | undefined;
    get<T>(section: string, defaultValue: T): T;
  }

  export interface InputBoxOptions {
    prompt?: string;
    placeHolder?: string;
    value?: string;
    title?: string;
    ignoreFocusOut?: boolean;
  }

  export interface ExtensionContext {
    readonly subscriptions: Disposable[];
    readonly extensionPath: string;
  }

  export namespace window {
    export function createOutputChannel(name: string): OutputChannel;
    export function createStatusBarItem(
      alignment?: StatusBarAlignment,
      priority?: number,
    ): StatusBarItem;
    export function showInputBox(options?: InputBoxOptions): Thenable<string | undefined>;
    export function showInformationMessage(message: string): Thenable<string | undefined>;
    export function showWarningMessage(message: string): Thenable<string | undefined>;
    export function showErrorMessage(message: string): Thenable<string | undefined>;
  }

  export namespace commands {
    export function registerCommand(
      command: string,
      callback: (...args: unknown[]) => unknown,
      thisArg?: unknown,
    ): Disposable;
  }

  export namespace workspace {
    export const workspaceFolders: readonly WorkspaceFolder[] | undefined;
    export function getConfiguration(section?: string): WorkspaceConfiguration;
  }
}
