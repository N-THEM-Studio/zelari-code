# Zelari Code — Guide (EN)

> Open-source coding orchestrator — **you choose the model, the proof is mandatory.**
> Kraken by default, council when the work earns it.

This is the English guide. It covers everything you need to install, start, and
read the UI contract. The deepest reference (every slash command, skills, MCP,
Desktop, headless) is [`GUIDA.md`](./GUIDA.md); the two guides are
kept in sync release by release.

---

## 1. What Zelari is (and is not)

**Zelari Code is the agent that doesn't trust itself.** It plans, builds, and
**proves**. "Done" means *verified*, not *claimed*:

- **P1 — Verifiability.** Done ≠ convincing text. A pass without evidence is
  not a pass (`unknown ≠ pass`).
- **P2 — Deterministic control.** Permissions, phases, sandboxing and policy
  are code, never "the model being careful".
- **P3 — Sovereignty.** You decide *what*; the system forbids *dangerous how*.
  Everything is visible, including rules that are declared rather than enforced.
- **P4 — Open runtime.** The in-session experience is the value; no lock-in.
  The runtime is [`@zelari/core`](https://www.npmjs.com/package/@zelari/core), Apache-2.0.
- **P5 — Lightness.** The UI can be rich; the core cannot.
- **P6 — The right orchestration.** Kraken / council / mission are *sizes*,
  not religions.

Full principles: [`PRINCIPLES.md`](../PRINCIPLES.md).

## 2. Install

```bash
npm install -g zelari-code
zelari-code
```

Requirements: **Node ≥ 24**, npm ≥ 11.7, and one of xAI Grok, ChatGPT,
Anthropic, OpenAI-compatible, GLM/Z.AI, MiniMax, DeepSeek. On Windows, Git Bash
is auto-detected and recommended. First run opens a setup wizard (skip with
`--no-wizard`).

## 3. First run — two decisions, then the doctor

The wizard asks for the essentials: **engine** (provider + default model) and
**access** (API key via env var, local key store, or later `/login`). That's it.
Everything else has a command inside the app.

Then make the doctor your first screen:

```bash
zelari-code --doctor
```

It checks Node, the install, PATH, the agent shell, **the active provider's key
or OAuth token**, and **folder trust** — and ends with a plain verdict:
`✔ all checks passed — ready to build`. If something is red, each row tells you
the exact command that fixes it.

## 4. The gesture: plan → build → proof

You don't have to learn three philosophies. There is one gesture:

1. **Plan.** Switch to plan phase (`shift+tab` cycles phase when supported, or
   use the phase chip): the agent designs, reads, and writes a plan — and
   **cannot write project files**.
2. **Build.** Switch to build: the agent writes. When a build turn finishes,
   the **strict gate** evaluates the evidence. It can only *add* blockers,
   never remove them: a "done" without proof does not pass.
3. **Proof.** The verdict is a session state you can see (next section), and a
   completion proof is written for the turn.

If the gate is not satisfied, Zelari says **RIPARA** (repair) and runs an
automatic repair pass — or **BLOCCATO** (blocked) when the completion policy
hard-stops the turn. You will always see *why*: which criteria are missing
evidence.

Council and missions are the same gesture at larger sizes: `/council` for a
second opinion on architecture, `/zelari` for autonomous missions that loop
until the deliverable is *proven* done.

## 5. Reading the status bar — the four chips

The bottom status line is the contract, always visible:

| Chip | Meaning |
|---|---|
| **Fase** — `◇ plan` / `◆ build` | Phase gate. In plan, writes are blocked. |
| **Modo** — `kraken` / `council` / `zelari` | Dispatch size (P6). Default: kraken. |
| **Verifica** — `prova: PASS / RIPARA / BLOCCATO` | Last strict-gate verdict for the session. No chip yet = no verdict observed yet (we don't fake one). |
| **Permessi** — `scrive: …` | What the agent may write right now, honestly declared — including `senza prova (dichiarato)` if you opted out of strict done. |

When Kraken delegates, live tentacles appear as
`✓ Ricognizione "map auth code"` / `✓ Scrittura "login.ts"` /
`✓ Verifica "test:auth"` — the trade first, the mythology in the logs.

## 6. Permissions, trust, and honesty

- **Folder trust.** Project-level MCP servers, hooks, and extensions load only
  when the folder is trusted: `zelari-code --trust <path>` (or `/trust` inside
  the app). The doctor tells you if the current folder isn't.
- **Fail-open is declared, never hidden.** If a safety rule is advisory rather
  than enforced, the UI says so. We do not look safer than we are.
- **Strict done.** On by default: a build turn cannot claim completion without
  evidence. Opt out explicitly with `ZELARI_STRICT_DONE=0` — the status bar
  will then *say* proof is off.

## 7. Providers and login

`/provider` picks the engine, `/model` picks the model, `/provider custom <url>`
points at self-hosted endpoints (Ollama, LM Studio, vLLM). OAuth:
`/login grok`, `/login chatgpt`, `/login anthropic` — or
`/login <provider> <key>` for API keys. `/provider <name> status` shows key
source and token expiry.

## 8. Where to go next

- [`GUIDA.md`](./GUIDA.md) — the full guide (IT): slash commands, skills,
  workspace, sessions, headless/serve, MCP, Desktop.
- [`TOOLS.md`](./TOOLS.md) — tool and skill map.
- [`CHANGELOG.md`](../CHANGELOG.md) — release notes, written for humans.
- [`PRINCIPLES.md`](../PRINCIPLES.md) — the six principles every PR must cite.

---

*Zelari Code — maintained by [Anathema Studio](https://anathema-studio.com/),
Apache-2.0.*
