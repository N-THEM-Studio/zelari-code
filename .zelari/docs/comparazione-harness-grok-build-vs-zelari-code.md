---
kind: doc
id: comparazione-harness-grok-build-vs-zelari-code
date: 2026-07-16
tags: [comparison, harness, grok-build, design]
---
# Comparazione harness: Grok Build vs Zelari Code

> Design-phase · fonte pubblica README + user-guide grok-build + tree locale zelari-code  
> Licenze: Grok Build **Apache-2.0** (no contrib esterne) · Zelari **MIT**  
> **Regola:** ispirazione di *pattern/UX/architettura*, non copia letterale di codice.

## Executive summary

| Dimensione | Grok Build (`xai-org/grok-build`) | Zelari Code (`N-THEM-Studio/zelari-code`) |
|---|---|---|
| Stack | Rust monorepo (TUI + runtime nativo) | TypeScript/Node monorepo + Desktop Tauri |
| Identità | Single-agent coding harness enterprise-grade | **AI Council** multi-ruolo + agent singolo + missioni |
| Estensibilità | Plugins + marketplace + hooks lifecycle + skills | Skills + MCP + plugin registry (più leggero) + workspace tools |
| Sicurezza | Folder-trust, PreToolUse deny hooks, sandbox crate | Sandbox path, shell blocklist, SSH allowlist, plan/build phase gate |
| Contesto | Compaction avanzata, codebase-graph multi-lang, memory sperimentale | Compaction, checkpoint, semantic_search, AGENTS.MD, lessons/verification |
| Integrazione | **ACP** (Agent Client Protocol), headless JSON stream | Headless CLI, Desktop side-car, provider multipli |
| Differenziatori Zelari | — | Council 6 ruoli, evidence ladder, `.zelari/` vault, multi-provider, Desktop |

**Verdetto:** non “sostituire” Zelari con Grok. **Rubare selettivamente** i pezzi dove Grok è maturo (hooks lifecycle, trust, inspect, ACP, plugin packaging, session UX) e raddoppiare dove Zelari è unico (council + verification + multi-provider).

---

## Architettura a confronto

### Grok Build (layout)

| Crate / area | Ruolo |
|---|---|
| `xai-grok-pager` / `-bin` | TUI fullscreen (scrollback, prompt, modal, theme) |
| `xai-grok-shell` | Agent runtime + leader/stdio/headless |
| `xai-grok-tools` | Tool (file, terminal, search…) — port parziali da Codex/OpenCode |
| `xai-grok-workspace` | FS host, VCS, execution, **checkpoints** |
| `xai-acp-lib` | **Agent Client Protocol** per editor |
| `xai-codebase-graph` | Scope graph multi-lang (TS/JS/Rust/Go/Python) |
| `xai-fast-worktree` | Worktree isolati (overlay/btrfs CoW) |
| `xai-chat-state` | Stato conversazione + **compaction** massiccia |
| `xai-agent-lifecycle` | Lifecycle contributor model (session/turn) |

### Zelari Code (layout rilevante)

| Path | Ruolo |
|---|---|
| `packages/core` (`@zelari/core`) | AgentHarness, council, roles, skills, verification |
| `src/cli` | TUI Ink, slash, MCP, LSP, semantic, plugins, workspace |
| `src/cli/workspace` | `.zelari/` plan/docs/risks + postCouncilHook |
| `src/cli/checkpoint` | Checkpoint manager |
| `src/cli/compaction.ts` | Compaction contesto |
| `apps/desktop` | GUI Tauri su headless |
| `docs/TOOLS.md` | Mappa tool (builtin, phase, parallel batch) |

---

## Feature matrix (cosa “rubare”)

Legenda priorità: **P0** alto ROI · **P1** medio · **P2** nice-to-have / costoso · **SKIP** non allineato o già coperto meglio

