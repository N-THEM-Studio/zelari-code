import { readFileSync, writeFileSync } from 'node:fs';

const path = 'tests/unit/cli-workspace-agents-md.test.ts';
let s = readFileSync(path, 'utf8');

const old =
  "  it('respects ZELARI_AGENTS_MD=0', async () => {\r\n" +
  "    const old = process.env['ZELARI_AGENTS_MD'];\r\n" +
  "    process.env['ZELARI_AGENTS_MD'] = '0';\r\n" +
  '    try {\r\n' +
  '      const result = await runPostCouncilHook(ctx);\r\n' +
  '      expect(result.ran).toBe(false);\r\n' +
  "      expect(result.reason).toContain('disabled');\r\n" +
  '    } finally {\r\n' +
  "      if (old === undefined) delete process.env['ZELARI_AGENTS_MD'];\r\n" +
  "      else process.env['ZELARI_AGENTS_MD'] = old;\r\n" +
  '    }\r\n' +
  '  });';

const neu =
  "  it('respects ZELARI_AGENTS_MD=0', async () => {\r\n" +
  "    const oldAgents = process.env['ZELARI_AGENTS_MD'];\r\n" +
  "    const oldVerify = process.env['ZELARI_VERIFY'];\r\n" +
  "    process.env['ZELARI_AGENTS_MD'] = '0';\r\n" +
  "    process.env['ZELARI_VERIFY'] = '0';\r\n" +
  '    try {\r\n' +
  '      const result = await runPostCouncilHook(ctx);\r\n' +
  '      expect(result.ran).toBe(false);\r\n' +
  '      expect(result.changed).toBe(false);\r\n' +
  "      expect(result.reason).toContain('disabled');\r\n" +
  '    } finally {\r\n' +
  "      if (oldAgents === undefined) delete process.env['ZELARI_AGENTS_MD'];\r\n" +
  "      else process.env['ZELARI_AGENTS_MD'] = oldAgents;\r\n" +
  "      if (oldVerify === undefined) delete process.env['ZELARI_VERIFY'];\r\n" +
  "      else process.env['ZELARI_VERIFY'] = oldVerify;\r\n" +
  '    }\r\n' +
  '  });';

if (!s.includes(old)) {
  console.error('anchor not found');
  process.exit(1);
}
s = s.replace(old, neu);
writeFileSync(path, s);
console.log('patched agents-md test');
