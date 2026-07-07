#!/usr/bin/env node
/**
 * postinstall.mjs — Shim health check for global installs.
 *
 * Why this exists:
 *   On Windows + npm 10/11, `npm install -g zelari-code@<x>` sometimes
 *   fails to (re)create the bin shim `zelari-code.cmd` after an upgrade
 *   (e.g. 0.7.x → 1.0.x). The package is correctly installed in
 *   `<prefix>/node_modules/zelari-code/`, but `<prefix>/zelari-code.cmd`
 *   is missing, so `zelari-code` returns "command not found" on the
 *   next shell open. This script runs as `postinstall` and:
 *
 *     1. Detects global installs only (skips local installs to avoid noise).
 *     2. Verifies the expected shim path exists and is current.
 *     3. If missing or stale, prints a clear, actionable warning with the
 *        exact fix command. It does NOT auto-repair the shim — auto-repair
 *        is risky (shim is a privileged file in the global prefix and a
 *        misdirected symlink can shadow other tools).
 *     4. Also warns if the npm global prefix is not on the current PATH,
 *        which is a separate-but-related failure mode (npm install
 *        succeeds, the shim exists, but the user can't run the command
 *        because the prefix isn't reachable from their shell).
 *
 * All output goes to stderr so it doesn't pollute the install log on
 * success. The script is fail-safe: any error here is swallowed and
 * logged, never thrown — a broken postinstall must NEVER fail the
 * install itself.
 *
 * @see scripts/diagnose-path.ps1 — interactive Windows diagnostic
 * @see scripts/fix-path.ps1 — adds npm prefix to user PATH
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

/**
 * Auto-repair a MISSING Windows bin shim.
 *
 * This is the single most common "zelari-code: command not found on some
 * Windows PCs" failure: npm correctly unpacks the package into
 * `<prefix>\node_modules\zelari-code\` but never (re)creates the three bin
 * shims `<prefix>\zelari-code[.cmd|.ps1]`, so nothing on PATH resolves the
 * command. Repairing this is safe — unlike overwriting a shim that points
 * elsewhere (which could shadow another tool, hence why we never touch an
 * existing shim), writing a shim under OUR own bin name, pointing at OUR
 * own installed package, only fills a gap npm left behind.
 *
 * We write the exact same three files npm's own `cmd-shim` produces (cmd,
 * PowerShell, and a POSIX sh wrapper for Git Bash/MSYS), each resolving to
 * `%~dp0\node_modules\zelari-code\bin\zelari-code.js` relative to the shim
 * dir — which is the global prefix, exactly where the package was unpacked.
 *
 * Opt out with `ZELARI_NO_SHIM_REPAIR=1`. Never throws; returns true only
 * when at least the `.cmd` shim was written.
 *
 * @param {string} prefix   npm global prefix (dir that holds the shims)
 * @param {string} pkgName  installed package name
 * @returns {boolean}       true if the .cmd shim was created
 */
