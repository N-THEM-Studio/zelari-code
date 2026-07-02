# Static-scrollback TUI refactor (v0.7.0)

**Status:** PROPOSED — not started. Approved by: _(pending)_

## Problem

Three user-reported defects share one root cause:

1. **Flicker** — the TUI renders a full-screen fixed-height frame
   (`app.tsx` root `<Box width={cols} height={rows} overflow="hidden">`).
   `ChatStream` manually picks "visible messages" via
   `pickVisibleMessages()` / `estimateMessageHeight()`, which count
   `line.length` **code units**, not display columns. Emoji, CJK, and
   Ink's own wrapping make the estimate wrong; the moment real output is
   taller than the terminal, Ink falls back to clear-screen + full
   repaint on every frame. The v0.6.2 60fps batching layer
   (`useBatchedMessages`) reduced repaint *frequency* but not the cause.
2. **No scrolling** — old messages are dropped from the render tree and
   nothing is ever written to the terminal's native scrollback, so
   there is literally nothing to scroll back to.
3. **Agent work rendered poorly** — tool output is force-truncated or
   collapsed to make the transcript fit the fixed frame; long agent
   sessions become unreadable.

## Solution (the pattern used by Claude Code, Jest, Gatsby)

Use Ink's `<Static>` component: **finalized** messages are printed
exactly once to real stdout and become part of the terminal's native
scrollback (user scrolls with the terminal itself). The **dynamic**
region that Ink repaints shrinks to: the currently-streaming assistant
bubble, in-flight tool lines, a one-line status bar, and the input bar.
Because the dynamic region is always a few lines tall, it can never
exceed the terminal height → no full-screen repaint → no flicker, *by
construction*.

### Layout: before → after

```
BEFORE (fixed frame, repainted)      AFTER (scrollback + small footer)
┌─ Header ─────────────────────┐     … native terminal scrollback …
│ ChatStream        │ Sidebar  │     <Static>: banner + finalized msgs
│ (picked messages) │ (40 col) │     ─────────────────────────────────
│                   │          │     ◆ assistant (streaming tail, ≤10 righe)
├─ InputBar ────────┴──────────┤     ⋯ [bash] npm test (running)
└──────────────────────────────┘     [grok · grok-4 · 12.3k tok · $0.04]
                                     ❯ input
```

The 40-col Sidebar cannot coexist with native scrollback (a fixed
right-hand column would be printed into every scrollback line). Its
content moves to: startup banner (skill list on demand via `/help`) and
the one-line status bar (provider · model · session · tokens · cost ·
queue).

## Non-goals

- Mouse/keyboard scrolling inside Ink (native terminal scrollback
  replaces it).
- Interactive expand/collapse of *old* tool outputs (Static items are
  immutable once printed — see Phase 3 for the replacement).
- Alternate-screen mode.

## Design invariant

**A message enters `<Static>` only when it can never change again.**

- `system` messages: final immediately.
- `user` messages: final immediately.
- `assistant` streaming bubble: final on `message_end` /
  `finalizeStreamingAssistant()` (already the seal point today).
- `tool` messages: final on `tool_execution_end` — NOT on start.
  (Today `appendToolStart` inserts a message that
  `updateToolMessageEnd` later mutates in place; that mutation is
  incompatible with Static and must stay in the dynamic region until
  the end event arrives.)

## Phases

### Phase 1 — state split: `finalized` vs `live`
Files: `src/cli/hooks/useSession.ts`, `src/cli/hooks/messageHelpers.ts`,
`src/cli/hooks/useChatTurn.ts`

- Replace the single `messages: ChatMessage[]` with:
  - `finalized: ChatMessage[]` — append-only, feeds `<Static>`.
  - `live: LiveState` — `{ streaming: ChatMessage | null, runningTools: ToolMessage[] }`.
- `appendSystem` / `appendUser` → push to `finalized`.
- `appendOrExtendStreamingAssistant` → update `live.streaming`
  (still through the `useBatchedMessages` throttle — keep it, it's
  correct for the hot path).
- `finalizeStreamingAssistant` → move `live.streaming` into `finalized`.
- `appendToolStart` → push to `live.runningTools`.
- `updateToolMessageEnd` → remove from `live.runningTools`, push the
  completed tool message to `finalized`.
- Council path (`dispatchCouncilPromptImpl`) uses the same helpers;
  per-member seal points already exist (`message_end` per member).
- Session restore (bootstrap in `useSession`): restored messages go
  straight into `finalized` (they print once into scrollback — same
  behavior as Claude Code on resume).

### Phase 2 — render layout
Files: `src/cli/app.tsx`, `src/cli/components/ChatStream.tsx`,
`Header.tsx`, `Sidebar.tsx` (deleted), `InputBar.tsx`

