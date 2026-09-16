/**
 * Composer media row (W3.2): attach / skills / mic. Presentational — all state
 * and behaviour stay in Composer, which passes the flags and callbacks down.
 */
import { AttachIcon, MicIcon, SkillsIcon } from "./composerIcons";

interface Props {
  running: boolean;
  speechOk: boolean;
  listening: boolean;
  onPickExternalFiles: () => void;
  onOpenSkillPicker: () => void;
  onToggleSpeech: () => void;
}

export function ComposerMediaButtons({
  running,
  speechOk,
  listening,
  onPickExternalFiles,
  onOpenSkillPicker,
  onToggleSpeech,
}: Props) {
  return (
    <>
      <button
        type="button"
        className="btn-skill-pick"
        title="Attach files (any folder)"
        aria-label="Attach files"
        onClick={() => void onPickExternalFiles()}
      >
        <AttachIcon />
      </button>
      <button
        type="button"
        className="btn-skill-pick"
        title="List & select a skill"
        aria-label="Skills"
        disabled={running}
        onClick={() => onOpenSkillPicker()}
      >
        <SkillsIcon />
      </button>
      <button
        type="button"
        className={`btn-mic${listening ? " is-on" : ""}${!speechOk ? " is-unavailable" : ""}`}
        title={
          !speechOk
            ? "Speech recognition not available in this WebView"
            : listening
              ? "Stop listening"
              : "Speech to text"
        }
        aria-label="Speech to text"
        aria-pressed={listening}
        disabled={!speechOk || running}
        onClick={() => onToggleSpeech()}
      >
        <MicIcon />
      </button>
    </>
  );
}
