# Dependency security triage - 2.0.0-alpha.7 (Exit-3, plan F12)

> Signed snapshot required by the state document paragraph 15 before an RC:
> `alerts -> triage -> runtime vs dev-only -> reachable vs non-reachable -> upgrade / mitigate / documented accept`.

**Scope:** root workspace `zelari-code@2.0.0-alpha.7` (CLI + `@zelari/core`; desktop/companion have their own manifests and dedicated Dependabot).
**Detection environment:** `npm audit` (npm 11.6.2, Node v24.13.0, Windows) on the aligned lockfile.
**Continuous alert pipeline:** `.github/dependabot.yml` (npm root `/`, npm `/packages/core`, npm `/apps/desktop`, cargo `/apps/desktop/src-tauri`, github-actions `/`; grouped security updates, weekly cadence).

## Snapshot at detection (BEFORE)

`npm audit`: **3 vulnerable packages (high), 0 critical** - all **indirect**, all with a non-forced fix available.

| Package | Version | Severity | Advisory (GHSA) | Dependency chain | Ship class |
|---|---|---|---|---|---|
| `nanoid` | 3.3.15 | high (2x) | GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8 (CWE-835, infinite loop with negative/zero size, CVSS 5.9) | `vitest -> vite 5.4.21 -> postcss 8.5.16 -> nanoid` | **dev-only** |
| `postcss` | 8.5.16 | high | GHSA-r28c-9q8g-f849 (CWE-22, `sourceMappingURL` path traversal -> `.map` disclosure, CVSS 7.5) + GHSA-fxqj-rqcc-2cmp (moderate, incomplete fix of the previous one) | `vitest -> vite 5.4.21 -> postcss` | **dev-only** |
| `undici` | 7.28.0 | high | GHSA-4cwx-7wf7-3272 (CWE-200, cross-user disclosure via cache directives, CVSS 7.4) + 4 moderate: desync retry (GHSA-8xcm-r25x-g524), CRLF injection (GHSA-m8rv-5g2x-5cg5), cache-control whitespace (GHSA-jr45-8vmc-qm54), cookie injection (GHSA-v3r7-h72x-cjcm) - single range `>=7.0.0 <7.29.0` | `jsdom 29.1.1 -> undici` (devDep, React/ink test environment) | **dev-only** |

## Triage

### Runtime vs dev-only

**Runtime** dependencies of the shipped package (`zelari-code` `dependencies`): `ink`, `ink-text-input`, `react`, `typescript`, `zod` - **zero alerts** on them and on their subtree.
All three vulnerable packages live in **dev-only** chains (vitest/vite/postcss/nanoid for the test runner; jsdom/undici for the DOM test environment).

### Reachability in the product

`scripts/bundle-cli.mjs` bundles only `src/cli/main.ts` with externals `react`/`ink`/`ws`/`typescript`/`playwright`: none of the three packages is imported by the shipped CLI/core code, so **none enters the bundle nor the published npm package**. The practical exposure is limited to the dev/CI machine (e.g. `undici` in jsdom runs only during tests; `postcss`/`nanoid` run only inside vitest/vite).

### Action

All the fixes were **semver-compatible** transitive bumps -> applied with `npm audit fix` (without `--force`):

| Package | Before -> After | Outcome |
|---|---|---|
| `nanoid` | 3.3.15 -> **3.3.18** | ? upgraded |
| `postcss` | 8.5.16 -> **8.5.26** | ? upgraded |
| `undici` | 7.28.0 -> **7.29.0** | ? upgraded |

**AFTER: `found 0 vulnerabilities`.** No residual `documented accept` for the root workspace at this version.

## Process finding (closed in this task)

The local `node_modules` was **stale** vs `package.json`/lockfile: vitest installed at 2.1.9 against the declared `^4.1.9` (a bump never reinstalled locally). Consequences: local runs were on vitest 2 while CI (`npm ci`) would have used vitest 4, and **52 test files in `tests/unit/` were invisible to local runs** (the local suite showed 2901 tests; the real one is 3451).

The `npm audit fix` resync restored parity. Post-resync verification on vitest 4.1.9:

- full suite -> **341 files / 3451 tests pass** (2 cold-start timeout adjustments made necessary by the higher parallel load: `tests/unit/cli-toolDisplay.test.ts` first react+ink importer -> 30s; `src/cli/headlessE2eSession.test.ts` kraken chain -> 90s, in isolation the file runs in ~11s)
- `tsc --noEmit` -> exit 0
- `npm audit` -> 0 vulnerabilities

**Rule for the RC:** every major devDependency bump (vitest/jsdom) must be verified with a full post-install run (`npm ci && npm test`) before committing the lockfile - silent drift is the real risk, not the individual dev-only advisories.

## Signature

- Product: `zelari-code@2.0.0-alpha.7` / `@zelari/core@2.0.0-alpha.7`
- Tool: `npm audit` (npm 11.6.2, Node v24.13.0)
- Post-action state: 0 vulnerabilities (root workspace), suite 3451/3451 green on vitest 4.1.9
- Reference commit: this document is committed together with the updated lockfile (task F12, Alpha.8/Exit-3 plan)
- Next review: on every new Dependabot alert (weekly flow) and mandatorily at the RC gate