- `app.tsx`:
  ```tsx
  <>
    <Static items={staticItems}>{(item) => renderMessage(item)}</Static>
    <LiveRegion streaming={live.streaming} tools={live.runningTools} />
    <StatusBar provider model sessionId tokens cost queue busy />
    <InputBar … />
  </>
  ```
  `staticItems[0]` is a one-shot banner (logo, version, provider,
  "type /help for skills") replacing the persistent `Header`.
- Delete the root fixed `width/height/overflow` Box, the
  `size.rows - 6` math, and `chatWidth`.
- `ChatStream.tsx`: delete `pickVisibleMessages` +
  `estimateMessageHeight` (and their tests); keep `renderMessage` as a
  pure per-message renderer shared by Static and the live region.
- `Sidebar.tsx`: delete; skill list stays reachable via `/help` and
  `/skill` autocomplete message.
- `LiveRegion`: clamp the streaming text to the **last ~10 lines**
  (`content.split('\n').slice(-10)` + `…` marker). Full text is never
  lost — it lands complete in Static at finalize. This guarantees the
  dynamic region fits any terminal.
- `useTerminalSize` stays only if the status bar needs width-aware
  truncation; otherwise delete.

### Phase 3 — tool output policy (replaces interactive collapse)
Files: `src/cli/components/CollapsibleToolOutput.tsx`,
`src/cli/hooks/messageHelpers.ts`

- While running (dynamic): `⋯ [name] summary` single line + elapsed.
- On finalize, decide the printed form **once**:
  - error → summary + full body (bordered, as today's auto-expand);
  - success → summary + first `ZELARI_TOOL_OUTPUT_LINES` (default 5)
    lines of the result + `… (+K lines)` tail marker.
- `CollapsibleToolOutput` becomes a stateless `ToolOutput` (no
  `useState`, no `expanded` prop); the memo comparator goes away.
- Full bodies remain available in the session JSONL; add `/last-tool`
  (optional, stretch) to reprint the last tool body on demand.

### Phase 4 — commands with scrollback semantics
Files: `src/cli/hooks/useSlashDispatch.ts`, `src/cli/slashHandlers/skills.ts`

- `/clear` and `/new`: Static can't retro-erase scrollback. Emit ANSI
  `\x1b[2J\x1b[3J\x1b[H` (clear + wipe scrollback + home) via
  `process.stdout.write`, then remount `<Static>` with a new `key` so
  its internal "already printed" index resets. Verify on Windows
  Terminal + conhost (conhost ignores `3J`; acceptable degradation).
- `/compact` keeps operating on the in-memory transcript only (it
  feeds the LLM context, not the display).

### Phase 5 — tests
- Delete: `pickVisibleMessages` / height-estimator tests.
- Update: any `ink-testing-library` snapshot that assumed the fixed
  frame (`cli-appUsage.test.ts`, ChatStream/CollapsibleToolOutput
  tests, wizard tests unaffected).
- Add:
  - finalization transitions: streaming → finalized on `message_end`;
    tool start stays live, end moves to finalized (no in-place
    mutation of finalized items — assert by identity).
  - live-region clamp: >10-line streaming content renders last 10.
  - `/clear` remount: Static key changes, finalized resets.
  - restore path: N restored events → N static items + resume notice.
  - council: two members streaming interleaved seal into two distinct
    finalized bubbles with correct `memberName`.

### Phase 6 — manual verification (Windows Terminal, the user's env)
- Long streaming answer (>2 screens): no flicker, scrollback intact.
- Council run with 10+ tool calls: every tool visible in scrollback.
- Resize mid-stream: footer reflows, scrollback untouched.
- `/clear`, `/new`, `/resume`, Ctrl+C exit leave the terminal clean.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Static lines wrap at print-time width; resize doesn't rewrap | Accepted — identical to every scrollback CLI (Claude Code, Jest). |
| conhost (legacy console) ANSI quirks | Primary target is Windows Terminal; degrade gracefully (`3J` no-op). |
| Losing interactive tool expand | Phase 3 policy + `ZELARI_TOOL_OUTPUT_LINES` + session JSONL. |
| Hidden assumptions in 70 test files about `messages` single array | Phase 1 keeps `ChatMessage` shape untouched; only ownership moves. Run full suite after each phase. |
| Ink `<Static>` + throttled live updates interleaving out of order | Finalize always flushes the throttle first (`flushStreaming()` before moving to finalized — same ordering discipline as today). |

## Sizing

Phases 1–2 are the core (~1 day together, they must land atomically);
Phase 3 ~half day; Phases 4–5 ~half day; Phase 6 manual. Single PR,
version bump to 0.7.0 (user-visible UI change).
