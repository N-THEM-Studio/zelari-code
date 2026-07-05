import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// stubs test
const stubsTest = path.join(root, 'tests/unit/cli-workspace-stubs.test.ts');
let st = fs.readFileSync(stubsTest, 'utf8');
st = st.replace(
  "expect(result).toContain('docs/risks.md');",
  "expect(result).toContain('risks.md (workspace root)');",
);
st = st.replace(
  "expect(existsSync(join(ctx.rootDir, 'docs', 'risks.md'))).toBe(true);",
  "expect(existsSync(join(ctx.rootDir, 'risks.md'))).toBe(true);\n    expect(existsSync(join(ctx.rootDir, 'docs', 'risks.md'))).toBe(false);",
);
fs.writeFileSync(stubsTest, st);

// council test
const councilTest = path.join(root, 'tests/unit/cli-council.test.ts');
let ct = fs.readFileSync(councilTest, 'utf8');
if (!ct.includes('defaults to full council')) {
  const insert = `
    it('defaults to full council (6) when councilSize is omitted (v0.7.9)', async () => {
      const seenMembers = new Set<string>();
      const stream: ProviderStreamFn = async function* () {
        yield { kind: 'text', delta: 'x' };
        yield { kind: 'finish', reason: 'stop' };
      };
      for await (const e of dispatchCouncil('hello', {
        apiKey: 'k',
        model: 'm',
        provider: 'openai-compatible',
        providerStream: stream,
        disableWorkspaceTools: true,
      })) {
        if (e.type === 'council_mode') {
          expect(e.councilSize).toBe(6);
          expect(e.tier).toBe('full');
        }
        if (e.type === 'agent_start') {
          const memberName = (e as BrainEvent & { memberName?: string }).memberName;
          if (memberName) seenMembers.add(memberName);
        }
      }
      expect(seenMembers.has('Minosse')).toBe(true);
      expect(seenMembers.has('Lucifero')).toBe(true);
    });`;
  ct = ct.replace(
    "      expect(seenMembers.has('Lucifero')).toBe(true);\n    });\n  });",
    `      expect(seenMembers.has('Lucifero')).toBe(true);\n    });${insert}\n  });`,
  );
  fs.writeFileSync(councilTest, ct);
}

console.log('tests patched');
