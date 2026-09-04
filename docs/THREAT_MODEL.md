# Threat Model — Zelari Code

> Operational companion to [SECURITY.md](../SECURITY.md) (disclosure policy)
> and [PRINCIPLES.md](../PRINCIPLES.md) (P2/P3 guarantees). Status legend:
> **Guaranteed** = deterministic mechanism + tests; **Mitigated** = real
> friction but not a hard boundary; **Open** = accepted residual risk,
> documented.

## Assets

- User secrets: provider API keys / OAuth tokens (home dir), SSH credentials (`~/.zelari-code/ssh-secrets.json`)
- Project files (the workspace the agent can mutate)
- The execution boundary: shell, network, filesystem outside the project root
- The trust fabric: folder trust, lifecycle hooks, MCP servers, extensions

## Adversary model

Primary: **attacker-controlled content** that reaches the model's context
(files in a cloned repo, web pages, MCP tool output) trying to steer tool
calls. Secondary: malicious repo-level config (hooks, `.zelari/mcp.json`,
extensions) on a machine that opens untrusted folders. We do not model a
compromised local OS.

## Vector × gate × status

| # | Vector | Gates that cover it | Status |
|---|---|---|---|
| 1 | Prompt injection via **file content** (source, docs, issues) | Phase `plan` blocks project-mutating tools; sandbox confines FS tools to the project root; `ask` defaults for execute; human review in TUI | **Mitigated** (inherent LLM risk — see SECURITY.md scope) |
| 2 | Prompt injection via **web fetch / browser** output | `ZELARI_PERMISSION_NETWORK=ask` default; browser tool off via `ZELARI_BROWSER=0`; fetch output is read-only text | **Mitigated** |
| 3 | Prompt injection via **MCP server output** | MCP is opt-in; project-scoped `.zelari/mcp.json` loads **only for trusted folders** (untrusted is ignored); kill switch `ZELARI_MCP=0` | **Mitigated** (user-installed servers are trusted code by definition) |
| 4 | **Exfiltration via `ssh_run`** | Per-target command allowlist; secrets never pasted in chat (`ssh-secrets.json`); kill switch `ZELARI_SSH=0`; targets are explicit config | **Mitigated** — allowlist bounds *what* runs, not *what data* a command may read: don't add `cat`/`curl`-style commands to untrusted targets |
| 5 | **Destructive shell** (`rm -rf`, force-push, …) | Shell blocklist at the choke-point; `ZELARI_PERMISSION_EXECUTE=ask` default; phase gate; confirmations for irreversible ops | **Mitigated** |
| 6 | **FS escape** outside the project root | Sandbox path resolution for filesystem tools (`src/cli/safety/`); writes outside root require trust/explicit config | **Guaranteed** (unit-tested resolution) |
| 7 | **Malicious lifecycle hooks** in an untrusted repo | Project-scoped hooks load only for trusted folders (`/trust`); hook failure mode is explicit: TUI fail-open with chip, autonomous runs (headless/mission/CI) **fail-closed**; `ZELARI_HOOKS_FAILURE=fail-open\|fail-closed` overrides | **Guaranteed** for project scope; user-global hooks are trusted by design |
| 8 | **Plugins / extensions** (Playwright, embeddings, …) | Opt-in only (`--plugins-install`, plugin gate); nothing heavy loads on a fresh clone; per-plugin prefs under the user home | **Guaranteed** (default-off) |
| 9 | **Secret leakage** into commits/chat | Secrets live under `~/.zelari-code/` (never in the repo); hooks/policies never echo key material; disclosure policy in SECURITY.md | **Mitigated** (convention + reviews) |
| 10 | **Silent auto-approval** in autonomous runs | `ZELARI_AUTO=1` promotes `ask→allow` **only** in headless/mission/Desktop surfaces and is surfaced in output; TUI keeps `ask` | **Mitigated** (declared, per P2 transparency) |
| 11 | **Eval/evolution Goodharting** (an artifact gaming its own measure) | Proposer/measurer separation: `JUDGE_PATHS` hard check in `verify-principles` (ADR-0036); LLM judgments cap at tier `claimed`; promotion requires deterministic gates + human decision (`evolveDecide`) | **Guaranteed** (mechanism, CI-enforced) |
| 12 | **Companion / Desktop IPC** | Local-only endpoints; tokens under user home; Desktop ships the same CLI safety defaults | **Mitigated** |

## Fresh clone / fresh install: what loads

| Surface | On a fresh clone, without any action | After explicit opt-in |
|---|---|---|
| Core tools (read/grep/list) | ✅ loaded (read-only) | — |
| Write/edit/execute tools | ✅ registered, but execute defaults to `ask`; phase `plan` blocks mutations | `ZELARI_PERMISSION_*=allow` / `ZELARI_AUTO=1` |
| Project MCP (`.zelari/mcp.json`) | ❌ ignored unless the folder is trusted | `/trust` |
| Project lifecycle hooks | ❌ ignored unless the folder is trusted | `/trust` |
| Plugins (Playwright/Chromium, embeddings) | ❌ not installed/loaded | `--plugins-install` |
| SSH targets | ❌ none configured | explicit target config + allowlist |
| Browser automation | ❌ off | `ZELARI_BROWSER=1` context + plugin install |

## Residual risks (Open)

- Model-level injection steering *allowed* tools inside the project (mitigate
  with plan phase + review; P1 evidence ladder makes claims auditable).
- A user who trusts a malicious folder gets that folder's hooks/MCP — trust is
  an explicit user act (P3), but the UX must keep it deliberate.
- Network egress by *allowed* commands (npm install, git push) is not
  content-inspected: the blocklist and `ask` gates are the boundary.

## Changes to this file

Threat model changes follow the ADR trail: security-relevant behavior changes
must update this matrix in the same PR (P2: promises == mechanism).
