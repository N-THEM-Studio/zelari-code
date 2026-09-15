# ADR-0038 — Node ≥ 20.17 runtime floor and npx-first install path

- **Status:** accepted
- **Date:** 2026-09-14
- **Principles:** P4 (open runtime — the core is the value, no lock-in),
  P5 (lightness — the front door must be cheap),
  P3 (sovereignty — declared rather than enforced)
- **Related:** [ADR-0034](./0034-desktop-cli-distribution.md) (Desktop guided
  install still targets the global CLI)

## Context

Two friction points meet on the front door.

1. **A runtime floor higher than the product needs.** `engines.node` had been
   pinned to a recent major, so `npx zelari-code@latest` on a stock LTS machine
   *warned* but the surrounding experience read as if a modern Node were
   mandatory. The reusable runtime (`@zelari/core`) and the CLI's memory layer
   already degrade gracefully.
2. **A single, global-only install story.** The docs, the npm manifest
   (`preferGlobal: true`), the self-updater, and the doctor all assumed
   `npm install -g`. But `npx zelari-code` already worked: engines only *warn*,
   the `files` allow-list covers the bundle, and `scripts/postinstall.mjs` exits
   early for non-global installs. What was missing was **official support** — a
   manifest signal, docs, and updater/doctor messaging that does not mislead an
   npx user into running a global install they never made.

## Decision

### (a) Runtime floor lowered to Node ≥ 20.17.0 (npm ≥ 10)

- `engines` is `node: ">=20.17.0"`, `npm: ">=10.0.0"`. The boot prerequisite
  gate and the CI matrix both test the **Node 20 floor and Node 24**.
- `node:sqlite` **memory V2 stays opt-in** and gracefully degrades to
  `NoopMemoryService` on Node 20 (the SQLite backend is unavailable there; the
  JSON backend remains the default).
- Dev-only eval tooling (`tools/eval/*`) still requires **Node ≥ 22.6** because
  it runs `.ts` under `--experimental-strip-types`. That is a contributor-only
  path, never a user requirement.

### (b) npx-first install path

- **`preferGlobal: true` is removed** from `package.json` — the strongest signal
  the manifest can give that a global install is *an* option, not the only one.
- **npx is documented as the primary zero-install path** in `README.md`,
  `docs/GUIDA.md`, and `docs/GUIDE.md`; the global install is documented as the
  persistent alternative (fast start + `/update` self-update). The cold-cache
  `npx` start is called out honestly.
- **`/update` and the doctor are now install-aware.** `src/cli/updater.ts`
  exports `resolveInstallKind()` → `"global" | "npx" | "local" | "unknown"`.
  `performUpdate()` refuses to spawn `npm install -g` for an npx/local copy and
  returns a shared advisory (`nonGlobalUpdateAdvisory()`) instead. The `/update`
  slash handler prints the same advisory up front, and `doctor`'s global-shim
  check downgrades a missing shim from `FAIL` to **informational (WARN)** for a
  non-global install — PATH/shim expectations simply do not apply there.
- **Global installs remain fully supported** for persistent use, and remain the
  path that gets a PATH shim and `/update`. The Windows PATH repair
  (install-time `repairWindowsPath` in `scripts/postinstall.mjs`; runtime
  `src/cli/utils/fixPath.ts`, surfaced as `zelari-code --fix-path`) applies to
  **global installs only**. There is no canonical ADR for that repair (slots
  0011/0012 are permanently unassigned), so it is cited here by code rather
  than by number. Desktop's guided install (ADR-0034) likewise still targets the
  global CLI.

## Consequences

**Positive**

- The front door is cheap: `npx zelari-code@latest` needs no install, matches
  the manifest (`files` allow-list + no `preferGlobal`), and is the first thing
  the docs show.
- No surface lies to an npx user: `/update` (both the status line and the
  perform path) and `doctor` all state plainly that self-update is disabled for
  a non-global copy and name the two real options.
- The floor widens to every maintained LTS line without forcing the SQLite
  backend on machines that cannot run it.

**Negative / residual gaps (honest)**

- `resolveInstallKind()` spawns `npm prefix -g` on `/update` and on the doctor's
  shim check. If the probe fails it returns `unknown`, which the updater treats
  as "not provably non-global" and still attempts the global install — the
  pre-existing behavior. Detection is best-effort by design and never blocks or
  crashes.
- `npx` users get no in-band upgrade; they must re-run `npx zelari-code@latest`.
  That is the price of zero install, and the advisory says so.

## Alternatives considered

- **Keep `preferGlobal` and global-only docs** — rejected: contradicts a path
  that already works and leaves npx users unguided.
- **Detect non-global inside the install and silently succeed** — rejected: a
  silent no-op is worse than an explicit advisory; the global copy would not be
  the running one.
- **Hard-refuse to run without a global install** — rejected: over-constrains
  legitimate project-local/source usage (Desktop dev runs the CLI from a
  checkout).
