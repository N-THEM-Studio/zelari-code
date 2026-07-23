# ADR-0015 — Opt-in companion host (`zelari-code serve`)

**Status:** accepted  
**Date:** 2026-07-23

## Context

We want an Android (or web) companion that works *like* Zelari Desktop: chat,
mode/phase, streaming agent events — while the agent still runs on a
development machine with the real repo, keys, tools, and MCP.

Desktop today spawns `zelari-code --headless` locally and streams NDJSON
BrainEvents. Remote clients need the same contract over the network
(Tailscale / LAN).

ADR-0014 rejected embedding a always-on **scheduler** daemon for cron/webhooks.
A companion host is a different product surface: **explicit opt-in remote control**,
not background mission scheduling.

## Decision

Introduce **`zelari-code serve`**:

- Opt-in only (never starts at install; user must run the command).
- HTTP API + SSE event stream reusing headless NDJSON semantics.
- Auth: bearer token in `~/.zelari-code/companion.token`.
- Sandbox: project path allowlist (`companion.json` + `--project`).
- Default bind `127.0.0.1`; Tailscale users pass `--bind 100.x.y.z`.
- Runs: single-flight child `--headless` (same as Desktop).

## Consequences

**Positive**

- Android / PWA clients can attach without shipping Node on the phone.
- Reuses headless + Desktop event contract.
- Clear security boundary (token + allowlist + bind).

**Negative / residual**

- Always-on process while serve is running (user-managed).
- Spawning a full CLI child per run is heavier than in-process; acceptable for MVP.
- Interactive permission prompts remain auto-allow like headless Desktop.

## Alternatives rejected

1. Full agent on Android — impractical (tools, cwd, keys).
2. SSH-only remote shell — no product UX, no structured events.
3. Bind `0.0.0.0` by default — unsafe without Tailscale/firewall discipline.
