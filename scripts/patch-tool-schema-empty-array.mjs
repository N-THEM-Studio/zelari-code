import { readFileSync, writeFileSync } from "node:fs";

const p = "packages/core/src/agents/toolSchemas.ts";
let s = readFileSync(p, "utf8");

const old =
  "    const customParams = (t as { parameters?: unknown }).parameters;\r\n" +
  "    const parameters =\r\n" +
  "      builtinSchema ||\r\n" +
  "      (customParams ? (customParams as object) : null) ||\r\n" +
  "      (Array.isArray((t as { parameters?: unknown[] }).parameters)\r\n" +
  "        ? null\r\n" +
  "        : null);";

const neu =
  "    const customParams = (t as { parameters?: unknown }).parameters;\r\n" +
  "    const parameters =\r\n" +
  "      builtinSchema ||\r\n" +
  "      (customParams &&\r\n" +
  "      typeof customParams === \"object\" &&\r\n" +
  "      !Array.isArray(customParams)\r\n" +
  "        ? (customParams as object)\r\n" +
  "        : null);";

if (!s.includes(old)) {
  console.error("anchor not found in toolSchemas.ts");
  process.exit(1);
}
writeFileSync(p, s.replace(old, neu));
console.log("patched toolSchemas.ts");
