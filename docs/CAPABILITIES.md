# Zelari Code — Capability Matrix

What this build actually does, how mature it is, and **where the evidence
lives in the tree**. One row per capability; every "Evidence" cell points at a
REAL file or an existing npm script — if it is not in this repo, it is not
claimed (P3: proof over narrative).

Statuses:

| Status | Meaning |
|---|---|
| **shipped** | Default-on (or explicitly opt-in) path, exercised by tests/scripts in the table |
| **experimental** | Works, but a kill-switch, a narrow scope, or a documented seam is still in play |
| **planned** | Code exists (module/form) but the runtime wiring is not complete — named as such, not sold as a feature |

Product surfaces: TUI (`zelari-code`), headless (`--headless`), harness kernel
(`--serve-harness`), companion host (`serve`), and the ACP front door
(`zelari-code acp`).

## Matrix

| Capability | Status | Evidence (path or command — verified in this tree) |
|---|---|---|
| **TUI agent** (Ink, chat, tool boxes, permission picker) | shipped | `src/cli/app.tsx`, `src/cli/components/tuiReactivity.test.tsx` |
| **Headless one-shot** (`--headless --task`, NDJSON/plain, exit codes 0–3) | shipped | `src/cli/runHeadless.ts`, `src/cli/headless.test.ts`, `src/cli/headlessE2eSession.test.ts` |
| **Headless control plane** (steer / follow_up / cancel over stdin) | shipped | `src/cli/headless/controlBridge.ts`, `src/cli/headless/controlReader.ts`, `src/cli/headlessControlPlane.test.ts` |
| **Harness kernel** (`--serve-harness`, sessions + run.turn NDJSON) | shipped | `src/cli/serve/harnessServer.ts`, `src/cli/serve/detectHarnessMode.ts` |
| **ACP front door** (`zelari-code acp`) — initialize / session/new / session/prompt / session/cancel; `session/update` with `agent_message_chunk`, `tool_call`, `tool_call_update` | experimental | `src/cli/acp/server.ts`, `src/cli/acp/protocol.ts` (implemented subset + explicit non-goals), tests: `src/cli/acp/` (`npx vitest run src/cli/acp`). Turns reuse `dispatchHeadlessTurn` via `src/cli/acp/turnAdapter.ts`; no reverse requests (no client-side permission prompts), no `session/load`, no client MCP servers |
| **OS sandbox jail — Linux** (`bwrap`) | shipped | `src/cli/safety/jails/linux.ts`, `src/cli/safety/osJail.ts`, `tests/unit/cli-osJail.test.ts`, `node scripts/verify-os-jail.mjs` |
| **OS sandbox jail — macOS** (seatbelt `sandbox-exec`) | shipped | `src/cli/safety/jails/darwin.ts`, `tests/unit/cli-execProcess-jail.test.ts` |
| **OS sandbox jail — Windows** (restricted token + Job Object) | planned | `src/cli/safety/jails/win32.ts` — honest `unavailable`: those APIs need native bindings, and no native npm deps are allowed (P5). The CLI fails OPEN with a visible advisory; `ZELARI_OS_JAIL=required` denies instead |
| **Skills** (builtin + user/project `SKILL.md`, create/suggest/history) | shipped | `src/cli/skillsMd.ts`, `src/cli/tools/createSkillTool.ts`, `src/cli/skillHistory.ts`, tests: `tests/unit/cli-skillsMd.test.ts`, `tests/unit/cli-createSkillTool.test.ts` |
| **MCP servers** (stdio + HTTP, presets, project/user config) | shipped | `src/cli/mcp/mcpManager.ts`, `src/cli/mcp/mcpConfigIo.ts`, tests: `tests/unit/cli-mcp.test.ts`, `tests/unit/cli-mcpHttp.test.ts` |
| **Permission broker** (external agents via `--permission-mcp`, serve ask-bridge) | shipped | `src/cli/mcp/permissionBroker.ts`, `src/cli/mcp/mcpPermissionServer.ts`, `src/cli/serve/permissionBridge.ts`, tests: `tests/unit/cli-mcpPermissionServer.test.ts`, `src/cli/serve/permissionBridge.scope.test.ts` |
| **Memory V2** (SQLite backend + worker, semantic index, promotion, JSON/MCP bridges) | shipped | `src/cli/memory/sqliteBackend.ts`, `src/cli/memory/serviceFactory.ts`, `packages/core/src/memory/scoring.test.ts`, `npm run test:memory` |
| **Session spine** (ADR-0016 append-only event log, replay, export) | shipped | `src/cli/sessionSpine.ts`, `packages/core/src/session/` (`writer.test.ts`, `replay.test.ts`, `invariants.test.ts`), `src/cli/sessionReplayInvariant.test.ts` |
| **Sessions / resume** (`--resume <id>`, `--resume-mission`, `/sessions`, `/resume`) | shipped | `src/cli/headless.ts` (`--resume`, `--resume-mission` in `HELP_TEXT`), `src/cli/slashHandlers/missionResume.ts`, tests: `src/cli/missionResume.test.ts`, `src/cli/headlessSpine.test.ts` |
| **Budget / token accounting** (context projection, request meter, cost caps) | shipped | `src/cli/budget/budgetRuntime.ts`, `src/cli/budget/tokenBudget.ts`, `src/cli/costBudget.ts`, tests: `src/cli/budget/budgetRuntime.test.ts`, `src/cli/costBudget.test.ts` |
| **Runaway guard** (repeated tool call / no-progress turn detection) | experimental | `packages/core/src/core/modules/runaway-guard/runawayGuard.ts`, wired in `packages/core/src/core/AgentHarness.ts` (`checkToolCall` / `checkTurn`), tests: `runawayGuard.test.ts`, `runawayGuardHarness.test.ts`; kill-switch `ZELARI_RUNAWAY_GUARD` |
| **System reminder** (per-turn reminder block) | shipped | pure module `packages/core/src/core/modules/system-reminder/systemReminder.ts` + `systemReminder.test.ts`, wired by `assembleRequestTail` in `src/cli/budget/modelContextBuilder.ts`: the TUI lazy `requestTail` arrow (`src/cli/hooks/useChatTurn.ts`) appends the `[system-reminder]` line to the volatile request tail from fresh open session todos, a per-user-turn counter (reset after a tail that carried the marker) and the remaining budget the builder already computed. `buildModelContext` never passes reminder inputs, the text never enters rolling history, and the one-shot headless pass (`src/cli/headless/runOneTurn.ts`) passes counter 0 so it cannot fire (cadence 5). `AgentHarness.messagesForProvider()` is still **not** the seam — it keeps the `TODO(seam)` on the CLI assembler (ADR-0032). Kill-switch `ZELARI_SYSTEM_REMINDER=0` |
| **Configurable status line** (`<zelariHome>/statusline.json`, custom command chip) | experimental | `src/cli/statusline/statuslineConfig.ts`, `src/cli/statusline/statuslineCustom.ts`, tests: `statuslineConfig.test.ts`, `statuslineCustom.test.ts`, `statuslineItems.test.ts`; write path via `/statusline` (`src/cli/slashHandlers/statusline.ts`) |
| **`/report`** (aggregate of the active session spine) | shipped | `src/cli/commands/report.ts` (`buildSessionReport`), wired in `src/cli/slashCommands.ts`, test: `src/cli/commands/report.test.ts` |
| **Verify gates — principles** | shipped | `npm run verify:principles` → `scripts/verify-principles.mjs` |
| **Verify gates — OS jail** | shipped | `node scripts/verify-os-jail.mjs` (no npm alias yet), plus `tests/unit/cli-osJail.test.ts` |
| **Verify gates — council / versions** | shipped | `npm run verify:council` (`scripts/verify-council.mjs`), `npm run verify:versions` (`scripts/verify-versions.mjs`) |
| **Evidence gates at BUILD time** (`--strict-done`, mission strict) | shipped | `src/cli/kraken/verificationBridge.ts`, `src/cli/kraken/completionGate.ts`, `src/cli/headless/runOneTurn.strictExit.test.ts`, `src/cli/kraken/completionGate.gateFailure.test.ts` |
| **Mission mode** (`--mode zelari`, slices from `.zelari/plan.json`) | shipped | `src/cli/missionSlice.ts`, `src/cli/headless/missionE2e.smoke.test.ts` (`npm run smoke:mission`) |

## How to re-verify locally

```bash
npm run typecheck                                  # strict TS, whole CLI
npx vitest run src/cli/acp                         # ACP front door
npx vitest run src/cli/sessionSpine.test.ts        # session spine
npm run test:memory                                # memory V2 suite
npm run verify:principles                          # principles gate
node scripts/verify-os-jail.mjs                    # jail gate
```

Notes on reading the table:

- **Kill-switches are not "planned"**: an experimental row names its switch
  (e.g. `ZELARI_RUNAWAY_GUARD`) — the feature is on by default, the switch is
  the escape hatch.
- **A test file is evidence of a tested contract, not of a good idea.** Where a
  capability has no test yet, the cell says so.
- The ACP subset is intentionally smaller than the protocol: the implemented
  methods, the emitted updates and every non-goal are listed in the header of
  `src/cli/acp/protocol.ts` — that file is the contract.
