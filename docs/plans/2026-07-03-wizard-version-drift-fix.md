# Wizard VERSION drift fix

> **For Hermes:** use subagent-driven-development skill to implement task-by-task.
> Each task is one commit, 2-5 min, fully reversible. STOP and verify after each task.

**Goal:** Eliminate the VERSION drift in `src/cli/wizard/index.tsx` so the wizard banner reads the same version as the rest of the CLI (`0.7.5`), instead of the stale `0.7.2`.

**Architecture:** Replace the local hardcoded `const VERSION = '0.7.2'` with an import from the existing single source of truth (`src/cli/main.ts` which exports `VERSION = '0.7.5'`). One-line change, zero behavior change, no new dependencies, no new abstractions.

**Tech Stack:** TypeScript 5.7, ESM, React 19 + Ink 6 (UI is just a render string — not testable in jsdom in a meaningful way for the banner, but `npm run smoke` exercises `--version` end-to-end).

---

## Background & scope

### What's broken

`src/cli/wizard/index.tsx:34` defines `const VERSION = '0.7.2'` and uses it in the wizard banner at line 119:

```tsx
<Text color="cyan" bold>
  zelari-code v{VERSION} — first-time setup
</Text>
```

Every other VERSION source in the repo says `0.7.5`:

| Source | Value |
|---|---|
| `package.json#version` (root) | `0.7.5` |
| `packages/core/package.json#version` | `0.7.5` |
| `src/cli/main.ts:23` `export const VERSION` | `0.7.5` |
| `src/cli/mcp/mcpClient.ts:83` clientInfo version | `0.7.5` |
| `CHANGELOG.md` latest entry | `0.7.5` (2026-07-03) |
| `git tag --sort=-creatordate` latest | `v0.7.5` |
| **`src/cli/wizard/index.tsx:34` local const** | **`0.7.2`** ❌ |

### Impact

- **User-visible**: First-run wizard banner says `zelari-code v0.7.2 — first-time setup` while `zelari-code --version` prints `0.7.5`. Inconsistent UX.
- **Background update check**: lives in `src/cli/main.ts` (already 0.7.5), so it compares the right string against npm. The wizard drift does NOT poison the update check directly — but if anyone refactors the update check to read VERSION from the wizard module, it would silently regress to "0.7.2 always thinks an update is available".
- **No tests assert the banner VERSION** (verified: `grep "VERSION\|first-time setup\|zelari-code v" tests/unit/*wizard*` returns nothing).
- **No source file imports `VERSION` from wizard/index.tsx** (verified: only `main.ts` is imported by the wizard consumer path, and it doesn't reference the wizard's local VERSION).

### Why this is the simplest fix

The single source of truth is `src/cli/main.ts:23` `export const VERSION = '0.7.5'`. main.ts is the natural dependency direction — the wizard is rendered by main.ts (via `firstRun.ts`/`runWizard.ts`), not the other way around. So importing VERSION from main.ts into the wizard module is correct architecturally and has no circular dependency risk.

Alternative considered: derive VERSION from `package.json` at build time via esbuild `--define`. Bigger change, requires touching `scripts/bundle-cli.mjs`, and the existing pattern (manual `const VERSION` in main.ts) is what the codebase already uses. YAGNI — match the existing pattern.

---

## Files

- **Modify:** `src/cli/wizard/index.tsx` (1 line replaced + 1 import added)
- **Verify:** `src/cli/main.ts` (read-only — confirms single source of truth)
- **No new files**, **no new tests** (no existing test covers this string, and adding a snapshot test for the banner would be over-engineering for a 1-line constant fix; `npm run smoke` covers `--version` end-to-end).

---

## Task 1: Add the import and remove the local const

**Objective:** Replace `const VERSION = '0.7.2'` with an import from `../main.js`, so wizard/index.tsx reads the same VERSION the rest of the CLI uses.

**Files:**
- Modify: `src/cli/wizard/index.tsx:34` (remove the local const)
- Modify: `src/cli/wizard/index.tsx` (add import after existing imports, ~line 27)

**Step 1: Verify the import path resolves**

```bash
cd ~/zelari-code && ls src/cli/main.ts && grep "^export const VERSION" src/cli/main.ts
```

Expected:
```
src/cli/main.ts
export const VERSION = '0.7.5';
```

If either fails, **stop** — `main.ts` is the contract; we don't change it.

**Step 2: Read the current imports block of wizard/index.tsx**

```bash
cd ~/zelari-code && sed -n '20,35p' src/cli/wizard/index.tsx
```

Expected:
```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { ProviderSpec } from '../keyStore.js';
import {
  API_KEY_OPTIONS,
  type ApiKeyChoice,
  type UseWizardStateApi,
} from './useWizardState.js';

export interface WizardProps {
  state: UseWizardStateApi;
  providers: readonly ProviderSpec[];
}

const VERSION = '0.7.2';
```

**Step 3: Apply the edit**

Replace line 34 (`const VERSION = '0.7.2';`) and add an import after the existing `./useWizardState.js` import block.

Exact diff:
```diff
 import {
   API_KEY_OPTIONS,
   type ApiKeyChoice,
   type UseWizardStateApi,
 } from './useWizardState.js';
+import { VERSION } from '../main.js';

 export interface WizardProps {
   state: UseWizardStateApi;
   providers: readonly ProviderSpec[];
 }

-const VERSION = '0.7.2';
-
 function Frame({ children }: { children: React.ReactNode }): React.ReactElement {
```

