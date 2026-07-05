import { readFileSync, writeFileSync } from 'node:fs';

const p = 'packages/core/src/core/AgentHarness.ts';
let s = readFileSync(p, 'utf8');

const needle =
  '              try {\n                const result = await this.config.toolRegistry.invoke<unknown>(\n                  tt.name,\n                  normalizedArgs,';
const repl =
  '              try {\n                const normalizedArgs = normalizeTextToolArgs(tt.name, tt.args);\n                const result = await this.config.toolRegistry.invoke<unknown>(\n                  tt.name,\n                  normalizedArgs,';

if (s.includes(needle)) {
  s = s.replace(needle, repl);
} else if (s.includes('const normalizedArgs = normalizeTextToolArgs')) {
  console.log('normalizedArgs already defined');
} else {
  console.error('needle not found for normalizedArgs fix');
  process.exit(1);
}

if (!s.includes('text_tools_parse_failed')) {
  const loopNeedle =
    '            let executedAny = false;\n            for (const tt of parseTextToolCalls(turnText)) {';
  const loopRepl = `            const textTools = parseTextToolCalls(turnText);
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
              const tt = textTools[ti]!;`;
  if (!s.includes(loopNeedle)) {
    console.error('loop needle not found');
    process.exit(1);
  }
  s = s.replace(loopNeedle, loopRepl);
}

writeFileSync(p, s);
console.log('AgentHarness patched OK');
