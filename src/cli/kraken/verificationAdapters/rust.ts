/**
 * verificationAdapters/rust — Cargo workspaces (t19 §P1.A).
 *
 * `cargo check` / `cargo test` / `cargo build` are INTRINSIC verbs of the
 * cargo toolchain, so all three slots stay unconditional — there is no
 * "script missing" concept to adapt to, and adding conditional gates would
 * manufacture uncertainty the toolchain doesn't have.
 *
 * Decision (t19, deliberate): `Cargo.lock` presence is NOT required for the
 * build slot. Libraries routinely gitignore their lockfile, and cargo
 * regenerates one deterministically during the build — gating on it would
 * drop a perfectly runnable criterion on most lib repositories. Workspace
 * member crates (nested Cargo.toml) are out of v1 scope; the root manifest
 * is the detection boundary.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { NativePackCommands, VerificationAdapter } from './types.js';

async function fileExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

export const rustAdapter: VerificationAdapter = {
  async detect(root: string): Promise<number> {
    return (await fileExists(path.join(root, 'Cargo.toml'))) ? 10 : 0;
  },

  async buildPlan(_root: string): Promise<NativePackCommands> {
    void _root; // commands run against the engine's workspace root
    return {
      typecheckCommand: 'cargo check',
      testCommand: 'cargo test',
      buildCommand: 'cargo build',
    };
  },
};
