#!/usr/bin/env node
/**
 * verify-os-jail.mjs — mechanical gate for the t28 (Pilastro A) choke-point.
 *
 * HARNESS-10 DoD (d): the gate FAILS when src/cli/tools/execProcess.ts or the
 * CLI bash path (src/cli/toolRegistry.ts) introduce a RAW child_process spawn
 * that bypasses safety/osJail.spawnJailed. The only file on those two paths
 * allowed to touch child_process is src/cli/safety/osJail.ts itself (the
 * choke-point); the jails/* backends only build argv/profiles and never spawn.
 * packages/core/.../shell.ts keeps its default direct spawn for the core
 * harness host — the CLI replaces it with the osJail seam (checked here).
 *
 * Exit 0 when every hard check passes; exit 1 otherwise.
 * Run directly (`node scripts/verify-os-jail.mjs`) or import
 * runVerifyOsJail() from tests/unit/verify-os-jail.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The ONLY CLI file allowed to import/own the raw spawn (the choke-point). */
const CHOKE_POINT = ['src', 'cli', 'safety', 'osJail.ts'];

function readText(root, rel) {
  try {
    return fs.readFileSync(path.join(root, ...rel), 'utf8');
  } catch {
    return null;
  }
}

/** Raw-spawn signature: the module import or a spawn(...) call — never `spawnJailed(`. */
const RAW_SPAWN_PATTERNS = [
  { re: /from\s+['"]node:child_process['"]/, why: 'child_process import' },
  { re: /require\(['"]child_process['"]\)/, why: 'child_process require' },
  { re: /\bspawn\s*\(/, why: 'spawn( call' },
];

/**
 * Drop whole COMMENT lines (//, leading JSDoc `*`, /* openers) before pattern
 * matching — prose like "any spawn (golden rule)" must not trip the gate,
 * while inline `code // comment` lines keep their code half checked.
 */
function stripCommentLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

function rawSpawnHits(text) {
  const code = stripCommentLines(text);
  const hits = [];
  for (const { re, why } of RAW_SPAWN_PATTERNS) {
    if (re.test(code)) hits.push(why);
  }
  return hits;
}

/**
 * Run every check. Returns { ok, errors, warnings }.
 * @param {string} root repo root (defaults to the monorepo root)
 * @param {{ok:Function,error:Function,warn:Function}} [report]
 */
export function runVerifyOsJail(root = REPO_ROOT, report = { ok() {}, error() {}, warn() {} }) {
  const errors = [];
  const warnings = [];
  const sink = {
    ok: (check, msg) => report.ok?.(check, msg),
    error: (check, msg) => {
      errors.push({ check, msg });
      report.error?.(check, msg);
    },
    warn: (check, msg) => {
      warnings.push({ check, msg });
      report.warn?.(check, msg);
    },
  };

  // 1. exec_process goes through the choke-point, no raw spawn on its path.
  const execSrc = readText(root, ['src', 'cli', 'tools', 'execProcess.ts']);
  if (execSrc === null) {
    sink.error('exec-choke-point', 'src/cli/tools/execProcess.ts is missing');
  } else {
    const hits = rawSpawnHits(execSrc);
    if (hits.length > 0) {
      sink.error('exec-choke-point', `src/cli/tools/execProcess.ts has raw spawn (${hits.join(', ')}) — must route through safety/osJail.spawnJailed`);
    } else if (!execSrc.includes('spawnJailed(')) {
      sink.error('exec-choke-point', 'src/cli/tools/execProcess.ts does not call spawnJailed(');
    } else {
      sink.ok('exec-choke-point', 'exec_process spawns only via spawnJailed');
    }
  }

  // 2. The CLI bash path (toolRegistry) has no raw spawn and wires the seam.
  const registrySrc = readText(root, ['src', 'cli', 'toolRegistry.ts']);
  if (registrySrc === null) {
    sink.error('bash-seam', 'src/cli/toolRegistry.ts is missing');
  } else {
    const hits = rawSpawnHits(registrySrc);
    if (hits.length > 0) {
      sink.error('bash-seam', `src/cli/toolRegistry.ts has raw spawn (${hits.join(', ')}) — bash must spawn via the createBashTool seam`);
    } else if (!registrySrc.includes('createBashTool(') || !registrySrc.includes('spawnJailed(')) {
      sink.error('bash-seam', 'src/cli/toolRegistry.ts must build bash with createBashTool(<spawnJailed seam>)');
    } else {
      sink.ok('bash-seam', 'CLI bash spawns only via the createBashTool spawnJailed seam');
    }
    if (!registrySrc.includes('wrapWithShellSafety(')) {
      sink.error('bash-seam', 'src/cli/toolRegistry.ts lost the wrapWithShellSafety bash wrapper');
    }
  }

  // 3. osJail.ts exists and owns the single CLI spawn.
  const osJailSrc = readText(root, CHOKE_POINT);
  if (osJailSrc === null) {
    sink.error('choke-point-owner', 'src/cli/safety/osJail.ts is missing');
  } else {
    const owns = /from\s+['"]node:child_process['"]/.test(osJailSrc) && /\bspawn\s*\(/.test(osJailSrc);
    if (!owns) sink.error('choke-point-owner', 'src/cli/safety/osJail.ts no longer owns the raw spawn (spawnJailed broken)');
    else sink.ok('choke-point-owner', 'osJail.ts is the single CLI spawn owner');
    for (const fn of ['resolveJailMode', 'buildJailSpec', 'decideJailSpawn', 'spawnJailed', 'setJailBackendForTests']) {
      if (!osJailSrc.includes(`function ${fn}`) && !osJailSrc.includes(`export function ${fn}`)) {
        sink.error('choke-point-owner', `src/cli/safety/osJail.ts is missing export ${fn}`);
      }
    }
    if (!osJailSrc.includes('ZELARI_OS_JAIL')) {
      sink.error('choke-point-owner', 'osJail.ts no longer resolves ZELARI_OS_JAIL');
    }
  }

  // 4. The three platform backends exist and never spawn themselves.
  for (const [name, expectProbe] of [
    ['darwin.ts', 'sandbox-exec'],
    ['linux.ts', 'bwrap'],
    ['win32.ts', 'restricted-token'],
  ]) {
    const src = readText(root, ['src', 'cli', 'safety', 'jails', name]);
    if (src === null) {
      sink.error('jails', `src/cli/safety/jails/${name} is missing`);
      continue;
    }
    const hits = rawSpawnHits(src);
    if (hits.length > 0) {
      sink.error('jails', `src/cli/safety/jails/${name} spawns (${hits.join(', ')}) — backends only wrap argv/profiles`);
    }
    if (!src.includes(expectProbe)) {
      sink.error('jails', `src/cli/safety/jails/${name} lost its ${expectProbe} implementation/probe`);
    }
  }

  // 5. The honest-unavailable posture of the win32 backend must survive.
  const win32Src = readText(root, ['src', 'cli', 'safety', 'jails', 'win32.ts']);
  if (win32Src !== null && !/available:\s*false/.test(win32Src)) {
    sink.error('jails', 'win32 backend must keep the honest available:false probe (no fake containment)');
  }

  return { ok: errors.length === 0, errors, warnings };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const result = runVerifyOsJail(REPO_ROOT, {
    ok: (check, msg) => console.log('  ✓ [' + check + '] ' + msg),
    error: (check, msg) => console.error('  ✗ [' + check + '] ' + msg),
    warn: (check, msg) => console.warn('  ⚠ [' + check + '] ' + msg),
  });
  console.log('');
  console.log(
    '[verify-os-jail] ' +
      (result.ok ? 'PASS' : 'FAIL') +
      ' — errors: ' + result.errors.length +
      ', warnings: ' + result.warnings.length,
  );
  process.exit(result.ok ? 0 : 1);
}
