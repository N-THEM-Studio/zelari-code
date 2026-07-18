/**
 * Defense-in-depth scrubber for assistant prose in the desktop UI.
 *
 * Streaming vs final:
 * - While streaming we only remove *closed* tool/think blocks. Using
 *   `/<tool_call>[\s\S]*$/` mid-stream deletes every character after an
 *   unclosed open tag — including real prose the model streams later —
 *   which looks like the run "stopped early".
 * - On final (message_end / display of finished bubble) we also drop trailing
 *   unclosed tool/think scaffolding at the end of the text.
 */

export type ScrubOpts = {
  /** When true, do not strip unclosed tags to end-of-string. */
  streaming?: boolean;
};

function stripClosedBlocks(text: string): string {
  let out = text;
  out = out
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<\/think(?:ing)?>/gi, "")
    .replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/gi, "")
    .replace(/<\/?minimax:tool_call>/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<\/?tool_call>/gi, "")
    .replace(/<function_call>[\s\S]*?<\/function_call>/gi, "")
    .replace(/<\/?function_call>/gi, "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
    .replace(/<\/invoke>/gi, "")
    .replace(/<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi, "")
    .replace(/<\/parameter>/gi, "");
  // NOTE: do NOT strip ---QUESTION--- here. Desktop renders those as an
  // interactive ClarificationCard (choices). Stripping them made questions
  // invisible ("---QUESTION" flash then gone / never shown).
  // Closed garbled minimax channel blobs (bounded)
  out = out.replace(
    /\]\s*<\]\s*minimax\s*\[>\s*\[?<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi,
    "",
  );
  return out;
}

/** Remove trailing unclosed private channels (safe only when the turn is done). */
function stripTrailingOpen(text: string): string {
  let out = text;
  out = out
    .replace(/<think(?:ing)?>[\s\S]*$/gi, "")
    .replace(/<minimax:tool_call>[\s\S]*$/gi, "")
    .replace(/<tool_call>[\s\S]*$/gi, "")
    .replace(/<function_call>[\s\S]*$/gi, "")
    .replace(/<invoke\b[^>]*>[\s\S]*$/gi, "")
    // Keep ---QUESTION--- for ClarificationCard (even if ---END--- is missing).
    // Trailing garbled minimax open
    .replace(/\]\s*<\]\s*minimax\s*\[>[\s\S]*$/gi, "")
    .replace(/^\s*\]\s*<\]\s*minimax\s*\[>.*$/gim, "")
    .replace(
      /^\s*<\/?(?:tool_call|function_call|invoke|parameter|minimax:tool_call)\b[^>]*>\s*$/gim,
      "",
    );
  return out;
}

export function scrubDisplayText(text: string, opts: ScrubOpts = {}): string {
  if (!text) return "";
  let out = stripClosedBlocks(text);
  if (!opts.streaming) {
    out = stripTrailingOpen(out);
  } else {
    // Mid-stream: hide only a *trailing* incomplete open tag at the very end
    // (so the user doesn't see half an XML tag), without eating later prose.
    out = out.replace(
      /(?:<tool_call>|<function_call>|<minimax:tool_call>|<think(?:ing)?>|<invoke\b[^>]*>)\s*$/i,
      "",
    );
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
