//! delta_coalescer — coalesce consecutive streaming delta events
//! (`message_delta` / `thinking_delta`) into ONE event before the desktop
//! sidecar fans them out to the UI (W2.3).
//!
//! Why: the model emits one `message_delta` per token (~50-200/sec). Each one
//! crossed the Tauri event bridge and forced a frontend re-render. Batching
//! consecutive deltas of the SAME (request id, delta type) into a single event
//! whose text payload is the concatenation keeps the wire contract byte-for-byte
//! identical (same event name, same `delta` field) while cutting the event rate
//! to ~1 per 40ms flush window.
//!
//! Ordering is the hard invariant (never regress the per-request ordering
//! guaranteed by the chat-isolation Fix B/t60). The coalescer holds AT MOST ONE
//! pending buffer. Any event that is not a same-key delta — a non-delta event, a
//! delta of a different type, or a delta for a different request — first FLUSHES
//! the pending buffer, so the coalesced event is always emitted BEFORE the event
//! that displaced it. A semantic boundary (`message_start`/`message_end`/tool/
//! `agent_end`/`error`/…) can therefore never overtake the deltas preceding it.

use serde_json::Value;
use std::time::{Duration, Instant};

/// The only event types that participate in coalescing. Everything else is a
/// semantic boundary and passes straight through (after flushing any pending
/// buffer).
pub(crate) fn is_delta_type(kind: &str) -> bool {
    matches!(kind, "message_delta" | "thinking_delta")
}

/// Flush window: a buffer older than this is flushed by the flusher thread even
/// if no further event arrives, so a slow stream still reaches the UI.
pub(crate) const FLUSH_WINDOW: Duration = Duration::from_millis(40);

/// Candidate text fields, in the same precedence the frontend's `extractDelta`
/// uses (`delta` first). `message_delta`/`thinking_delta` on this wire always
/// carry `delta`; the fallbacks keep odd producer shapes coalescing correctly.
const TEXT_FIELDS: [&str; 4] = ["delta", "text", "content", "chunk"];

/// Read the text payload of a delta event and the field that carried it.
fn pick_text(event: &Value) -> (&'static str, String) {
    for field in TEXT_FIELDS {
        if let Some(text) = event.get(field).and_then(Value::as_str) {
            return (field, text.to_string());
        }
    }
    ("delta", String::new())
}

/// One in-flight coalescing buffer.
struct Pending {
    /// Delivery/request identity — the sidecar run id (one `run.turn` request).
    request_id: String,
    /// Delta event type (`message_delta` / `thinking_delta`).
    kind: String,
    /// Field that carries the text payload in this event family.
    field: &'static str,
    /// First event of the run; its shape (id/ts/messageId/sessionId/…) is kept
    /// verbatim and only the text field grows.
    template: Value,
    /// Concatenated text payloads, in arrival order.
    text: String,
    /// Creation time — the flush deadline is `created + FLUSH_WINDOW`.
    created: Instant,
}

/// Consecutive-delta coalescer. See the module doc for the ordering contract.
pub(crate) struct DeltaCoalescer {
    active: Option<Pending>,
}

impl DeltaCoalescer {
    pub(crate) fn new() -> Self {
        Self { active: None }
    }

    /// Feed one delta event. Returns the previously pending buffer when it had
    /// to be flushed to make room (the incoming key differs — different type or
    /// different request id); the caller emits it FIRST. Returns `None` when the
    /// event was appended to the still-matching buffer.
    pub(crate) fn push_delta(&mut self, request_id: &str, event: Value) -> Option<(String, Value)> {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let (field, chunk) = pick_text(&event);
        match self.active.as_mut() {
            Some(pending) if pending.request_id == request_id && pending.kind == kind => {
                pending.text.push_str(&chunk);
                None
            }
            _ => {
                let displaced = self.take();
                self.active = Some(Pending {
                    request_id: request_id.to_string(),
                    kind,
                    field,
                    template: event,
                    text: chunk,
                    created: Instant::now(),
                });
                displaced
            }
        }
    }

    /// Flush the pending buffer IFF it belongs to `request_id` — the
    /// flush-before-a-same-request non-delta trigger (ordering, requirement a).
    pub(crate) fn flush_for(&mut self, request_id: &str) -> Option<(String, Value)> {
        match &self.active {
            Some(pending) if pending.request_id == request_id => self.take(),
            _ => None,
        }
    }

