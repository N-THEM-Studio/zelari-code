import fs from "node:fs";

const p = new URL("../packages/core/src/agents/councilApi.ts", import.meta.url);
let t = fs.readFileSync(p, "utf8");
const orig = t;

function mustInclude(substr, label) {
  if (!t.includes(substr)) {
    console.error("MISSING after patch:", label, substr.slice(0, 60));
  }
}

if (!t.includes("runMode?: CouncilRunMode")) {
  t = t.replace(
    /  maxToolCallsPerTurn\?: number;\r?\n\}\r?\n\r?\nexport interface PureCouncilCallbacks/,
    `  maxToolCallsPerTurn?: number;
  /** Council run mode. Default: \`implementation\`. */
  runMode?: CouncilRunMode;
}

export interface PureCouncilCallbacks`,
  );
}

if (!t.includes("runMode: CouncilRunMode = 'implementation'")) {
  t = t.replace(
    /  executableTools\?: ReadonlySet<string> \| null,\r?\n\): AgentMessage\[\] \{/,
    `  executableTools?: ReadonlySet<string> | null,
  runMode: CouncilRunMode = 'implementation',
): AgentMessage[] {`,
  );
}

if (!t.includes("createBrainEvent('council_mode'")) {
  t = t.replace(
    /  const sessionId = config\.sessionId \?\? crypto\.randomUUID\(\);\r?\n\r?\n  \/\/ Emit council start/,
    `  const sessionId = config.sessionId ?? crypto.randomUUID();
  const runMode: CouncilRunMode = config.runMode ?? 'implementation';
  const isDesignPhase = runMode === 'design-phase';

  yield createBrainEvent('council_mode', sessionId, {
    tier: councilTierFromSize(config.councilSize),
    councilSize: config.councilSize,
    runMode,
  });

  // Emit council start`,
  );
}

t = t.replace(
  /if \(!errored && !NON_RETRY_AGENTS\.has\(agent\.id\)\)/g,
  "if (isDesignPhase && !errored && !NON_RETRY_AGENTS.has(agent.id))",
);

t = t.replace(
  /    \} else \{\r?\n      enforceDesignPhaseToolEmissions\(agent\.id, emittedToolNames\);\r?\n    \}\r?\n    const memberDuration = Date\.now\(\) - memberStart;\r?\n    emitMemberCost\(\{\r?\n      memberId: agent\.id,/,
  `    } else if (isDesignPhase) {
      enforceDesignPhaseToolEmissions(agent.id, emittedToolNames);
    }
    const memberDuration = Date.now() - memberStart;
    emitMemberCost({
      memberId: agent.id,`,
);

if (!t.includes("oracleToolNames = filterExecutable")) {
  t = t.replace(
    /      tools: \[\],\r?\n      eventBus: config\.eventBus,\r?\n      toolRegistry: config\.tools,\r?\n      \/\/ Task G\.2 — same per-turn limit applies to oracle\./,
    `      tools: (() => {
        const oracleToolNames = filterExecutable(
          Array.from(new Set([
            'createDocument',
            'searchDocuments',
            ...computeAgentTools(oracle, config.aiConfig),
          ])),
        );
        return oracleToolNames.length > 0
          ? getProviderTools(oracleToolNames).map((tool) => ({
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.parameters as Record<string, unknown>,
            }))
          : [];
      })(),
      eventBus: config.eventBus,
      toolRegistry: config.tools,
      // Task G.2 — same per-turn limit applies to oracle.`,
  );
}

t = t.replace(
  /    if \(!errored\) \{\r?\n      const oracleCheck = enforceDesignPhaseToolEmissions\(oracle\.id, emittedToolNames\);/,
  `    if (isDesignPhase && !errored) {
      const oracleCheck = enforceDesignPhaseToolEmissions(oracle.id, emittedToolNames);`,
);

t = t.replace(
  /    \} else \{\r?\n      enforceDesignPhaseToolEmissions\(oracle\.id, emittedToolNames\);\r?\n    \}\r?\n    const memberDuration = Date\.now\(\) - memberStart;\r?\n    emitMemberCost\(\{\r?\n      memberId: oracle\.id,/,
  `    } else if (isDesignPhase) {
      enforceDesignPhaseToolEmissions(oracle.id, emittedToolNames);
    }
    const memberDuration = Date.now() - memberStart;
    emitMemberCost({
      memberId: oracle.id,`,
);

t = t.replace(
  /    if \(!errored\) \{\r?\n      const chairmanCheck = enforceDesignPhaseToolEmissions\(chairman\.id, emittedToolNames\);/,
  `    if (isDesignPhase && !errored) {
      const chairmanCheck = enforceDesignPhaseToolEmissions(chairman.id, emittedToolNames);`,
);

t = t.replace(
  /    \} else \{\r?\n      enforceDesignPhaseToolEmissions\(chairman\.id, emittedToolNames\);\r?\n    \}\r?\n    const memberDuration = Date\.now\(\) - memberStart;\r?\n    \/\/ If the chairman errored/,
  `    } else if (isDesignPhase) {
      enforceDesignPhaseToolEmissions(chairman.id, emittedToolNames);
    }
    const memberDuration = Date.now() - memberStart;
    // If the chairman errored`,
);

if (!t.includes("pluton:")) {
  t = t.replace(
    /  geryon: \[\r?\n    \[\{ name: 'createDocument', min: 3 \}\],\r?\n  \],/,
    `  geryon: [
    [{ name: 'createDocument', min: 3 }],
  ],
  pluton: [
    [{ name: 'createDocument', min: 1 }],
  ],`,
  );
}

// runRetryTurnForMember
if (!t.includes("runMode?: CouncilRunMode;\n}): AsyncGenerator")) {
  t = t.replace(
    /  providerStream: ProviderStreamFn;\r?\n\}\): AsyncGenerator<BrainEvent, string\[\], void> \{/,
    `  providerStream: ProviderStreamFn;
  runMode?: CouncilRunMode;
}): AsyncGenerator<BrainEvent, string[], void> {`,
  );
}

t = t.replace(
  /    args\.aiConfig,\r?\n    args\.sessionId,/,
  `    args.aiConfig,
    args.runMode ?? 'implementation',
    args.sessionId,`,
);

// fix buildAgentMessages call in runRetryTurnForMember - the signature is different
// Read the actual call pattern
const retryCall = t.match(
  /const baseMessages = buildAgentMessages\([\s\S]*?\);/,
);
if (retryCall && !retryCall[0].includes("runMode")) {
  t = t.replace(
    /const baseMessages = buildAgentMessages\(\s*args\.agent,[\s\S]*?args\.executableTools,\s*\);/,
    (m) =>
      m.replace(
        "args.executableTools,",
        "args.executableTools,\n    args.runMode ?? 'implementation',",
      ),
  );
}

if (!t.includes("runMode: args.config.runMode")) {
  t = t.replace(
    /      providerStream: args\.config\.providerStream,\r?\n    \}\);/,
    `      providerStream: args.config.providerStream,
      runMode: args.config.runMode,
    });`,
  );
}

if (t === orig) {
  console.log("no changes");
} else {
  fs.writeFileSync(p, t);
  console.log("written", p.pathname);
}

mustInclude("runMode?: CouncilRunMode", "config");
mustInclude(
  "runMode: CouncilRunMode = 'implementation'",
  "buildAgentMessages param",
);
mustInclude("createBrainEvent('council_mode'", "event");
mustInclude("isDesignPhase", "gate");
mustInclude("oracleToolNames", "oracle tools");
mustInclude("pluton:", "pluton req");
