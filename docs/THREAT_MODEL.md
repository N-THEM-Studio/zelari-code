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
| 1 | Prompt injection via **file content** (source, docs, issues) | Phase `plan` blocks project-mutating tools; sandbox confines FS tools to the project root; `ask` defaults for execute; provenance escalation (vector 13) when file content reaches EXECUTE args; human review in TUI | **Mitigated** (inherent LLM risk — see SECURITY.md scope) |
| 2 | Prompt injection via **web fetch / browser** output | `ZELARI_PERMISSION_NETWORK=ask` default; browser tool off via `ZELARI_BROWSER=0`; fetch output is read-only text; provenance escalation (vector 13) when web content reaches write/exec args | **Mitigated** |
| 3 | Prompt injection via **MCP server output** | MCP is opt-in; project-scoped `.zelari/mcp.json` loads **only for trusted folders** (untrusted is ignored); kill switch `ZELARI_MCP=0`; provenance escalation (vector 13) for mcp→write/exec | **Mitigated** (user-installed servers are trusted code by definition) |
| 4 | **Exfiltration via `ssh_run`** | Per-target command allowlist; **deterministic exfil-pattern guard (W3.2)**: even allowlisted commands matching egress patterns (curl/wget, nc/socat, `/dev/tcp`, scp/rsync/ssh hops, large base64 blobs) are denied unless the target sets `allowExfil` (deliberate P3 act); secrets never pasted in chat; kill switch `ZELARI_SSH=0` | **Guaranteed** (allowlist + pattern deny, unit-tested) |
| 5 | **Destructive shell** (`rm -rf`, force-push, …) | Shell blocklist at the choke-point; `ZELARI_PERMISSION_EXECUTE=ask` default; phase gate; confirmations for irreversible ops | **Mitigated** |
| 6 | **FS escape** outside the project root | Sandbox path resolution for filesystem tools (`src/cli/safety/`); writes outside root require trust/explicit config | **Guaranteed** (unit-tested resolution) |
| 7 | **Malicious lifecycle hooks** in an untrusted repo | Project-scoped hooks load only for trusted folders (`/trust`); hook failure mode is explicit: TUI fail-open with chip, autonomous runs (headless/mission/CI) **fail-closed**; `ZELARI_HOOKS_FAILURE=fail-open\|fail-closed` overrides | **Guaranteed** for project scope; user-global hooks are trusted by design |
| 8 | **Plugins / extensions** (Playwright, embeddings, …) | Opt-in only (`--plugins-install`, plugin gate); nothing heavy loads on a fresh clone; per-plugin prefs under the user home | **Guaranteed** (default-off) |
| 9 | **Secret leakage** into commits/chat | Secrets live under `~/.zelari-code/` (never in the repo); hooks/policies never echo key material; disclosure policy in SECURITY.md | **Mitigated** (convention + reviews) |
| 10 | **Silent auto-approval** in autonomous runs | `ZELARI_AUTO=1` promotes `ask→allow` **only** in headless/mission/Desktop surfaces and is surfaced in output; TUI keeps `ask` | **Mitigated** (declared, per P2 transparency) |
| 11 | **Eval/evolution Goodharting** (an artifact gaming its own measure) | Proposer/measurer separation: `JUDGE_PATHS` hard check in `verify-principles` (ADR-0036); sealed Tier-0 anchors (sha256 manifest, drift = gate red); LLM judgments cap at tier `claimed`; promotion requires deterministic gates + human decision (`evolveDecide`) | **Guaranteed** (mechanism, CI-enforced) |
| 12 | **Companion / Desktop IPC** | Local-only endpoints; tokens under user home; Desktop ships the same CLI safety defaults | **Mitigated** |
| 13 | **Non-user content steering write/execute args** (the injection payoff) | Provenance fingerprints at the choke-point (W3.1, `src/cli/safety/provenance.ts`): read/network/mcp tool results are ring-buffered; a write/execute tool whose args EMBED a fingerprint escalates `allow→ask` (web/mcp → write+exec, file → exec; file→write stays free — that is legitimate refactoring). Headless `ask` without a handler already fails closed. `ZELARI_PROVENANCE=0` opts out | **Mitigated** (deterministic, unit-tested) |

## Fresh clone / fresh install: what loads

| Surface | On a fresh clone, without any action | After explicit opt-in |
|---|---|---|
| Core tools (read/grep/list) | ✅ loaded (read-only) | — |
| Write/edit/execute tools | ✅ registered, but execute defaults to `ask`; phase `plan` blocks mutations | `--permissions yolo` / `ZELARI_PERMISSION_*=allow` / `ZELARI_AUTO=1` |
| Project MCP (`.zelari/mcp.json`) | ❌ ignored unless the folder is trusted | `/trust` |
| Project lifecycle hooks | ❌ ignored unless the folder is trusted | `/trust` |
| Plugins (Playwright/Chromium, embeddings) | ❌ not installed/loaded | `--plugins-install` |
| SSH targets | ❌ none configured | explicit target config + allowlist (+ `allowExfil` for egress patterns) |
| Browser automation | ❌ off | `ZELARI_BROWSER=1` context + plugin install |

## Permission presets (W3.3)

`--permissions strict|standard|yolo` (env `ZELARI_PERMISSION_PRESET`) changes
ONLY the per-category defaults — `standard` is the historical policy
(`read allow, write allow, execute ask, network ask`), `strict` tightens
(`write ask, network deny`), `yolo` allows everything by default. Env vars,
policy files and session grants win in both directions; a preset can never
bypass an explicit restriction.

## Residual risks (Open)

- A user who trusts a malicious folder gets that folder's hooks/MCP — trust is
  an explicit user act (P3); `/trust` prints exactly what it unlocks, hooks
  surface in the TUI chip, and autonomous runs fail closed. Keeping that UX
  deliberate stays an open requirement.
- Network egress by *allowed* package commands (npm install, git push) is not
  content-inspected: the blocklist, `ask` gates, the ssh exfil guard
  (vector 4) and the provenance escalation (vector 13) are the boundary;
  general egress inspection remains open.
- Provenance matching is substring-based: an attacker who *paraphrases*
  injected instructions instead of copying them is not caught (deterministic
  detection only — see vector 1/2/3 mitigations for the rest of the chain).

## Changes to this file

Threat model changes follow the ADR trail: security-relevant behavior changes
must update this matrix in the same PR (P2: promises == mechanism).
