import { readFileSync, writeFileSync } from "node:fs";

const headless = "src/cli/headless.ts";
let s = readFileSync(headless, "utf8");
const old =
  "  const { getCustomEndpoint } = await import('./providerConfig.js');\r\n" +
  "  const customBase = getCustomEndpoint(providerId as never);\r\n" +
  "  return {\r\n" +
  "    apiKey: resolved.apiKey,\r\n" +
  "    ...(customBase ? { baseUrl: customBase } : {}),\r\n" +
  "  };";
const neu =
  "  const { resolveBaseUrl } = await import('./provider/openai-compatible.js');\r\n" +
  "  return {\r\n" +
  "    apiKey: resolved.apiKey,\r\n" +
  "    baseUrl: resolveBaseUrl(providerId as never),\r\n" +
  "  };";
if (!s.includes(old)) {
  console.error("headless anchor not found");
  process.exit(1);
}
s = s.replace(old, neu);
writeFileSync(headless, s);

const runHeadless = "src/cli/runHeadless.ts";
let r = readFileSync(runHeadless, "utf8");
const old2 =
  "  const providerStream = openaiCompatibleProvider({\r\n" +
  "    providerId: provider as 'minimax' | 'glm' | 'grok' | 'openai-compatible' | 'custom',\r\n" +
  "    apiKey: key.apiKey,\r\n" +
  "    model,\r\n" +
  "    ...(key.baseUrl ? { baseUrl: key.baseUrl } : {}),\r\n" +
  "  } as Parameters<typeof openaiCompatibleProvider>[0]);";
const neu2 =
  "  const providerStream = openaiCompatibleProvider({\r\n" +
  "    providerId: provider as 'minimax' | 'glm' | 'grok' | 'openai-compatible' | 'custom',\r\n" +
  "    apiKey: key.apiKey,\r\n" +
  "    baseUrl: key.baseUrl,\r\n" +
  "    model,\r\n" +
  "  });";
if (!r.includes(old2)) {
  console.error("runHeadless anchor not found");
  process.exit(1);
}
r = r.replace(old2, neu2);
writeFileSync(runHeadless, r);
console.log("patched headless baseUrl resolution");
