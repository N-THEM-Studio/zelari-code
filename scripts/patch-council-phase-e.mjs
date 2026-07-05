import { readFileSync, writeFileSync } from "node:fs";

const path = "packages/core/src/agents/councilApi.ts";
let s = readFileSync(path, "utf8");

const importAnchor =
  "} from '../council/verification/completion.js';\r\n";
const importAdd =
  "} from '../council/verification/completion.js';\r\n" +
  "import { warnIfNfrSpecMissing } from '../council/scope/nfrSpecWarn.js';\r\n";

if (!s.includes(importAdd)) {
  if (!s.includes(importAnchor)) {
    console.error("import anchor not found");
    process.exit(1);
  }
  s = s.replace(importAnchor, importAdd);
}

const warnAnchor =
  "    } else if (isDesignPhase) {\r\n" +
  "      enforceDesignPhaseToolEmissions(agent.id, emittedToolNames);\r\n" +
  "    }\r\n" +
  "    const memberDuration = Date.now() - memberStart;\r\n" +
  "    emitMemberCost({\r\n" +
  "      memberId: agent.id,\r\n";

const warnAdd =
  "    } else if (isDesignPhase) {\r\n" +
  "      enforceDesignPhaseToolEmissions(agent.id, emittedToolNames);\r\n" +
  "    }\r\n" +
  "    if (isDesignPhase) {\r\n" +
  "      warnIfNfrSpecMissing(agent.id, userMessage, emittedToolNames);\r\n" +
  "    }\r\n" +
  "    const memberDuration = Date.now() - memberStart;\r\n" +
  "    emitMemberCost({\r\n" +
  "      memberId: agent.id,\r\n";

if (!s.includes("warnIfNfrSpecMissing(agent.id, userMessage")) {
  if (!s.includes(warnAnchor)) {
    console.error("warn anchor not found");
    process.exit(1);
  }
  s = s.replace(warnAnchor, warnAdd);
}

writeFileSync(path, s);
console.log("patched", path);
