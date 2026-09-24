/**
 * systemNotice.test — the chat's system lines are classified by meaning, not
 * rendered as one red box (2026-09-24 chat pass). Pins the provider-error
 * wording (actionable, raw JSON only in details), runtime guard codes, quiet
 * notes, and the fallback for old stored messages without metadata.
 */
import { describe, expect, it } from "vitest";
import { describeAskUserOutcome, describeSystemMessage, modelFromError } from "./systemNotice";

describe("provider errors become actionable notices", () => {
  it("404 with a model name → 'Model not found' naming the model, raw JSON in details", () => {
    const n = describeSystemMessage('HTTP 404: {"code":"not-found","error":"The model default-grok does not exist"}');
    expect(n.tone).toBe("error");
    expect(n.title).toBe("Model not found");
    expect(n.body).toContain("“default-grok”");
    expect(n.hint).toContain("Settings → Models & Providers");
    expect(n.details).toContain('"code": "not-found"');
  });

  it("404 without a model → endpoint not found, mentions the server address", () => {
    const n = describeSystemMessage("HTTP 404: page not found");
    expect(n.title).toBe("Provider endpoint not found");
    expect(n.hint).toContain("server address");
  });

  it("401/403 → credentials rejected; 429 → rate limit (warning); 5xx → temporary", () => {
    expect(describeSystemMessage('HTTP 401: {"error":{"message":"invalid token"}}')).toMatchObject({
      tone: "error",
      title: "Sign-in or API key rejected",
      body: "invalid token",
    });
    expect(describeSystemMessage("HTTP 429: slow down")).toMatchObject({ tone: "warning", title: "Rate limit reached" });
    expect(describeSystemMessage("HTTP 503: upstream")).toMatchObject({ title: "Provider temporarily unavailable" });
  });

  it("network failures name the host; a missing key names the provider", () => {
    expect(describeSystemMessage("Network error: getaddrinfo ENOTFOUND api.x.ai")).toMatchObject({
      tone: "error",
      title: "Can't reach the provider",
      body: "No connection to api.x.ai.",
    });
    expect(describeSystemMessage("no API key for provider 'deepseek'.\nSet the env var…")).toMatchObject({
      title: "deepseek is not connected",
    });
  });

  it("extracts model ids from the usual phrasings", () => {
    expect(modelFromError("The model gpt-9 does not exist")).toBe("gpt-9");
    expect(modelFromError('{"model":"glm-5.3-flash"}')).toBe("glm-5.3-flash");
    expect(modelFromError("Unsupported model glm-5.3-flash")).toBe("glm-5.3-flash");
    expect(modelFromError("nothing here")).toBeNull();
  });
});

describe("runtime codes and quiet notes", () => {
  it("uses the event code when present (tool budget = quiet info line)", () => {
    const n = describeSystemMessage("Tool budget extended (24→48, hard 96).", { code: "tool_budget_extended" });
    expect(n).toMatchObject({ tone: "info", compact: true });
  });

  it("assistant_text_loop gets its own next step instead of a pasted paragraph", () => {
    const n = describeSystemMessage("assistant text loop detected", { code: "assistant_text_loop" });
    expect(n.title).toBe("Stopped a repeating reply");
    expect(n.hint).toContain("Continue with tools");
  });

  it("[zelari] notes and follow-ups are informational, never errors", () => {
    expect(describeSystemMessage("[zelari] strict done: 2 checks pending")).toMatchObject({
      tone: "info",
      compact: true,
      title: "strict done: 2 checks pending",
    });
    expect(describeSystemMessage("Follow-up ready: add tests")).toMatchObject({
      tone: "info",
      title: "Follow-up queued",
      body: "add tests",
    });
  });

  it("tool-args guard codes read as a warning with the raw line in details", () => {
    const n = describeSystemMessage("tool_args_missing: tool call c1 (read_file) arrived with no arguments");
    expect(n.tone).toBe("warning");
    expect(n.title).toBe("A tool call arrived without its arguments");
    expect(n.details).toContain("tool_args_missing");
  });

  it("host dispatch refusals explain what to do", () => {
    expect(describeSystemMessage("This chat already has a run in progress. Wait…")).toMatchObject({
      tone: "warning",
      title: "This chat is still working",
    });
  });
});

describe("fallback for unknown lines", () => {
  it("fatal severity → error; otherwise warning; long/JSON text goes to details", () => {
    expect(describeSystemMessage("boom", { severity: "fatal" })).toMatchObject({ tone: "error", title: "boom" });
    expect(describeSystemMessage("something odd")).toMatchObject({ tone: "warning", title: "something odd" });
    const long = `weird ${"x".repeat(400)}`;
    expect(describeSystemMessage(long).details).toBe(long);
  });

  it("ask_user outcomes are compact confirmations", () => {
    expect(describeAskUserOutcome("Keep the style?", "Yes", false)).toMatchObject({
      tone: "success",
      title: "Answered: Yes",
      compact: true,
    });
    expect(describeAskUserOutcome("Keep the style?", undefined, true).tone).toBe("warning");
  });
});