| Feature Grok | Stato Zelari oggi | Priorità | Note adozione |
|---|---|---|---|
| **Lifecycle hooks** (`PreToolUse` block, `PostToolUse`, `SessionStart/End`, fail-open) | Solo React hooks + `postCouncilHook` council | **P0** | API JSON compatibile Claude/Cursor; matcher tool; deny esplicito |
| **Folder trust** (MCP/LSP/hooks gated) | Trust implicito / kill-switch env | **P0** | `~/.zelari-code/trusted_folders.toml` + `/trust` |
| **`zelari inspect`** (config, skills, MCP, hooks, plugins, rules) | `--doctor` parziale | **P0** | Un report unificato human+JSON |
| **Session fork / rewind** | Session JSONL + checkpoint | **P1** | UX `/fork` `/rewind` sulla session history |
| **Context usage `/context`** (breakdown token) | Budget token parziale | **P1** | Tabella system/messages/tools/skills/free |
| **Auto-compact @ N%** | Compaction esistente | **P1** | Threshold config + Pre/PostCompact hook |
| **Plugin package** (skills+commands+agents+hooks+MCP+LSP) | `plugins/` installer/registry | **P1** | Manifest convenzione + trust install |
| **Plugin marketplace** | Assente | **P2** | Dopo packaging; team marketplace git |
| **ACP (editor embed)** | Solo Desktop/headless | **P1** | Adapter stdio ACP → AgentHarness |
| **Codebase graph multi-lang** | AST TS + semantic embeddings | **P2** | Estendere AST/LSP; non riscrivere graph Rust |
| **Fast isolated worktree** | Branch manager | **P2** | git worktree semplice prima; CoW OS-specific dopo |
| **`/loop` scheduler** | Missione zelari loop | **P2** | Interval jobs leggeri headless |
| **`/goal` autonomous** | Mode zelari mission | **SKIP/P2** | Overlap con mission; unificare naming |
| **Permission auto-classifier** | always-approve / phase gates | **P1** | Mode `auto` per tool “safe” |
| **Compat Claude/Cursor skills+hooks** | Skills path parziali | **P1** | Scan opzionale `.claude` / `.cursor` |
| **Theming / vim mode TUI** | Brand TUI | **P2** | Dopo stabilità scrollback |
| **Memory flush/dream** | `memory/` + lessons | **P2** | Allineare naming; non duplicare lessons |
| **Ports tool Codex/OpenCode** | Toolset proprio maturo | **SKIP** | Già coperto; rischio licenza/noise |
| **Mermaid TUI** | Markdown stream | **P2** | Desktop first, TUI after |

---

## Cosa Zelari ha già meglio (non copiare)

1. **Council multi-agente** con ruoli, micro-gate, evidence ladder, honesty synthesis.
2. **Workspace knowledge** (plan batch, ADR, risks, AGENTS.MD auto-curation).
3. **Multi-provider** reale (xAI OAuth, OpenAI-compat, GLM, MiniMax, DeepSeek) + failover.
4. **Desktop** installabile + SSH targets.
5. **Parallel tool batch** read-only + barrier write/execute.
6. **Plan vs build phase** tool gating.
7. **NFR/verification** deterministica post-council.

---

## Rischi e vincoli

| Rischio | Mitigazione |
|---|---|
| Apache-2.0 vs MIT: no copy-paste codice | Solo pattern/API design; reimplement TS |
| Over-engineering (graph + CoW worktree) | P2 solo dopo P0/P1 |
| Hooks = RCE surface | Fail-open default; folder-trust obbligatorio su project hooks |
| Marketplace supply-chain | Install con `--trust` esplicito; no auto-run |
| Scope creep vs council roadmap v0.8/0.9 | Track separato “harness parity”; non bloccare verification |

---

## Definition of done (design-phase)

- [x] Matrice feature e priorità pubblicate
- [ ] ADR: hooks lifecycle + folder trust
- [ ] ADR: ACP adapter (opzionale v1)
- [ ] Piano fasi P0→P2 con acceptance testabili
- [ ] Nessuna dipendenza da binary `grok` o crate Rust in runtime Zelari

## Fonti

- https://github.com/xai-org/grok-build
- https://docs.x.ai/build/overview
- User guide: hooks, plugins, skills, slash, project rules (repo `crates/codegen/xai-grok-pager/docs/user-guide/`)
- Locale: `README.md`, `docs/TOOLS.md`, `packages/core`, `src/cli/*`