**Step 4: Verify the file compiles**

```bash
cd ~/zelari-code && npx tsc --noEmit -p tsconfig.json 2>&1 | head -30
```

Expected: **no output** (clean). The `tsc --noEmit` only fails if a type/symbol is missing; if `../main.js` resolves to something that exports VERSION correctly (it does — we verified in Step 1), this passes.

If tsc errors with `Module '../main.js' has no exported member 'VERSION'` → STOP, the export name drifted (extremely unlikely; would mean someone renamed the const in main.ts).

**Step 5: Run the full test suite**

```bash
cd ~/zelari-code && npm test 2>&1 | tail -20
```

Expected: same number of passing tests as before (target: all 81+ green). The fix is a one-symbol swap; no test should be affected.

If any test fails → STOP, investigate, do not commit.

**Step 6: Smoke-test the CLI end-to-end**

```bash
cd ~/zelari-code && npm run smoke 2>&1 | tail -5
```

Expected: `0.7.5` (or similar). Confirms `--version` still works (which uses main.ts VERSION — sanity check that nothing else regressed).

Also visually verify the wizard banner reads correctly. Since the wizard only renders on first run (no provider.json), the cleanest way is to inspect the built bundle:

```bash
cd ~/zelari-code && npm run build 2>&1 | tail -10
echo "---"
grep -o 'zelari-code v[0-9]\.[0-9]\.[0-9]' dist/cli/wizard/index.js
```

Expected output: `zelari-code v0.7.5` (one match).

If the grep finds `0.7.2` → the import didn't resolve at build time → STOP and investigate (esbuild bundling quirk).

**Step 7: Confirm no other drift remains**

```bash
cd ~/zelari-code && grep -rn "VERSION\s*=\s*['\"]" src/ packages/ 2>/dev/null | grep -v "MCP_PROTOCOL\|PROTOCOL_VERSION"
```

Expected output: only `src/cli/main.ts:23:export const VERSION = '0.7.5';`. No other local VERSION constants in user-facing code.

**Step 8: Commit**

```bash
cd ~/zelari-code && git add src/cli/wizard/index.tsx && git diff --cached --stat
```

Expected: `src/cli/wizard/index.tsx | 4 +-` (1 import added, 1 const removed, plus the blank line).

```bash
cd ~/zelari-code && git commit -m "$(cat <<'EOF'
fix(wizard): import VERSION from main.ts (was hardcoded 0.7.2 drift)

The first-run wizard banner rendered "zelari-code v0.7.2" while every
other VERSION source (package.json, src/cli/main.ts, mcpClient.ts,
CHANGELOG.md, latest tag) reported 0.7.5. Import VERSION from the
single source of truth instead of duplicating a stale literal.

No behavior change. No new tests needed (no test asserted the banner
string; npm run smoke covers --version end-to-end).
EOF
)"
```

Expected: commit created on `main`. Working tree clean.

---

## Verification checklist (run all before declaring done)

- [ ] `grep "VERSION\s*=\s*['\"]" src/ packages/` returns only `src/cli/main.ts:23` with `0.7.5`
- [ ] `npx tsc --noEmit -p tsconfig.json` clean
- [ ] `npm test` — all green (81+ tests, same count as before)
- [ ] `npm run smoke` — prints `0.7.5`
- [ ] `npm run build` — bundle contains `zelari-code v0.7.5`, NOT `0.7.2`
- [ ] `git log -1` shows the commit with the message above
- [ ] No other VERSION drift introduced

## What this plan does NOT do (deferral, explicit)

- **No snapshot test for the wizard banner.** The string is purely cosmetic, no test ever asserted it, and adding a snapshot test for a 1-line cosmetic const would be over-engineering. If the test suite grows to cover the wizard UI later, that's the time.
- **No build-time VERSION injection (esbuild `--define`).** The current pattern (manual `const VERSION` in main.ts) is the convention. Migrating to build-time injection is a separate refactor and YAGNI for this fix.
- **No CHANGELOG entry.** This is a 1-line drift fix in a release that already shipped (v0.7.5 is tagged). CHANGELOG entries document user-visible changes; this drift never shipped in a published artifact (wizard renders only on first run with no `provider.json`, and `npm publish` would have caught it via the build's bundle grep — but it's still cosmetic and pre-publish). If we want a `### Fixed` entry for the next patch, that's a separate decision.

## Risks

- **Risk: import causes circular dependency.** Mitigation: `main.ts` already imports from `./wizard/firstRun.js` and `./wizard/runWizard.js`. The wizard module adding an import from `../main.js` is a SAME-direction dependency (wizard → main), not circular. The TypeScript/Node ESM resolver handles this fine because the import is a single named export, not a top-level side effect.
- **Risk: bundle size or tree-shaking regression.** Mitigation: VERSION is a string literal in main.ts; importing it pulls nothing extra. No new code, no new deps.
- **Risk: someone else in the codebase hardcoded another version string we missed.** Mitigation: Step 7 of Task 1 audits all `VERSION\s*=\s*['\"]` patterns. If anything else surfaces, that's a separate fix.

## Estimated effort

15 minutes total: 1 minute editing, 5 minutes verifying (typecheck + test + build + grep), 5 minutes smoking, 5 minutes committing and documenting.