/**
 * applySteerInterrupt — pure routing for the /steer --interrupt flow (Task C.3.2).
 *
 * Extracted from app.tsx so it can be unit-tested without React/Ink.
 * Side effects are injected via the options:
 *  - `harness`: the currently-running AgentHarness, or null if no run is active
 *  - `appendMessage(content)`: append a system message to the chat
 *  - `setQueueCount(n)`: update the sidebar queue counter
 *  - `dispatchPrompt(text)`: dispatch a fresh prompt as if the user hit Enter
 *
 * Semantics:
 *  - With active harness: enqueue(text) + cancel() → user does NOT need to press
 *    Enter again (queue drain re-enters provider stream with the queued prompt).
 *  - Without active harness: fallback to dispatchPrompt(text) as a fresh prompt.
 */
export async function applySteerInterrupt(options: {
  text: string;
  harness: { enqueue(text: string): void; cancel(): void; queueLength: number } | null;
  appendMessage: (content: string) => void;
  setQueueCount: (n: number) => void;
  dispatchPrompt: (text: string) => Promise<void>;
}): Promise<void> {
  const { text, harness, appendMessage, setQueueCount, dispatchPrompt } = options;
  if (!harness) {
    appendMessage('[steer --interrupt] no active run — dispatching as fresh prompt.');
    await dispatchPrompt(text);
    return;
  }
  harness.enqueue(text);
  harness.cancel();
  setQueueCount(harness.queueLength);
  appendMessage(`[steer --interrupt] cancelled current run + enqueued: "${text}" (queue: ${harness.queueLength})`);
}