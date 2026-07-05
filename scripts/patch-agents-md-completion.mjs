import { readFileSync, writeFileSync } from "node:fs";

const p = "tests/unit/cli-workspace-agents-md.test.ts";
let s = readFileSync(p, "utf8");

const old1 =
  "    const oldLessons = process.env['ZELARI_LESSONS'];\r\n" +
  "    process.env['ZELARI_AGENTS_MD'] = '0';\r\n" +
  "    process.env['ZELARI_VERIFY'] = '0';\r\n" +
  "    process.env['ZELARI_SMOKE'] = '0';\r\n" +
  "    process.env['ZELARI_LESSONS'] = '0';";

const neu1 =
  "    const oldLessons = process.env['ZELARI_LESSONS'];\r\n" +
  "    const oldCompletion = process.env['ZELARI_COMPLETION'];\r\n" +
  "    process.env['ZELARI_AGENTS_MD'] = '0';\r\n" +
  "    process.env['ZELARI_VERIFY'] = '0';\r\n" +
  "    process.env['ZELARI_SMOKE'] = '0';\r\n" +
  "    process.env['ZELARI_LESSONS'] = '0';\r\n" +
  "    process.env['ZELARI_COMPLETION'] = '0';";

const old2 =
  "      if (oldLessons === undefined) delete process.env['ZELARI_LESSONS'];\r\n" +
  "      else process.env['ZELARI_LESSONS'] = oldLessons;\r\n" +
  "    }";

const neu2 =
  "      if (oldLessons === undefined) delete process.env['ZELARI_LESSONS'];\r\n" +
  "      else process.env['ZELARI_LESSONS'] = oldLessons;\r\n" +
  "      if (oldCompletion === undefined) delete process.env['ZELARI_COMPLETION'];\r\n" +
  "      else process.env['ZELARI_COMPLETION'] = oldCompletion;\r\n" +
  "    }";

if (!s.includes(old1)) {
  console.error("anchor1 not found");
  process.exit(1);
}
if (!s.includes(old2)) {
  console.error("anchor2 not found");
  process.exit(1);
}

s = s.replace(old1, neu1).replace(old2, neu2);
writeFileSync(p, s);
console.log("patched", p);
