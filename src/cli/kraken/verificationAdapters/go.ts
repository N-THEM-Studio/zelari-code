/**
 * verificationAdapters/go — Go modules (t19 §P1.A).
 *
 * Slot-mapping decision (documented per task brief): Go has NO separate
 * typecheck verb — compilation IS the typecheck — and the canonical static
 * gate is `go vet ./...`. Vet is therefore mapped onto the TYPECHECK slot:
 * it is the semantic equivalent of what `tsc --noEmit` enforces on Node
 * repos (compile errors + suspicious constructs, no artifacts emitted),
 * keeping strict-mode meaning aligned across ecosystems.
 *
 * `./...` patterns cover every package in the module and its subpackages —
 * matching how Go teams gate CI.
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

export const goAdapter: VerificationAdapter = {
  async detect(root: string): Promise<number> {
    return (await fileExists(path.join(root, 'go.mod'))) ? 10 : 0;
  },

  async buildPlan(_root: string): Promise<NativePackCommands> {
    return {
      typecheckCommand: 'go vet ./...', // mapped slot — see rationale above
      testCommand: 'go test ./...',
      buildCommand: 'go build ./...',
    };
  },
};