function repairWindowsShim(prefix, pkgName) {
  if (process.env.ZELARI_NO_SHIM_REPAIR === '1') return false;
  const rel = `node_modules\\${pkgName}\\bin\\zelari-code.js`;
  const relPosix = `node_modules/${pkgName}/bin/zelari-code.js`;

  const cmd = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`,
    '',
  ].join('\r\n');

  const ps1 = [
    '#!/usr/bin/env pwsh',
    '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
    '',
    '$exe=""',
    'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
    '  $exe=".exe"',
    '}',
    '$ret=0',
    'if (Test-Path "$basedir/node$exe") {',
    '  if ($MyInvocation.ExpectingInput) {',
    `    $input | & "$basedir/node$exe"  "$basedir/${relPosix}" $args`,
    '  } else {',
    `    & "$basedir/node$exe"  "$basedir/${relPosix}" $args`,
    '  }',
    '  $ret=$LASTEXITCODE',
    '} else {',
    '  if ($MyInvocation.ExpectingInput) {',
    `    $input | & "node$exe"  "$basedir/${relPosix}" $args`,
    '  } else {',
    `    & "node$exe"  "$basedir/${relPosix}" $args`,
    '  }',
    '  $ret=$LASTEXITCODE',
    '}',
    'exit $ret',
    '',
  ].join('\n');

  const sh = [
    '#!/bin/sh',
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    '',
    'case `uname` in',
    '    *CYGWIN*|*MINGW*|*MSYS*)',
    '        if command -v cygpath > /dev/null 2>&1; then',
    '            basedir=`cygpath -w "$basedir"`',
    '        fi',
    '    ;;',
    'esac',
    '',
    'if [ -x "$basedir/node" ]; then',
    `  exec "$basedir/node"  "$basedir/${relPosix}" "$@"`,
    'else',
    `  exec node  "$basedir/${relPosix}" "$@"`,
    'fi',
    '',
  ].join('\n');

  const targets = [
    ['zelari-code.cmd', cmd],
    ['zelari-code.ps1', ps1],
    ['zelari-code', sh],
  ];
  let cmdWritten = false;
  for (const [name, content] of targets) {
    const dest = path.join(prefix, name);
    // Never clobber an existing shim — only fill the gap npm left.
    if (existsSync(dest)) continue;
    try {
      writeFileSync(dest, content, 'utf8');
      if (name === 'zelari-code.cmd') cmdWritten = true;
    } catch {
      // Permission denied (prefix owned by admin) or read-only FS — the
      // warning below still tells the user how to fix it manually.
    }
  }
  return cmdWritten;
}

const warn = (msg) => {
  // eslint-disable-next-line no-console
  console.warn(`[zelari-code postinstall] ${msg}`);
};

const note = (msg) => {
  // eslint-disable-next-line no-console
  console.warn(`[zelari-code postinstall] ${msg}`);
};

/**
 * Best-effort git availability check (v1.4.0).
 *
 * git is not a hard prerequisite (zelari-code boots without it), but /diff,
 * /undo and the live git sidebar all silently degrade to no-op when git is
 * missing — which is confusing. Surface it once at install/update time so
 * the user knows what they're missing and how to fix it. Node is NOT checked
 * here: by definition npm (which requires node) just ran this script.
 *
 * Non-blocking, fail-safe: any error is swallowed. Mirrors the contract of
 * the rest of this file (never throw, never fail the install).
 */
function checkGitAvailable() {
  try {
    let out = '';
    try {
      out = execSync('git --version', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // git not on PATH — fall through to the warning below.
    }
    if (!out) {
      const hint =
        process.platform === 'win32'
          ? 'Install Git for Windows: https://git-scm.com/download/win'
          : process.platform === 'darwin'
            ? 'Install git: `brew install git` (or Xcode command-line tools)'
            : 'Install git: `apt install git` (or your distro equivalent)';
      warn('--------------------------------------------------------------');
      warn(' git not found on PATH (optional but recommended).');
      warn('--------------------------------------------------------------');
      warn('  Without git, /diff, /undo and the git sidebar are disabled.');
      warn(`  ${hint}`);
      warn('  Run `zelari-code --doctor` after install to re-check.');
      warn('--------------------------------------------------------------');
    }
  } catch {
    // Even the check itself must never break the install.
  }
}

try {
  // 0. Only run for global installs. Local installs (`npm install zelari-code`)
  //    create a `node_modules/.bin/zelari-code` symlink that npm handles
  //    correctly, and the user runs the command via `npx` or package.json
  //    scripts — so the global-prefix shim is irrelevant.
  //
  //    npm sets `npm_config_global=true` for `npm install -g` and for
  //    `npm install -g <pkg>` invocations. Some npm versions also set
  //    `npm_install_global` — check both for safety.
  const isGlobal =
    process.env.npm_config_global === 'true' ||
    process.env.npm_install_global === 'true' ||
    process.env.NPM_CONFIG_GLOBAL === 'true';

  if (!isGlobal) {
    process.exit(0);
  }

  // 1. Resolve the global prefix. Prefer the env var (set by npm), fall
  //    back to `npm prefix -g`. If both fail, bail silently — we can't
  //    diagnose without knowing where to look.
  let prefix = (process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX || '').trim();
  if (!prefix) {
    try {
      prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    } catch {
      // npm not on PATH, or this is a weirdly-sandboxed install.
      // Either way, we can't help further.
      process.exit(0);
    }
  }

  const pkgName = process.env.npm_package_name || 'zelari-code';
  const pkgVersion = process.env.npm_package_version || 'unknown';
  const expectedBinScript = path.join(pkgRoot, 'bin', 'zelari-code.js');
  const isWin = process.platform === 'win32';
  const shimName = isWin ? 'zelari-code.cmd' : 'zelari-code';
  const shimPath = path.join(prefix, shimName);
  const expectedNodeModulesShim = isWin
    ? `%~dp0\\node_modules\\${pkgName}\\bin\\zelari-code.js`
    : path.join(prefix, 'node_modules', pkgName, 'bin', 'zelari-code.js');

  // 2. Check the shim.
  let shimOk = false;
  let shimReason = '';

  if (!existsSync(shimPath)) {
    shimReason = `shim file not found at ${shimPath}`;
    // Auto-repair the most common Windows failure: the package unpacked but
    // npm never created the bin shim. We only write shims that are MISSING,
    // and only under our own bin name → no risk of shadowing another tool.
      if (isWin) {
      const repaired = repairWindowsShim(prefix, pkgName);
      if (repaired && existsSync(shimPath)) {
        note(`shim was missing — auto-created ${shimPath}`);
        note('open a NEW terminal and run `zelari-code --version` to confirm.');
        checkGitAvailable();
        process.exit(0);
      }
    }
  } else {
    try {
      const st = statSync(shimPath);
      if (isWin) {
        // Windows: .cmd shim. Validate the content references the current
        // package name + bin path. The exact text varies slightly across
        // npm versions, so we just check for the package name + the
        // bin/zelari-code.js substring.
        const content = readFileSync(shimPath, 'utf8');
        if (content.includes(`${pkgName}\\bin\\zelari-code.js`) || content.includes(`${pkgName}/bin/zelari-code.js`)) {
          shimOk = true;
        } else {
          shimReason = `shim at ${shimPath} does not reference ${pkgName}/bin/zelari-code.js — it may belong to a different install`;
        }
      } else {
        // POSIX: symlink (or hardlink). readlinkSync throws for non-symlinks.
        let target;
        try {
          target = readlinkSync(shimPath);
        } catch {
          // Not a symlink — could be a hardlink or a copied file. In
          // either case, npm shouldn't have done that. Treat as broken.
          shimReason = `shim at ${shimPath} is not a symlink (npm should create a symlink for global installs on POSIX)`;
          shimOk = false;
        }
        if (target) {
          const resolved = path.resolve(path.dirname(shimPath), target);
          if (resolved === expectedNodeModulesShim) {
            shimOk = true;
          } else {
            shimReason = `shim at ${shimPath} points to ${resolved}, expected ${expectedNodeModulesShim}`;
          }
        }
      }
      // If we reach here with shimOk still false and shimReason still empty,
      // it's a non-symlink non-cmd file — leave shimReason empty so the
      // generic message is shown.
      if (!shimOk && !shimReason) {
        shimReason = `shim at ${shimPath} is not a regular file or symlink (mode=${st.mode})`;
      }
    } catch (err) {
      shimReason = `could not inspect shim at ${shimPath}: ${err.message}`;
    }
  }

  if (shimOk) {
    note(`shim OK: ${shimPath}`);
    checkGitAvailable();
    process.exit(0);
  }

  // 3. Shim is broken or missing. Emit a clear, actionable warning.
  warn('==============================================================');
  warn(' npm install completed, but the `zelari-code` shim is broken.');
  warn('==============================================================');
  warn(`  Reason: ${shimReason}`);
  warn('');
  warn('  The package itself is correctly installed in:');
  warn(`    ${path.join(prefix, 'node_modules', pkgName)}`);
  warn('  But the bin shim is not where npm should have created it:');
  warn(`    ${shimPath}`);
  warn('');
  warn('  Symptom: `zelari-code` returns "command not found" in your');
  warn('  shell, even though `npm ls -g` lists the package.');
  warn('');
  warn('  Fix (try in order, run as Administrator on Windows if needed):');
  warn('');
  warn(`    npm install -g ${pkgName}@${pkgVersion} --force`);
  warn('');
  warn('  If the command is still not found after that, your npm');
  warn('  global prefix may not be on your shell PATH. Run:');
  warn('');
  warn('    npm bin -g           # shows the expected shim dir');
  warn('    echo "$PATH"         # check if it is included');
  warn('');
  warn('  On Windows, scripts/diagnose-path.ps1 and scripts/fix-path.ps1');
  warn('  in the repo can inspect and repair PATH for you.');
  warn('==============================================================');
  process.exit(0); // Never fail the install.
} catch (err) {
  // Last-resort safety net: log and exit 0.
  warn(`unexpected error (install is not affected): ${err.message}`);
  process.exit(0);
}
