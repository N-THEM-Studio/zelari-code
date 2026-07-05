import { readFileSync, writeFileSync } from "node:fs";

const path = "packages/core/src/agents/councilApi.ts";
let s = readFileSync(path, "utf8");

if (s.includes("pendingChairmanWrites")) {
  console.log("already patched");
  process.exit(0);
}

const anchor =
  "    // the synthesis; see enforceDesignPhaseToolEmissions).\r\n" +
  "    const emittedToolNames: string[] = [];\r\n" +
  "    const memberStart = Date.now();\r\n" +
  "    try {\r\n" +
  "      for await (const event of chairmanHarness.run()) {\r\n" +
  "        yield event;\r\n" +
  "        if (event.type === 'tool_execution_start') {\r\n" +
  "          toolCalls += 1;\r\n" +
  "          emittedToolNames.push(event.toolName);\r\n" +
  "        }\r\n" +
  "        if (event.type === 'message_end' && event.usage) {";

const replacement =
  "    // the synthesis; see enforceDesignPhaseToolEmissions).\r\n" +
  "    const emittedToolNames: string[] = [];\r\n" +
  "    const pendingChairmanWrites = new Map<string, string>();\r\n" +
  "    const memberStart = Date.now();\r\n" +
  "    try {\r\n" +
  "      for await (const event of chairmanHarness.run()) {\r\n" +
  "        yield event;\r\n" +
  "        if (event.type === 'tool_execution_start') {\r\n" +
  "          toolCalls += 1;\r\n" +
  "          emittedToolNames.push(event.toolName);\r\n" +
  "          if (\r\n" +
  "            !isDesignPhase &&\r\n" +
  "            (event.toolName === 'write_file' || event.toolName === 'edit_file') &&\r\n" +
  "            typeof event.args.path === 'string'\r\n" +
  "          ) {\r\n" +
  "            pendingChairmanWrites.set(event.toolCallId, event.args.path);\r\n" +
  "          }\r\n" +
  "        }\r\n" +
  "        if (\r\n" +
  "          !isDesignPhase &&\r\n" +
  "          event.type === 'tool_execution_end' &&\r\n" +
  "          !event.isError\r\n" +
  "        ) {\r\n" +
  "          const relPath = pendingChairmanWrites.get(event.toolCallId);\r\n" +
  "          if (relPath) {\r\n" +
  "            pendingChairmanWrites.delete(event.toolCallId);\r\n" +
  "            const projectRoot = parseProjectRootFromWorkspaceContext(config.workspaceContext);\r\n" +
  "            if (projectRoot) {\r\n" +
  "              const warnings = runChairmanMicroGate({\r\n" +
  "                projectRoot,\r\n" +
  "                relPath,\r\n" +
  "                zelariRoot: `${projectRoot}/.zelari`,\r\n" +
  "              });\r\n" +
  "              for (const w of warnings) {\r\n" +
  "                const loc = w.line ? `${w.file}:L${w.line}` : w.file;\r\n" +
  "                const msg = `[verify-warn] ${w.id}: ${w.message} (${loc})`;\r\n" +
  "                // eslint-disable-next-line no-console\r\n" +
  "                console.warn(msg);\r\n" +
  "                yield createBrainEvent('error', sessionId, {\r\n" +
  "                  severity: 'recoverable',\r\n" +
  "                  message: msg,\r\n" +
  "                  code: 'verification_warn',\r\n" +
  "                });\r\n" +
  "              }\r\n" +
  "            }\r\n" +
  "          }\r\n" +
  "        }\r\n" +
  "        if (event.type === 'message_end' && event.usage) {";

if (!s.includes(anchor)) {
  console.error("anchor not found");
  process.exit(1);
}

s = s.replace(anchor, replacement);
writeFileSync(path, s);
console.log("patched councilApi micro-gate");
