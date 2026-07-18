/**
 * Interactive clarification UI for ---QUESTION--- blocks (Desktop).
 * CLI has SelectList; Desktop previously stripped the block and never prompted.
 */

import type { ClarificationRequest } from "./parseClarification";

interface Props {
  request: ClarificationRequest;
  disabled?: boolean;
  onChoose: (choice: string) => void;
}

export function ClarificationCard({ request, disabled, onChoose }: Props) {
  const choices = request.choices?.length ? request.choices : null;

  return (
    <div className="clarification-card" role="group" aria-label="Clarification">
      <div className="clarification-kicker">Question for you</div>
      <div className="clarification-question">{request.question}</div>
      {request.context ? (
        <div className="clarification-context">{request.context}</div>
      ) : null}
      {choices ? (
        <div className="clarification-choices">
          {choices.map((c) => (
            <button
              key={c}
              type="button"
              className="clarification-choice"
              disabled={disabled}
              onClick={() => onChoose(c)}
            >
              {c}
            </button>
          ))}
        </div>
      ) : (
        <div className="clarification-hint">
          Type your answer in the composer below and send.
        </div>
      )}
    </div>
  );
}
