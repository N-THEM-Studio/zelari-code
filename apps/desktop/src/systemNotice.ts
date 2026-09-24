/**
 * systemNotice — turn a raw system line into something a person can read.
 *
 * System messages used to render as one red box whatever they said: a
 * provider `HTTP 404: {"code":…}` JSON dump, a harmless "[zelari]" note, a
 * queued follow-up and an answered question all looked like errors. This
 * module classifies a line (plus the error event's `code` / `severity` when
 * the runtime sent them) into a tone, a short title, a plain explanation, an
 * actionable next step and — only when useful — the raw technical details.
 *
 * Pure and dependency-free: ChatList renders the result; tests pin it.
 */

export type NoticeTone = "error" | "warning" | "info" | "success";

export interface NoticeMeta {
  /** Stable guard/error code from the runtime event (e.g. tool_budget_extended). */
  code?: string;
  /** Runtime severity of the error event: fatal | recoverable. */
  severity?: string;
}

export interface Notice {
  tone: NoticeTone;
  title: string;
  body?: string;
  /** What the user can do about it (rendered with an arrow). */
  hint?: string;
  /** Raw technical text, shown collapsed. */
  details?: string;
  /** One-line, low-emphasis rendering (progress notes, confirmations). */
  compact?: boolean;
}

const SETTINGS_MODELS = "Settings → Models & Providers";

/** First JSON object embedded in a line, parsed; null when there is none. */
function embeddedJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Human message out of a provider error body ({error:{message}} / {error} / {message}). */
function providerMessage(json: Record<string, unknown> | null, raw: string): string {
  const err = json?.error;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  if (typeof err === "string") return err;
  if (typeof json?.message === "string") return json.message;
  const afterStatus = raw.replace(/^HTTP\s*\d{3}\s*:?\s*/i, "").trim();
  return afterStatus.length <= 160 ? afterStatus : `${afterStatus.slice(0, 157)}…`;
}

