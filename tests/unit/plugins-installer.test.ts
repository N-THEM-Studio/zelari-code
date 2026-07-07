/**
 * plugins-installer.test.ts — tests for installPlugin.
 *
 * Validates the spawn args (per-scope: -D vs -g), the win32 .cmd shim path,
 * the broken-shim fallback to bundled npm, and the never-throw contract.
 * Mirrors the test approach updater.ts would use: inject a fake `spawn`
 * that records args + emits close events.
 *
 * Pattern: a synthetic ChildProcess emitter fed to installPlugin's injected
 * executor. Each scenario configures the executor to resolve with a specific
 * exit code / output, so we assert on the args + result without real npm.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { PluginSpec } from "../../src/cli/plugins/registry.js";
import type { ChildProcess } from "node:child_process";

/** Build a minimal PluginSpec for testing — only the installer-relevant fields. */
function mkSpec(overrides: Partial<PluginSpec> = {}): PluginSpec {
  return {
    id: "eslint",
    label: "ESLint",
    npmPackage: "eslint",
    installScope: "dev",
    detect: () => Promise.resolve(false),
    featureGate: "ZELARI_DIAGNOSTICS",
    description: "test",
    ...overrides,
  };
}

/**
 * Build a fake spawn that records invocations + resolves each child with the
 * scenario's exit code / output. Returns the recorder + the spawn fn.
 */
function makeFakeSpawn(scenario: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  emitError?: string;
}) {
  const calls: { cmd: string; args: readonly string[]; opts?: unknown }[] = [];
  const spawn = vi.fn((cmd: string, args: readonly string[], opts?: unknown): ChildProcess => {
    calls.push({ cmd, args, opts });
    const ee = new EventEmitter() as ChildProcess;
    // Attach stdout/stderr as Emitters so .on('data') works.
    (ee as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (ee as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    // Emit async so the caller's 'data' listeners attach first.
    queueMicrotask(() => {
      const so = (ee as unknown as { stdout: EventEmitter }).stdout;
      const se = (ee as unknown as { stderr: EventEmitter }).stderr;
      if (scenario.stdout) so.emit("data", Buffer.from(scenario.stdout));
      if (scenario.stderr) se.emit("data", Buffer.from(scenario.stderr));
      if (scenario.emitError) {
        ee.emit("error", new Error(scenario.emitError));
      } else {
        ee.emit("close", scenario.exitCode ?? 0);
      }
    });
    return ee;
  });
  return { spawn, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("installPlugin — npm args", () => {
  it("uses -D for project-local (dev) scope", async () => {
    const { spawn, calls } = makeFakeSpawn({ exitCode: 0, stdout: "added 1 package" });
    const { installPlugin } = await importFresh();
    const result = await installPlugin(mkSpec({ installScope: "dev" }), "/repo", spawn);
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    const tokens = tokenize(calls[0]);
    expect(tokens).toContain("install");
    expect(tokens).toContain("-D");
    expect(tokens).toContain("eslint");
    expect(tokens).not.toContain("-g");
  });

  it("uses -g for global scope (LSP servers)", async () => {
    const { spawn, calls } = makeFakeSpawn({ exitCode: 0 });
    const { installPlugin } = await importFresh();
    const result = await installPlugin(
      mkSpec({ npmPackage: "typescript-language-server", installScope: "global" }),
      "/repo",
      spawn,
    );
    expect(result.ok).toBe(true);
    const tokens = tokenize(calls[0]);
    expect(tokens).toContain("-g");
    expect(tokens).toContain("typescript-language-server");
    expect(tokens).not.toContain("-D");
  });
});

describe("installPlugin — result handling", () => {
  it("returns ok:true + output on exit code 0", async () => {
    const { spawn } = makeFakeSpawn({ exitCode: 0, stdout: "added 1 package\n" });
    const { installPlugin } = await importFresh();
    const result = await installPlugin(mkSpec(), "/repo", spawn);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("added 1 package");
    expect(result.error).toBeUndefined();
  });

  it("returns ok:false + error on non-zero exit", async () => {
    const { spawn } = makeFakeSpawn({
      exitCode: 1,
      stderr: "npm ERR! ERESOLVE\n",
    });
    const { installPlugin } = await importFresh();
    const result = await installPlugin(mkSpec(), "/repo", spawn);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("ERESOLVE");
    expect(result.error).toMatch(/code 1/);
  });

  it("returns ok:false on spawn 'error' event (ENOENT / missing npm)", async () => {
    const { spawn } = makeFakeSpawn({ emitError: "spawn npm ENOENT" });
    const { installPlugin } = await importFresh();
    const result = await installPlugin(mkSpec(), "/repo", spawn);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(null);
    expect(result.error).toBe("spawn npm ENOENT");
  });

  it("triggers the broken-shim fallback when primary fails with exit 127", async () => {
    // Two-call scenario: first spawn fails with 127 (broken shim), second
    // (bundled npm) succeeds. resolveBundledNpmCli must return a path.
    let call = 0;
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const spawn = vi.fn((cmd: string, args: readonly string[]): ChildProcess => {
      calls.push({ cmd, args });
      call += 1;
      const ee = new EventEmitter() as ChildProcess;
      (ee as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      (ee as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      queueMicrotask(() => {
        if (call === 1) {
          // First call: exit 127 (looks like broken shim).
          (ee as unknown as { stderr: EventEmitter }).stderr.emit("data", Buffer.from("shim target not found"));
          ee.emit("close", 127);
        } else {
          // Second call (bundled npm): success.
          ee.emit("close", 0);
        }
      });
      return ee;
    });
    const { installPlugin } = await importFresh();
    const result = await installPlugin(mkSpec(), "/repo", spawn);
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/shim failed.*retried via bundled npm/);
    expect(calls.length).toBe(2);
  });
});

/** Isolated import so mocks reset between tests. */
async function importFresh() {
  vi.resetModules();
  return (await import("../../src/cli/plugins/installer.js")) as typeof import("../../src/cli/plugins/installer.js");
}

/**
 * Normalize a recorded spawn call into a flat token list, regardless of
 * platform: on win32 runNpm passes a single pre-quoted command-line STRING
 * (buildCmdLine) as `cmd` with no args array; on POSIX it passes cmd='npm'
 * plus an args array. We split the win32 string on whitespace — sufficient
 * for asserting on flag/package tokens (none contain spaces).
 */
function tokenize(call: { cmd: string; args: readonly string[] }): string[] {
  const { cmd, args } = call;
  if (Array.isArray(args) && args.length > 0) {
    return [cmd, ...args];
  }
  // win32: cmd is the full quoted command line. Split on whitespace.
  return cmd.split(/\s+/).filter(Boolean);
}
