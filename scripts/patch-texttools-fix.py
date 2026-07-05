from pathlib import Path

# AgentHarness
p = Path("packages/core/src/core/AgentHarness.ts")
s = p.read_text(encoding="utf-8")
old = (
    "              try:\n"
    "                const result = await this.config.toolRegistry.invoke<unknown>(\n"
    "                  tt.name,\n"
    "                  normalizedArgs,"
)
# TypeScript not Python - fix the old string
old = """              try {
                const result = await this.config.toolRegistry.invoke<unknown>(
                  tt.name,
                  normalizedArgs,"""
new = """              try {
                const normalizedArgs = normalizeTextToolArgs(tt.name, tt.args);
                const result = await this.config.toolRegistry.invoke<unknown>(
                  tt.name,
                  normalizedArgs,"""
if old in s:
    s = s.replace(old, new, 1)
    print("fixed normalizedArgs")
elif "const normalizedArgs = normalizeTextToolArgs" in s:
    print("normalizedArgs already ok")
else:
    raise SystemExit("normalizedArgs needle missing")

if "text_tools_parse_failed" not in s:
    loop_old = """            let executedAny = false;
            for (const tt of parseTextToolCalls(turnText)) {"""
    loop_new = """            const textTools = parseTextToolCalls(turnText);
            if (/---TOOLS---/.test(turnText) && textTools.length === 0) {
              const parseErr = createBrainEvent('error', this.sessionId, {
                severity: 'recoverable',
                message:
                  'Found ---TOOLS--- block but JSON parse failed; tool calls were not executed. ' +
                  'Emit valid JSON (escape newlines as \\\\n inside strings).',
                code: 'text_tools_parse_failed',
              });
              this.emit(parseErr);
              yield parseErr;
            }
            let executedAny = false;
            for (let ti = 0; ti < textTools.length; ti++) {
              const tt = textTools[ti]!;"""
    if loop_old not in s:
        raise SystemExit("loop needle missing")
    s = s.replace(loop_old, loop_new, 1)
    print("added parse failure + textTools loop")
else:
    print("parse failure already present")

p.write_text(s, encoding="utf-8", newline="\n")

# filesystem
fp = Path("packages/core/src/core/tools/builtin/filesystem.ts")
fs = fp.read_text(encoding="utf-8")
if "occurrences === 0" not in fs:
    fs_old = """      if (occurrences > 0) {
        await fs.writeFile(absPath, newContent, { encoding: 'utf-8', signal: ctx.signal } as never);
      }
      return typedOk({ path: absPath, occurrencesReplaced: occurrences });"""
    fs_new = """      if (occurrences === 0) {
        return typedErr(
          `edit_file: no match for oldString in ${args.path}. ` +
            'Use read_file to copy the exact text (whitespace included) and retry.',
        );
      }
      await fs.writeFile(absPath, newContent, { encoding: 'utf-8', signal: ctx.signal } as never);
      return typedOk({ path: absPath, occurrencesReplaced: occurrences });"""
    if fs_old not in fs:
        raise SystemExit("filesystem needle missing")
    fs = fs.replace(fs_old, fs_new, 1)
    fp.write_text(fs, encoding="utf-8", newline="\n")
    print("filesystem patched")
else:
    print("filesystem already patched")

# councilApi
cp = Path("packages/core/src/agents/councilApi.ts")
cs = cp.read_text(encoding="utf-8")
if "from 'node:fs'" not in cs and 'existsSync' not in cs:
    cs = cs.replace(
        "import type { CouncilMessage, AgentRole } from '../types/index.js';",
        "import { existsSync } from 'node:fs';\nimport { join } from 'node:path';\nimport type { CouncilMessage, AgentRole } from '../types/index.js';",
    )
if "loadNfrSpec" not in cs:
    cs = cs.replace(
        "import { warnIfNfrSpecMissing } from '../council/scope/nfrSpecWarn.js';",
        "import { warnIfNfrSpecMissing } from '../council/scope/nfrSpecWarn.js';\nimport { loadNfrSpec, DEFAULT_NFR_SPEC } from '../council/verification/runChecks.js';",
    )
root_old = """    let chairmanProjectRoot: string | null = null;
    const memberStart = Date.now();"""
root_new = """    let chairmanProjectRoot: string | null = parseProjectRootFromWorkspaceContext(
      config.workspaceContext ?? '',
    );
    const memberStart = Date.now();"""
if "config.workspaceContext ?? ''" not in cs:
    cs = cs.replace(root_old, root_new, 1)
    print("chairmanProjectRoot preset")

if "Increment 4b: final scan" not in cs:
    scan_old = "      if (chairmanViolations.size > 0 && chairmanProjectRoot) {"
    scan_new = """      // Increment 4b: final scan on NFR targets even when ---TOOLS--- did not
      // execute (e.g. JSON parse failure) or no write triggered per-write micro-gate.
      if (chairmanProjectRoot) {
        const zelariRoot = `${chairmanProjectRoot}/.zelari`;
        const spec = loadNfrSpec(zelariRoot) ?? DEFAULT_NFR_SPEC;
        for (const rel of spec.targets) {
          if (!existsSync(join(chairmanProjectRoot, rel))) continue;
          changedTargetFiles.add(rel);
          for (const w of runChairmanMicroGate({ projectRoot: chairmanProjectRoot, relPath: rel, zelariRoot })) {
            chairmanViolations.set(`${w.id}|${w.file}|${w.line ?? ''}`, w);
          }
        }
      }
      if (chairmanViolations.size > 0 && chairmanProjectRoot) {"""
    if scan_old not in cs:
        raise SystemExit("council scan anchor missing")
    cs = cs.replace(scan_old, scan_new, 1)
    print("council final scan added")
else:
    print("council final scan already present")

cp.write_text(cs, encoding="utf-8", newline="\n")
print("all done")