/** Model id named in a provider "not found" message, when there is one. */
export function modelFromError(text: string): string | null {
  const patterns = [
    /\bmodel\s+[`"'“]?([A-Za-z0-9._:/-]+)[`"'”]?\s+(?:does not exist|not found|is not (?:available|supported))/i,
    /"model"\s*:\s*"([^"]+)"/i,
    /unknown model\s*[`"'“]?([A-Za-z0-9._:/-]+)/i,
    /unsupported model\s*[`"'“]?([A-Za-z0-9._:/-]+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Raw text for the details block: JSON bodies pretty-printed. */
function technical(raw: string): string {
  const json = embeddedJson(raw);
  if (!json) return raw;
  const prefix = raw.slice(0, raw.indexOf("{")).trim();
  return `${prefix ? `${prefix}\n` : ""}${JSON.stringify(json, null, 2)}`;
}

function splitTitle(text: string): { title: string; body?: string } {
  const trimmed = text.trim();
  const nl = trimmed.indexOf("\n");
  const first = nl < 0 ? trimmed : trimmed.slice(0, nl).trim();
  const rest = nl < 0 ? "" : trimmed.slice(nl + 1).trim();
  if (first.length <= 140) return { title: first, body: rest || undefined };
  return { title: `${first.slice(0, 137)}…`, body: trimmed };
}

function describeHttp(status: number, raw: string): Notice {
  const json = embeddedJson(raw);
  const message = providerMessage(json, raw);
  const details = technical(raw);
  if (status === 404) {
    const model = modelFromError(raw);
    return {
      tone: "error",
      title: model ? "Model not found" : "Provider endpoint not found",
      body: model
        ? `The provider does not recognise the model “${model}”.`
        : message || "The provider answered 404 (not found).",
      hint: `Pick another model in the model bar or in ${SETTINGS_MODELS}${model ? "" : "; check the server address if you set one"}.`,
      details,
    };
  }
  if (status === 401 || status === 403) {
    return {
      tone: "error",
      title: "Sign-in or API key rejected",
      body: message || "The provider refused the credentials.",
      hint: `Sign in again or replace the key in ${SETTINGS_MODELS}.`,
      details,
    };
  }
  if (status === 429) {
    return {
      tone: "warning",
      title: "Rate limit reached",
      body: message || "The provider is throttling requests.",
      hint: "Wait a moment and retry, or switch to another model.",
      details,
    };
  }
  if (status >= 500) {
    return {
      tone: "error",
      title: "Provider temporarily unavailable",
      body: message || `The provider answered ${status}.`,
      hint: "Retry in a moment; if it persists, switch model or provider.",
      details,
    };
  }
  return {
    tone: "error",
    title: "Request rejected by the provider",
    body: message || `The provider answered ${status}.`,
    hint: "Try another model; the technical details say what the provider objected to.",
    details,
  };
}

/** Code-keyed runtime notices (AgentHarness / Kraken guard codes). */
const BY_CODE: Record<string, (raw: string) => Notice> = {
  tool_budget_extended: (raw) => ({ tone: "info", title: raw.trim(), compact: true }),
  assistant_text_loop: (raw) => ({
    tone: "warning",
    title: "Stopped a repeating reply",
    body: splitTitle(raw).title,
    hint: "Click “Continue with tools”, or send a short request that asks for one concrete edit.",
  }),
  tool_call_truncated: (raw) => ({
    tone: "warning",
    title: "A tool call was cut off",
    body: "The model's request was too long and got truncated; it will retry with a smaller step.",
    details: raw,
  }),
  text_tools_parse_failed: (raw) => ({
    tone: "warning",
    title: "Couldn't read the model's tool request",
    body: "The model wrote tools as text in a format the runtime could not parse.",
    details: raw,
  }),
  text_tools_truncated: (raw) => ({
    tone: "warning",
    title: "The model's tool request was incomplete",
    details: raw,
  }),
  build_liveness_stalled: (raw) => ({
    tone: "warning",
    title: "No file was changed",
    body: raw.trim(),
    hint: "Ask again naming the file to edit, or switch to a stronger model.",
  }),
  build_liveness_provider_error: (raw) => ({
    tone: "error",
    title: "The provider failed before any change was made",
    body: raw.trim(),
    hint: "Retry; if it keeps failing, check the provider in " + SETTINGS_MODELS + ".",
  }),
  mutation_storm: (raw) => ({
    tone: "warning",
    title: "Stopped repeated failing edits",
    body: raw.trim(),
  }),
  runaway_guard_abort: (raw) => ({
    tone: "warning",
    title: "Run stopped by the safety guard",
    body: raw.trim(),
  }),
  trust_denied: (raw) => ({
    tone: "warning",
    title: "This folder is not trusted",
    body: raw.trim(),
    hint: "Trust the folder to let Zelari run tools in it.",
  }),
  policy_invalid: (raw) => ({
    tone: "error",
    title: "The project policy file is invalid",
    body: raw.trim(),
    hint: "Fix .zelari/policy.json (the details name the problem).",
  }),
};

/**
 * Describe one system line. `meta` carries the runtime error event's code and
 * severity when the line came from one; old stored messages have none and are
 * classified from their text alone.
 */
export function describeSystemMessage(content: string, meta: NoticeMeta = {}): Notice {
  const raw = content ?? "";
  const text = raw.trim();

  if (meta.code && BY_CODE[meta.code]) return BY_CODE[meta.code](raw);

  const followUp = /^Follow-up ready:\s*([\s\S]+)$/.exec(text);
  if (followUp) {
    return {
      tone: "info",
      title: "Follow-up queued",
      body: followUp[1].trim(),
      hint: "It is sent as soon as the current run ends.",
    };
  }

  const note = /^\[(?:zelari|headless)\]\s*([\s\S]+)$/i.exec(text);
  if (note) return { tone: "info", title: note[1].trim(), compact: true };

  if (/\btool_args_(?:parse_failed|missing)\b/.test(text)) {
    const missing = /tool_args_missing/.test(text);
    return {
      tone: "warning",
      title: missing ? "A tool call arrived without its arguments" : "A tool call arrived malformed",
      body: missing
        ? "The model asked for a tool but its arguments were empty; the call was checked and the model got feedback."
        : "The model's tool arguments were not valid JSON, so that call was skipped.",
      hint: "Usually self-corrects on the next step; if it repeats, switch model.",
      details: raw,
    };
  }

  const http = /\bHTTP\s*(\d{3})\b/i.exec(text);
  if (http) return describeHttp(Number(http[1]), raw);

  const noKey = /no API key for provider '([^']+)'/i.exec(text);
  if (noKey) {
    return {
      tone: "error",
      title: `${noKey[1]} is not connected`,
      body: "There is no sign-in or API key for this provider yet.",
      hint: `Sign in or add a key in ${SETTINGS_MODELS}.`,
      details: raw,
    };
  }

  if (/network error|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|connect timeout/i.test(text)) {
    const host = /(?:ENOTFOUND|ECONNREFUSED)\s+([\w.-]+)/.exec(text)?.[1];
    return {
      tone: "error",
      title: "Can't reach the provider",
      body: host ? `No connection to ${host}.` : "The request never reached the provider.",
      hint: `Check your internet connection, or the server address in ${SETTINGS_MODELS}.`,
      details: raw,
    };
  }

  if (/stream idle|exceeded max duration|stalled|stopped responding/i.test(text)) {
    return {
      tone: "warning",
      title: "The model stopped responding",
      body: splitTitle(text).title,
      hint: "Retry, or switch to another model.",
      details: raw,
    };
  }

  if (/^aborted$|\bcancell?ed\b/i.test(text)) {
    return { tone: "info", title: "Run stopped", compact: true };
  }

  if (/already has a run in progress/i.test(text)) {
    return {
      tone: "warning",
      title: "This chat is still working",
      hint: "Wait for it, steer it from the composer, or stop it — or open another chat.",
    };
  }
  if (/zelari mission is already running/i.test(text)) {
    return {
      tone: "warning",
      title: "A mission is already running in this folder",
      hint: "Wait for it to finish or stop it first; other chats can keep working here.",
    };
  }
  if (/too many concurrent runs/i.test(text)) {
    return { tone: "warning", title: "Too many runs at once", body: text, hint: "Wait for a run to finish, then retry." };
  }
  if (/node\.?js not found/i.test(text)) {
    return {
      tone: "error",
      title: "Node.js was not found",
      hint: "Install Node.js 20 or newer, then restart Zelari.",
      details: raw,
    };
  }

  const { title, body } = splitTitle(text || "Unknown error");
  const tone: NoticeTone = meta.severity === "fatal" ? "error" : "warning";
  const looksTechnical = Boolean(embeddedJson(text)) || text.length > 280;
  return {
    tone,
    title,
    ...(body && !looksTechnical ? { body } : {}),
    ...(looksTechnical ? { details: technical(raw) } : {}),
  };
}

/** The resolved ask_user outcome, as a notice. */
export function describeAskUserOutcome(question: string, answer: string | undefined, timedOut: boolean): Notice {
  if (timedOut) {
    return {
      tone: "warning",
      title: "No answer — continued with a documented assumption",
      body: question || undefined,
      compact: true,
    };
  }
  return {
    tone: "success",
    title: `Answered: ${answer ?? ""}`.trim(),
    body: question || undefined,
    compact: true,
  };
}
