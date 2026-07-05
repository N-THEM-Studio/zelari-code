import { readFileSync, writeFileSync } from 'node:fs';

const p = 'packages/core/src/agents/councilApi.ts';
let s = readFileSync(p, 'utf8');

if (!s.includes("from 'node:fs'")) {
  s = s.replace(
    "import type { CouncilMessage, AgentRole } from '../types/index.js';",
    "import { existsSync } from 'node:fs';\nimport { join } from 'node:path';\nimport type { CouncilMessage, AgentRole } from '../types/index.js';",
  );
}

if (!s.includes('loadNfrSpec')) {
  s = s.replace(
    "import { warnIfNfrSpecMissing } from '../council/scope/nfrSpecWarn.js';",
    "import { warnIfNfrSpecMissing } from '../council/scope/nfrSpecWarn.js';\nimport { loadNfrSpec, DEFAULT_NFR_SPEC } from '../council/verification/runChecks.js';",
  );
}

const scanBlock = `      // Increment 4b: final scan on NFR targets even when ---TOOLS--- did not
      // execute (e.g. JSON parse failure) or no write triggered per-write micro-gate.
      if (chairmanProjectRoot) {
        const zelariRoot = \`\${chairmanProjectRoot}/.zelari\`;
        const spec = loadNfrSpec(zelariRoot) ?? DEFAULT_NFR_SPEC;
        for (const rel of spec.targets) {
          if (!existsSync(join(chairmanProjectRoot, rel))) continue;
          changedTargetFiles.add(rel);
          for (const w of runChairmanMicroGate({ projectRoot: chairmanProjectRoot, relPath: rel, zelariRoot })) {
            chairmanViolations.set(\`\${w.id}|\${w.file}|\${w.line ?? ''}\`, w);
          }
        }
      }
      if (chairmanViolations.size > 0 && chairmanProjectRoot) {`;

if (s.includes('Increment 4b: final scan')) {
  console.log('council final scan already patched');
} else {
  const old = `      if (chairmanViolations.size > 0 && chairmanProjectRoot) {`;
  if (!s.includes(old)) {
    console.error('fix loop anchor not found');
    process.exit(1);
  }
  s = s.replace(old, scanBlock);
}

// Ensure project root is set even without writes
const rootNeedle = `    let chairmanProjectRoot: string | null = null;
    const memberStart = Date.now();`;
const rootRepl = `    let chairmanProjectRoot: string | null = parseProjectRootFromWorkspaceContext(
      config.workspaceContext ?? '',
    );
    const memberStart = Date.now();`;
if (!s.includes('parseProjectRootFromWorkspaceContext(\n      config.workspaceContext')) {
  s = s.replace(rootNeedle, rootRepl);
}

writeFileSync(p, s);
console.log('councilApi patched OK');
