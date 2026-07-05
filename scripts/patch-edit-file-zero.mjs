import { readFileSync, writeFileSync } from 'node:fs';

const p = 'packages/core/src/core/tools/builtin/filesystem.ts';
let s = readFileSync(p, 'utf8');

const old = `      if (occurrences > 0) {
        await fs.writeFile(absPath, newContent, { encoding: 'utf-8', signal: ctx.signal } as never);
      }
      return typedOk({ path: absPath, occurrencesReplaced: occurrences });`;

const neu = `      if (occurrences === 0) {
        return typedErr(
          \`edit_file: no match for oldString in \${args.path}. \` +
            'Use read_file to copy the exact text (whitespace included) and retry.',
        );
      }
      await fs.writeFile(absPath, newContent, { encoding: 'utf-8', signal: ctx.signal } as never);
      return typedOk({ path: absPath, occurrencesReplaced: occurrences });`;

if (s.includes('occurrences === 0')) {
  console.log('filesystem already patched');
} else if (s.includes(old)) {
  s = s.replace(old, neu);
  writeFileSync(p, s);
  console.log('filesystem patched OK');
} else {
  console.error('filesystem needle not found');
  process.exit(1);
}
