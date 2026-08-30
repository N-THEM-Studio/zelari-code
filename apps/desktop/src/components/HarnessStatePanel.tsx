/**
 * Harness State panel — first Desktop GUI consumer of the CLI's final
 * `harness_state` NDJSON event (ADR-0023), relayed by the harness sidecar
 * over the advisory `harness-state` Tauri event.
 *
 * Shows: turn count, per-turn verdict (PASS / REPAIR_REQUIRED / BLOCKED /
 * unknown — unknown ≠ pass) with completion-contract blockers, and the
 * support lens (contextProjections / memoryEvents / compactions).
 * Advisory by contract: renders NOTHING until a state arrives — a missing
 * or malformed event never surfaces as an error.
 */
import type { CSSProperties } from "react";
import { useHarnessState } from "../harnessState";
import type { HarnessTurnView, HarnessVerdict } from "../harnessState";

function verdictTone(verdict: HarnessVerdict): CSSProperties {
  if (verdict === "PASS") return { color: "var(--ok, #34c77b)" };
  if (verdict === "REPAIR_REQUIRED") return { color: "var(--warn, #e0a83c)" };
  if (verdict === "BLOCKED") return { color: "var(--danger, #e05a5a)" };
  return { opacity: 0.8 };
}

function TurnRow({ turn }: { turn: HarnessTurnView }) {
  return (
    <div
      className="harness-state-turn"
      data-verdict={turn.verdict}
      style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}
    >
      <span aria-hidden>#{turn.index}</span>
      <span style={verdictTone(turn.verdict)}>{turn.verdict}</span>
      {turn.verdictRaw && turn.verdictRaw !== turn.verdict ? (
        <span style={{ opacity: 0.7 }}>evidence: {turn.verdictRaw}</span>
      ) : null}
      {turn.complete ? null : <span style={{ opacity: 0.7 }}>incomplete</span>}
      {turn.toolCalls > 0 ? (
        <span style={{ opacity: 0.7 }}>tools {turn.toolCalls}</span>
      ) : null}
      {turn.blockers.length > 0 ? (
        <span className="harness-state-blockers" style={{ opacity: 0.8 }}>
          blockers: {turn.blockers.slice(0, 3).join("; ")}
        </span>
      ) : null}
    </div>
  );
}

export function HarnessStatePanel() {
  const state = useHarnessState();
  if (!state) return null;
  return (
    <section
      className="harness-state-panel"
      aria-live="polite"
      aria-label="Harness state"
      style={{
        borderTop: "1px solid rgba(128,128,128,0.4)",
        marginTop: 8,
        paddingTop: 8,
        fontSize: "0.9em",
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong>HARNESS STATE</strong>
        <span style={{ opacity: 0.7 }}>
          {state.turnsTotal} turn{state.turnsTotal === 1 ? "" : "s"} · session{" "}
          {state.sessionId || "?"} · {state.status}
        </span>
      </div>
      {state.turns.map((t) => (
        <TurnRow key={t.index} turn={t} />
      ))}
      <div className="harness-state-support" style={{ opacity: 0.8, marginTop: 4 }}>
        Support lens: context projections {state.support.contextProjections}
        {state.support.contextChars > 0
          ? ` (${state.support.contextChars} chars)`
          : ""}
        {" · "}memory events {state.support.memoryEvents}
        {" · "}compactions {state.support.compactions}
      </div>
    </section>
  );
}
