import { readFileSync, writeFileSync } from 'node:fs';

const p = 'packages/core/src/council/verification/runChecks.ts';
let s = readFileSync(p, 'utf8');
const start = s.indexOf('  for (const kw of keywords)');
const end = s.indexOf('  return results;\n}', start);
const block = `  for (const kw of keywords) {
    const low = kw.toLowerCase();
    if (!milestoneText.includes(low)) continue;
    let found = targetContent.includes(low);
    if (low.includes('print')) {
      found = found || targetContent.includes('@media print');
    }
    if (low.includes('theme')) {
      found = found || targetContent.includes('theme-toggle') || targetContent.includes('theme toggle');
    }
    if (low.includes('command') && low.includes('palette')) {
      found = found || targetContent.includes('command-palette') || targetContent.includes('commandpalette');
    }
    if (!found) {
      results.push({
        id: 'plan.reality',
        severity: 'warn',
        ok: false,
        file: targets[0],
        message: \`Milestone mentions "\${kw}" but target file(s) do not contain it (planned, not implemented)\`,
      });
    }
  }
`;
if (start < 0 || end < 0) {
  console.error('markers not found');
  process.exit(1);
}
s = s.slice(0, start) + block + s.slice(end);
writeFileSync(p, s);
console.log('ok');
