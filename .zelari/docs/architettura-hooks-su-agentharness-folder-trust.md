---
kind: doc
id: architettura-hooks-su-agentharness-folder-trust
date: 2026-07-16
tags: [hooks, trust, harness, v0.10, nettuno]
---
# Architettura: Lifecycle hooks + Folder trust (Nettuno)

> Build-on: Caronte (steal list P0–P2, ADR 001) · Gerione (gap inventory, journey/IA).  
> Milestone: **v0.10.0** · Piano raffinato con `createPlan` (fileRefs su path reali).

## Dove agganciare (wiring)

| Evento | Punti di aggancio | Note |
|---|---|---|
| **PreToolUse** (blocking) | `ToolRegistry.invoke` **prima** di `tool.execute` (`packages/core/src/core/tools/registry.ts` ~L112–175) | Un solo choke-point: copre native tools + path `invokeOne` in `AgentHarness` (~L324–385). Deny → `typedErr(reason)` senza execute. |
| **PostToolUse / Failure** | Stesso `invoke` nel `try/catch` **dopo** execute | Non blocking; fail-open. |
| **SessionStart / End** | `useChatTurn.ts`, `runHeadless.ts` (bootstrap/teardown CLI) | Core resta free di I/O filesystem hooks se runner iniettato. |
| **UserPromptSubmit** | Ingresso `dispatchPrompt` / headless task | Opzionale v1; matcher prompt. |
| **Pre/PostCompact** | `historyCompaction.ts` / `tokenBudget.ts` | Dopo P0 tool hooks. |

**Iniezione:** `AgentHarnessConfig` o `InvokeOptions` espongono `hooks?: LifecycleHookRunner` (interfaccia in core; implementazione discovery in CLI) → council e single-agent condividono il gate.

## Contratto runner (TS)

```ts
type HookDecision = { decision?: 'allow' | 'deny'; reason?: string; updatedInput?: unknown };

interface HookEvent {
  type: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'SessionStart' | 'SessionEnd'
    | 'UserPromptSubmit' | 'Stop' | 'PreCompact' | 'PostCompact';
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  sessionId: string;
  cwd: string;
}

interface LifecycleHookRunner {
  run(event: HookEvent, signal?: AbortSignal): Promise<HookDecision>;
}
```

- **Fail-open:** crash, timeout, JSON invalido, exit ≠0 senza `decision:deny` → allow + audit log.
- **Deny solo esplicito:** `{ "decision": "deny", "reason": "…" }`.
- **Matcher:** regex su tool name; normalizzare con stessa mappa alias di `TOOL_NAME_ALIASES` (`Bash`/`shell` → `bash`).
- **Transport v1:** `command` (stdin JSON event → stdout JSON decision); `http` POST opzionale.
- **Timeout default:** 5s (env `ZELARI_HOOK_TIMEOUT_MS`).

## Discovery & trust

```
~/.zelari-code/hooks/*.json     → sempre trusted (user)
<project>/.zelari/hooks/*.json  → solo se isTrusted(cwd)
~/.zelari-code/trusted_folders.toml
```

Gate unico (stesso predicate):

1. Project MCP: `readMcpConfig` oggi merge user+project (`mcpManager.ts` L50–70) → **filtrare** entry da `.zelari/mcp.json` se untrusted.
2. Project hooks: skip load se untrusted.
3. Future project LSP: stesso gate.

Kill-switch: `ZELARI_FOLDER_TRUST=0` (dev only). CLI: `--trust`, slash `/trust list|add|remove`.

## `inspect` vs `doctor`

| | doctor | inspect |
|---|---|---|
| Scope | Install: bin, Node, bundle, PATH | Runtime: trust, hooks, MCP, skills, plugins, budget, phase/mode |
| Path | `src/cli/utils/doctor.ts` | Nuovo modulo + slash `/inspect` |
| Output | human CI-friendly | human + `--json` schema versioned |

## Non-goals v1 (confermati)

- Marketplace hooks; SubagentStart/Stop; HTTP auth enterprise.
- Copia codice Grok (Apache-2.0): solo pattern.
- Graph Rust, CoW btrfs, port tool Codex.

## Sequenza implementativa consigliata

1. Interfaccia + runner no-op in core + test deny/fail-open.  
2. CLI discovery + trust store + gate MCP.  
3. Wire `invoke` + Session* + audit.  
4. `/inspect` + `/trust`.  
5. P1 session/context/pack; P2 ACP/worktree/loop experimental.

## Handoff

- **Plutone:** slash UX `/trust` `/inspect` `/fork` `/rewind` `/context` + Desktop X-Ray (token `color.trust.*`).  
- **Minosse:** RCE command hooks, supply-chain pack, scope vs council 0.8/0.9.  
- **Lucifero:** steal-list prioritizzata + acceptance ship v0.10.0 da milestone plan.

## Related

- [[001-adr-lifecycle-hooks-folder-trust-ispirati-a-grok-build]]
- [[comparazione-harness-grok-build-vs-zelari-code]]
- [[information-architecture]]