    /// Flush the pending buffer unconditionally (timer / stream end / shutdown /
    /// EOF). Returns it for emission.
    pub(crate) fn flush(&mut self) -> Option<(String, Value)> {
        self.take()
    }

    /// Timer path: flush the pending buffer once the window has elapsed.
    pub(crate) fn flush_if_due(&mut self, window: Duration) -> Option<(String, Value)> {
        match &self.active {
            Some(pending) if pending.created.elapsed() >= window => self.take(),
            _ => None,
        }
    }

    /// Take the pending buffer, materializing the coalesced event: the template
    /// with the text field replaced by the concatenation of every chunk. A
    /// single-chunk buffer is byte-identical to the original event.
    fn take(&mut self) -> Option<(String, Value)> {
        let pending = self.active.take()?;
        let mut event = pending.template;
        if let Some(object) = event.as_object_mut() {
            object.insert(pending.field.to_string(), Value::String(pending.text));
        }
        Some((pending.request_id, event))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn delta(kind: &str, text: &str) -> Value {
        json!({ "type": kind, "delta": text })
    }

    #[test]
    fn consecutive_same_type_deltas_coalesce_into_one_event() {
        let mut c = DeltaCoalescer::new();
        assert!(c.push_delta("req-1", delta("message_delta", "Hel")).is_none());
        assert!(c.push_delta("req-1", delta("message_delta", "lo ")).is_none());
        assert!(c.push_delta("req-1", delta("message_delta", "world")).is_none());
        let (request_id, event) = c.flush().expect("buffered deltas flush");
        assert_eq!(request_id, "req-1");
        assert_eq!(event["type"], "message_delta");
        assert_eq!(event["delta"], "Hello world");
    }

    #[test]
    fn different_type_flushes_the_previous_buffer_first() {
        let mut c = DeltaCoalescer::new();
        assert!(c.push_delta("req-1", delta("message_delta", "answer")).is_none());
        let displaced = c
            .push_delta("req-1", delta("thinking_delta", "hmm"))
            .expect("type change flushes the previous buffer");
        assert_eq!(displaced.0, "req-1");
        assert_eq!(displaced.1["type"], "message_delta");
        assert_eq!(displaced.1["delta"], "answer");
        // The thinking delta is now the live buffer.
        assert_eq!(c.flush().unwrap().1["type"], "thinking_delta");
    }

    #[test]
    fn different_request_id_flushes_the_previous_buffer_first() {
        let mut c = DeltaCoalescer::new();
        assert!(c.push_delta("req-1", delta("message_delta", "A1")).is_none());
        assert!(c.push_delta("req-1", delta("message_delta", "A2")).is_none());
        let displaced = c
            .push_delta("req-2", delta("message_delta", "B1"))
            .expect("request change flushes the previous buffer");
        assert_eq!(displaced.0, "req-1");
        assert_eq!(displaced.1["delta"], "A1A2");
        // The req-2 delta is now the live buffer (still unflushed).
        assert_eq!(c.flush().unwrap().0, "req-2");
    }

    #[test]
    fn flush_for_a_different_request_is_a_noop() {
        let mut c = DeltaCoalescer::new();
        c.push_delta("req-1", delta("message_delta", "kept"));
        assert!(c.flush_for("req-other").is_none());
        assert_eq!(c.flush().unwrap().1["delta"], "kept");
    }

    #[test]
    fn flush_if_due_only_after_the_window() {
        let mut c = DeltaCoalescer::new();
        c.push_delta("req-1", delta("message_delta", "x"));
        assert!(c.flush_if_due(Duration::from_secs(3600)).is_none(), "window not elapsed");
        let due = c
            .flush_if_due(Duration::from_millis(0))
            .expect("zero window is always due");
        assert_eq!(due.1["delta"], "x");
    }

    #[test]
    fn a_lone_delta_is_emitted_byte_identical() {
        let mut c = DeltaCoalescer::new();
        let original = json!({ "type": "message_delta", "id": "e1", "delta": "solo" });
        c.push_delta("req-1", original.clone());
        assert_eq!(c.flush().unwrap().1, original);
    }
}
