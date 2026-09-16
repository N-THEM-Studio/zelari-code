/**
 * Composer send/stop row (W3.2): steer or queue while a run is live, plain send
 * when idle. Presentational — Composer owns the text and hands the gate down.
 */
import { SendArrowIcon, SendArrowUpIcon } from "./composerIcons";

interface Props {
  running: boolean;
  liveSendMode: "steer" | "queue";
  steerSupported: boolean;
  /** draft or speech interim currently holds text. */
  hasText: boolean;
  attachmentCount: number;
  hasPendingSkill: boolean;
  cliBlocked: boolean;
  onSubmit: () => void;
  onStop: () => void;
}

export function ComposerSendButtons({
  running,
  liveSendMode,
  steerSupported,
  hasText,
  attachmentCount,
  hasPendingSkill,
  cliBlocked,
  onSubmit,
  onStop,
}: Props) {
  const steer = liveSendMode === "steer" && steerSupported;
  if (running) {
    return (
      <>
        <button
          type="button"
          className="btn-send"
          disabled={!hasText && attachmentCount === 0}
          onClick={onSubmit}
          title={
            steer
              ? "Steer — applied at the next tool boundary"
              : "Queue follow-up — sends when this run ends"
          }
          aria-label={steer ? "Steer running agent" : "Queue follow-up"}
        >
          <SendArrowIcon />
        </button>
        <button
          type="button"
          className="btn-stop"
          onClick={() => onStop()}
          title="Stop"
        >
          Stop
        </button>
      </>
    );
  }
  return (
    <button
      type="button"
      className="btn-send"
      disabled={
        (!hasText && attachmentCount === 0 && !hasPendingSkill) || cliBlocked
      }
      onClick={onSubmit}
      title="Send"
      aria-label="Send"
    >
      <SendArrowUpIcon />
    </button>
  );
}
