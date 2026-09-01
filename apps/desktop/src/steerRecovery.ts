/**
 * Steer send-result classification (control plane §24/§30–§35).
 *
 * The Rust `send_control` bridge resolves to the CLI's session.steer result.
 * Authoritative wire shape (harnessServer.ts, `session.steer` with no live
 * turn): `{ accepted:false, outcome:'already_finished', controlId,
 * controlType:'steer' }` — resolved as a PARSED OBJECT by current builds.
 * Legacy desktop bridges shipped a JSON STRING such as
 * `{"status":"already_finished"}`; older builds resolve falsy/empty and
 * transport/rpc errors reject the promise. Pure + unit-testable; App.tsx
 * maps the outcome onto the steer bubble / composer.
 */
export type SteerSendOutcome =
  | { status: "already_finished" }
  | { status: "follow_up_queued" }
  | null;

/** Map a parsed result object to an outcome (unknown shapes → null). */
function fromParsed(value: unknown): SteerSendOutcome {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as { accepted?: unknown; outcome?: unknown; status?: unknown };
  // §24: accepted === true means the control WAS queued — the ack cycle
  // arrives as events (control_accepted/…), so there is nothing to recover.
  if (rec.accepted === true) return null;
  // Authoritative field is `outcome`; legacy bridges used `status`. Unknown
  // or missing statuses → null (callers keep the ack-event-driven flow).
  const raw =
    typeof rec.outcome === "string"
      ? rec.outcome
      : typeof rec.status === "string"
        ? rec.status
        : "";
  const s = raw.toLowerCase();
  if (s === "already_finished") return { status: "already_finished" };
  if (s === "follow_up_queued") return { status: "follow_up_queued" };
  return null;
}

/**
 * Classify the raw value resolved by `send_control`. Returns null for
 * falsy/unparseable input (old builds) so callers keep the existing
 * ack-event-driven behavior; a bare string that merely CONTAINS
 * "already_finished" is tolerated too.
 */
export function parseSteerSendResult(raw: unknown): SteerSendOutcome {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    try {
      const fromJson = fromParsed(JSON.parse(t) as unknown);
      if (fromJson) return fromJson;
    } catch {
      /* not JSON — fall through to substring scan */
    }
    const lower = t.toLowerCase();
    if (lower.includes("already_finished")) return { status: "already_finished" };
    if (lower.includes("follow_up_queued")) return { status: "follow_up_queued" };
    return null;
  }
  return fromParsed(raw);
}
