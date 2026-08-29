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
