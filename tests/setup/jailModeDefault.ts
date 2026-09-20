/**
 * Global vitest setup — platform determinism for the OS-jail mode default.
 *
 * Production resolves ZELARI_OS_JAIL from the surface (strict ⇒ required when
 * a real backend exists). In the TEST suite that would make results depend on
 * which jail backend is installed on the machine (bwrap on CI linux, none on
 * win32): pre-existing exec/bash tests would spawn REAL jailed children on
 * some runners and raw ones elsewhere. Tests must not depend on that.
 *
 * `??=` keeps explicit opt-ins authoritative: suites that exercise the jail
 * (tests/unit/cli-osJail.test.ts, tests/unit/cli-execProcess-jail.test.ts)
 * set ZELARI_OS_JAIL themselves or inject stub backends — their value wins.
 */
process.env.ZELARI_OS_JAIL ??= 'off';

/**
 * WS3 (2.39) — Kraken worktree isolation is DEFAULT ON in production, so the
 * same machine-dependence argument applies with a much bigger cost: a `task`
 * general spawn whose cwd is the real repo would run `git worktree add` (a
 * full checkout — ~2s / 1700 files on this repo on Windows) INSIDE the
 * developer's repository, for every spawn of every unit test, and would leave
 * worktrees/branches behind if a test died mid-run. Suites that must not pay
 * that (or must not touch a real repo) ask for isolation explicitly instead:
 *
 *   - `src/cli/tools/krakenWorktreeDefault.test.ts` DELETES the variable to
 *     exercise the true default (isolation ON) against temp git fixtures;
 *   - `tests/unit/cli-taskTool-worktree.test.ts` sets `=1` for the opt-in path.
 *
 * `??=` again: a suite (or a dogfooding shell) that sets the variable wins.
 */
process.env.ZELARI_KRAKEN_WORKTREE ??= '0';
