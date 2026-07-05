import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/cli/hooks/useChatTurn.ts';
let s = readFileSync(path, 'utf8');
const nl = s.includes('\r\n') ? '\r\n' : '\n';

if (!s.includes('let chairmanErrored')) {
  s = s.replace(
    `  let councilAborted = false;${nl}  let councilRunMode:`,
    `  let councilAborted = false;${nl}  let chairmanErrored = false;${nl}  let luciferWriteCount = 0;${nl}  let councilRunMode:`,
  );
}

if (!s.includes('luciferWriteCount++')) {
  s = s.replace(
    `      } else if (event.type === "tool_execution_start") {${nl}        // Drain buffered deltas first`,
    `      } else if (event.type === "tool_execution_start") {${nl}        if (${nl}          (event.memberId === "lucifer" || event.memberName === "Lucifero") &&${nl}          (event.toolName === "write_file" || event.toolName === "edit_file")${nl}        ) {${nl}          luciferWriteCount++;${nl}        }${nl}        // Drain buffered deltas first`,
  );
}

const badEnd =
  `      } else if (event.type === "message_end") {${nl}        // Member/turn boundary: drain buffered deltas and seal the bubble so${nl}        // the next streamed message starts fresh.${nl}        flushStreaming();${nl}        if (useLiveModel) finalizeStreaming(setMessages, setLive!);${nl}        else finalizeStreamingAssistant(setMessages);${nl}        streamContent = "";${nl}        streamMemberId = null;${nl}        membersCompleted++;${nl}        // Chairman is the last member; any assistant content from it counts.${nl}        if (event.memberId === "lucifer" || event.memberName === "Lucifero") {${nl}          chairmanProducedOutput = true;${nl}          chairmanSynthesisText = streamContent;${nl}        }`;

const goodEnd =
  `      } else if (event.type === "message_end") {${nl}        // Member/turn boundary: drain buffered deltas and seal the bubble so${nl}        // the next streamed message starts fresh.${nl}        if (event.memberId === "lucifer" || event.memberName === "Lucifero") {${nl}          if (streamContent.trim()) {${nl}            chairmanProducedOutput = true;${nl}            chairmanSynthesisText = streamContent;${nl}          }${nl}        }${nl}        flushStreaming();${nl}        if (useLiveModel) finalizeStreaming(setMessages, setLive!);${nl}        else finalizeStreamingAssistant(setMessages);${nl}        streamContent = "";${nl}        streamMemberId = null;${nl}        membersCompleted++;`;

if (s.includes(badEnd)) {
  s = s.replace(badEnd, goodEnd);
}

writeFileSync(path, s);
console.log('fixed useChatTurn');
