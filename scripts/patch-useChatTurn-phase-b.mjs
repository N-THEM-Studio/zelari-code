import { readFileSync, writeFileSync } from "node:fs";

const path = "src/cli/hooks/useChatTurn.ts";
let s = readFileSync(path, "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";

function rep(anchor, replacement, label) {
  if (s.includes(replacement.split(nl)[0] ?? "")) {
    console.log(`skip ${label} (already)`);
    return;
  }
  if (!s.includes(anchor)) {
    console.error(`missing anchor: ${label}`);
    process.exit(1);
  }
  s = s.replace(anchor, replacement);
  console.log(`ok ${label}`);
}

rep(
  `  let councilAborted = false;${nl}  let councilRunMode: "implementation" | "design-phase" = "implementation";`,
  `  let councilAborted = false;${nl}  let chairmanErrored = false;${nl}  let luciferWriteCount = 0;${nl}  let councilRunMode: "implementation" | "design-phase" = "implementation";`,
  "vars",
);

rep(
  `      } else if (event.type === "tool_execution_start") {${nl}        // Drain buffered deltas first so ordering matches reality, and seal${nl}        // the pre-tool bubble (complete once the member starts calling tools).`,
  `      } else if (event.type === "tool_execution_start") {${nl}        if (${nl}          (event.memberId === "lucifer" || event.memberName === "Lucifero") &&${nl}          (event.toolName === "write_file" || event.toolName === "edit_file")${nl}        ) {${nl}          luciferWriteCount++;${nl}        }${nl}        // Drain buffered deltas first so ordering matches reality, and seal${nl}        // the pre-tool bubble (complete once the member starts calling tools).`,
  "tool",
);

rep(
  `      } else if (event.type === "error") {${nl}        flushStreaming();`,
  `      } else if (event.type === "member_cost") {${nl}        if (event.cost.memberId === "lucifer" && event.cost.errored) {${nl}          chairmanErrored = true;${nl}        }${nl}      } else if (event.type === "error") {${nl}        if (event.memberId === "lucifer" || event.memberName === "Lucifero") {${nl}          chairmanErrored = true;${nl}        }${nl}        flushStreaming();`,
  "error",
);

rep(
  `      } else if (event.type === "message_end") {${nl}        // Member/turn boundary: drain buffered deltas and seal the bubble so${nl}        // the next streamed message starts fresh.${nl}        flushStreaming();${nl}        if (useLiveModel) finalizeStreaming(setMessages, setLive!);${nl}        else finalizeStreamingAssistant(setMessages);${nl}        streamContent = "";${nl}        streamMemberId = null;${nl}        membersCompleted++;${nl}        // Chairman is the last member; any assistant content from it counts.${nl}        if (event.memberId === "lucifer" || event.memberName === "Lucifero") {${nl}          chairmanProducedOutput = true;${nl}          chairmanSynthesisText = streamContent;${nl}        }`,
  `      } else if (event.type === "message_end") {${nl}        // Member/turn boundary: drain buffered deltas and seal the bubble so${nl}        // the next streamed message starts fresh.${nl}        if (event.memberId === "lucifer" || event.memberName === "Lucifero") {${nl}          if (streamContent.trim()) {${nl}            chairmanProducedOutput = true;${nl}            chairmanSynthesisText = streamContent;${nl}          }${nl}        }${nl}        flushStreaming();${nl}        if (useLiveModel) finalizeStreaming(setMessages, setLive!);${nl}        else finalizeStreamingAssistant(setMessages);${nl}        streamContent = "";${nl}        streamMemberId = null;${nl}        membersCompleted++;`,
  "message_end",
);

rep(
  `        const hook = await runPostCouncilHook(workspaceCtx, {${nl}          runMode: councilRunMode,${nl}          synthesisText: chairmanSynthesisText || undefined,${nl}        });`,
  `        const { detectDegradedRun } = await import("@zelari/core/council");${nl}        const degraded = detectDegradedRun({${nl}          chairmanErrored,${nl}          councilAborted,${nl}          luciferWriteCount,${nl}          synthesisText: chairmanSynthesisText,${nl}          runMode: councilRunMode,${nl}        });${nl}        if (degraded.degraded) {${nl}          appendSystem(${nl}            setMessages,${nl}            \`[council] DEGRADED_RUN — \${degraded.reasons.join("; ")}. Do not treat as verified hand-off.\`,${nl}            Date.now(),${nl}          );${nl}        }${nl}        const hook = await runPostCouncilHook(workspaceCtx, {${nl}          runMode: councilRunMode,${nl}          synthesisText: chairmanSynthesisText || undefined,${nl}          degradedRun: degraded.degraded,${nl}          degradedReasons: degraded.reasons,${nl}        });`,
  "hook",
);

rep(
  `        if (hook.verification?.ran) {${nl}          const v = hook.verification;${nl}          if (v.ok) {`,
  `        if (hook.autofix?.ran && hook.autofix.applied) {${nl}          appendSystem(${nl}            setMessages,${nl}            \`[verify-autofix] applied to \${hook.autofix.filesChanged?.join(", ") ?? "targets"}\`,${nl}            Date.now(),${nl}          );${nl}        }${nl}        if (hook.verification?.ran) {${nl}          const v = hook.verification;${nl}          if (degraded.degraded) {${nl}            appendSystem(${nl}              setMessages,${nl}              \`[verify] SKIPPED — degraded run (see DEGRADED_RUN above)\`,${nl}              Date.now(),${nl}            );${nl}          } else if (v.ok) {`,
  "verify",
);

writeFileSync(path, s);
console.log("patched useChatTurn phase B");
