/**
 * Human-readable, rotating activity lines for tool use (English).
 */

export function friendlyToolLabel(
  name: string,
  summary?: string | null,
): string {
  const n = name.toLowerCase();
  const s = (summary ?? "").trim();
  const short = s.length > 48 ? `${s.slice(0, 46)}…` : s;

  if (
    n.includes("search") ||
    n.includes("grep") ||
    n.includes("find") ||
    n.includes("semantic")
  ) {
    return short ? `Searching · ${short}` : "Searching codebase…";
  }
  if (n.includes("list") || n.includes("glob") || n === "ls" || n.includes("tree")) {
    return short ? `Listing · ${short}` : "Listing files…";
  }
  if (n.includes("read") || n === "cat" || n.includes("open_file")) {
    return short ? `Reading · ${short}` : "Reading file…";
  }
  if (n.includes("write") || n.includes("create_file") || n === "write_file") {
    return short ? `Writing · ${short}` : "Writing file…";
  }
  if (
    n.includes("edit") ||
    n.includes("apply_patch") ||
    n.includes("str_replace") ||
    n.includes("search_replace") ||
    n.includes("patch")
  ) {
    return short ? `Editing · ${short}` : "Editing file…";
  }
  if (
    n === "bash" ||
    n === "shell" ||
    n.includes("exec") ||
    n.includes("terminal") ||
    n.includes("run_command")
  ) {
    return short ? `Running · ${short}` : "Running command…";
  }
  if (n.includes("web") || n.includes("fetch") || n.includes("browse")) {
    return short ? `Browsing · ${short}` : "Browsing the web…";
  }
  if (n.includes("git")) {
    return short ? `Git · ${short}` : "Checking git…";
  }
  if (n.includes("test")) {
    return short ? `Testing · ${short}` : "Running tests…";
  }
  return short ? `${name} · ${short}` : `Using ${name}…`;
}

/** Rotating deliberation / thinking phrases (English). */
export const THINKING_PHRASES = [
  "Preparing to deliberate…",
  "Deep thinking…",
  "Ruminating…",
  "Weighing options…",
  "Gathering context…",
  "Reasoning carefully…",
  "Considering approaches…",
  "Synthesizing ideas…",
  "Reflecting…",
  "Connecting the dots…",
  "Forming a plan…",
  "Almost there…",
] as const;

export const COUNCIL_THINKING_PHRASES = [
  "Council is assembling…",
  "Preparing to deliberate…",
  "Members weighing options…",
  "Deep thinking across models…",
  "Ruminating on the brief…",
  "Cross-checking perspectives…",
  "Seeking consensus…",
  "Synthesizing the chamber…",
  "Deliberation in progress…",
] as const;
