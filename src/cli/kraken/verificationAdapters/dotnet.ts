/**
 * verificationAdapters/dotnet — .NET solutions and projects (P1.A2 / t24).
 *
 * Ecosystem ownership: a root containing any `*.sln` / `*.slnx` (score 4) or
 * `*.csproj` / `*.fsproj` (score 3). The scan is depth-1 ONLY — the honest,
 * cheap, deterministic boundary for v1. Nested-only layouts (a project file
 * under src/ with nothing at the root) are deliberately NOT claimed:
 * `dotnet` verbs would run against a directory with no buildable input and
 * misreport as `fail` instead of an honest not-applicable.
 *
 * Honest-unknown rule: .NET has no typecheck verb separate from compilation
 * (`dotnet build` compiles AND validates), so typecheck stays null. test and
 * build bind unconditionally: `dotnet test` / `dotnet build` natively target
 * the solution or the project in the working directory.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { NativePackCommands, VerificationAdapter } from './types.js';

const SOLUTION_EXTENSIONS: readonly string[] = ['.sln', '.slnx'];
const PROJECT_EXTENSIONS: readonly string[] = ['.csproj', '.fsproj'];

/**
 * Whether any root-level FILE ends with one of `extensions`
 * (case-insensitive — Windows-authored trees commonly uppercase them).
 * An unreadable root → false (honest absence, never a guess).
 */
async function hasRootFileWithExtension(root: string, extensions: readonly string[]): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (entry) =>
      entry.isFile() && extensions.some((ext) => entry.name.toLowerCase().endsWith(ext)),
  );
}

export const dotnetAdapter: VerificationAdapter = {
  async detect(root: string): Promise<number> {
    if (await hasRootFileWithExtension(root, SOLUTION_EXTENSIONS)) return 4;
    return (await hasRootFileWithExtension(root, PROJECT_EXTENSIONS)) ? 3 : 0;
  },

  async buildPlan(_root: string): Promise<NativePackCommands> {
    void _root; // dotnet verbs resolve the sln/project in the working dir themselves
    return {
      typecheckCommand: null, // compilation IS the check — see header
      testCommand: 'dotnet test',
      buildCommand: 'dotnet build',
    };
  },
};
