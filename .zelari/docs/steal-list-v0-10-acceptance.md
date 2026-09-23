---
kind: doc
id: steal-list-v0-10-acceptance
date: 2026-07-16
tags: [acceptance, v0.10, steal-list, harness, security]
---
# Steal list + Acceptance — Zelari v0.10.0 (Grok Build parity selettiva)

> Lucifero · 2026-07-16 · pattern only (Apache-2.0 → MIT)  
> Build-on: synthesis, Minosse risks, Nettuno wiring, Plutone UX map

## Steal list (cosa adottare)

### P0 — Must ship

| ID | Steal | Comportamento atteso | Non fare |
|---|---|---|---|
| S1 | Lifecycle hooks | PreToolUse può **deny** con JSON `{decision:"deny",reason}`; crash/timeout → **allow + FAIL-OPEN audit** | `updatedInput` mutante; HTTP auth; Subagent* |
| S2 | Folder trust | Project hooks/MCP solo se cwd in `trusted_folders.toml` | Auto-trust silenzioso; store parallelo Desktop |
| S3 | `/inspect` | Report runtime (hooks, mcp, skills, plugins, trust, phase); `--json` schema `version` | Fondere con `doctor` (install-only) |

### P0.5

| ID | Steal | Comportamento |
|---|---|---|
| S4 | Desktop X-Ray + TrustBadge | Stesso JSON inspect; badge 🔒/⚠ da trust store unico |
| S5 | SECURITY + tests | Documentare RCE hooks; test untrusted zero-spawn |

### P1 — Should (capacity)

| ID | Steal | De-risk |
|---|---|---|
| S6 | `/fork` `/rewind` | Rewind = transcript only (≠ tree restore) |
| S7 | `/context` | Breakdown token; soglie 70/85 |
| S8 | Capability Pack v1 | Manifesto locale read-only |
| S9 | Compat `.claude`/`.cursor` paths | Opt-in config |

### P2 — Explicit backlog (not v0.10)

ACP · worktree CoW · `/loop` · marketplace · mode auto · graph Rust · tool Codex ports

---

## Acceptance criteria (ship gate v0.10.0)

### A. Hooks + invoke path

- [ ] Esiste `LifecycleHookRunner` in core; no-op default se assente  
- [ ] `ToolRegistry.invoke` chiama PreToolUse **dopo** phase/blocklist/sandbox e **prima** di `tool.execute`  
- [ ] Deny → nessun `execute`; reason propagata a TUI (`DENY: tool — reason`)  
- [ ] Crash/timeout/JSON invalido → execute prosegue + log/chip `FAIL-OPEN`  
- [ ] Timeout default ≤ 5000 ms (`ZELARI_HOOK_TIMEOUT_MS`)  
- [ ] Matcher normalizza alias tool (`Bash`→`bash`, ecc.)  
- [ ] Project hook `command` **non** viene spawnato se `!isTrusted(cwd)` (test automatico)  
- [ ] Allowlist path eseguibile documentata; preferire `spawn(argv)` non shell string  

### B. Folder trust

- [ ] File `~/.zelari-code/trusted_folders.toml` (o path Windows equivalente documentato)  
- [ ] `/trust list|add|remove` funziona; `--trust` CLI all’avvio  
- [ ] Path canonicalize (realpath / resolve; case-insensitive drive letter su Windows)  
- [ ] Untrusted: project `.zelari/mcp.json` entries non mergeate (o prompt one-shot)  
- [ ] Kill-switch `ZELARI_FOLDER_TRUST=0` documentato come **dev only** in SECURITY.md  

### C. Inspect

- [ ] `/inspect` e `zelari-code inspect` (o equivalente CLI) ≠ output di `doctor`  
- [ ] Sezioni minime: trust, hooks, mcp, skills, plugins, phase/mode  
- [ ] `--json` con campo `version` stabile per CI  
- [ ] Desktop X-Ray (se shippato in 0.10) mostra le stesse sezioni  

### D. Security docs & tests

- [ ] SECURITY.md elenca: lifecycle hooks come superficie RCE, folder trust, kill-switch, reporting  
- [ ] Vitest: deny, fail-open, untrusted no-spawn, (opz.) symlink escape trust  
- [ ] Nessun import/crate da grok-build nel lockfile  

### E. Explicit non-regression

- [ ] Council roadmap non bloccata (hooks non cambiano micro-gate verification)  
- [ ] Plan phase gate e shell blocklist restano attivi **prima** di PreToolUse  
- [ ] Checkpoint manager invariato; `/rewind` se presente non lo sostituisce silenziosamente  

---

## QA scenarios (manual)

### QA-1 Trust gate
1. Apri repo senza entry trust.  
2. Verifica: nessun project hook eseguito; MCP project assente o prompt.  
3. `/trust add .` → riapri → project hooks/MCP ok.  
4. `/inspect` mostra `trusted: true`.

### QA-2 PreToolUse deny
1. Hook user che denya `bash` con reason test.  
2. Chiedi all’agent un comando shell.  
3. Atteso: DENY chip + tool non eseguito.

### QA-3 Fail-open
1. Hook che esce 1 senza JSON / sleep > timeout.  
2. Tool “safe” read-only deve completare.  
3. Atteso: chip FAIL-OPEN + audit.

### QA-4 Inspect ≠ doctor
1. `doctor` → solo install/PATH.  
2. `inspect --json` → runtime sezioni.  
3. Nessuna sovrapposizione confusa in help.

### QA-5 Rewind copy (P1)
1. `/rewind 1`  
2. Messaggio UI: “solo transcript, non filesystem”.  
3. File su disco invariati.

---

## Ordine implementativo consigliato

1. Interfaccia + runner no-op + test core  
2. Trust store + gate MCP/hooks  
3. Wire `registry.invoke` + Session*  
4. `/inspect` + `/trust`  
5. SECURITY + test suite  
6. Desktop badge/X-Ray  
7. P1 session/context/pack  

## Related

- [[synthesis-grok-build-vs-zelari-v0-10]]  
- [[architettura-hooks-su-agentharness-folder-trust]]  
- [[risks]]  
- [[001-adr-lifecycle-hooks-folder-trust-ispirati-a-grok-build]]  
