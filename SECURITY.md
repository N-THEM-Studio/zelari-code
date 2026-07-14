# Security Policy

**Zelari Code** is maintained by [Anathema Studio](https://anathema-studio.com/).

## Supported versions

Security fixes are applied on the latest published release line on npm
(`zelari-code` / `@zelari/core`). Please upgrade before reporting issues that
may already be fixed in a newer version.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security-sensitive reports**
(especially if they include API keys, tokens, or paths to private data).

Prefer:

1. **GitHub Security Advisories** on
   [N-THEM-Studio/zelari-code](https://github.com/N-THEM-Studio/zelari-code/security/advisories/new)
   (private disclosure), or
2. Contact via [anathema-studio.com](https://anathema-studio.com/) if advisories
   are unavailable.

Include:

- Affected version(s) and install method (`npm`, Desktop, monorepo)
- OS and Node version
- Clear reproduction steps
- Impact assessment (RCE, path escape, secret leak, etc.)

We aim to acknowledge reports within a reasonable time and will coordinate a
fix release when appropriate.

## What is in scope

- Sandbox path escapes outside the project root for filesystem tools
- Shell blocklist bypasses that enable clearly dangerous commands by default
- Hardcoded secrets or credential leakage in shipped packages
- Unsafe deserialization or path traversal in CLI config loaders
- Desktop updater / installer issues that enable code execution without user consent

## What is out of scope (typical)

- **Model / prompt injection** that relies on the LLM choosing to call tools
  with attacker-controlled content (inherent agent risk; mitigate with phase
  `plan`, sandbox, and human review)
- Vulnerabilities only present in **optional** user-installed MCP servers or
  language servers
- Issues in third-party provider APIs (OpenAI-compatible endpoints, etc.)
- Denial of service via intentional huge model contexts or unbounded user tasks
  without a clear bug in resource limits

## Safe configuration notes

- API keys live under `~/.tmp/zelari-code/` (and related env overrides) — never
  commit them
- SSH secrets: `~/.zelari-code/ssh-secrets.json` (never paste into chat)
- Kill switches: `ZELARI_SSH=0`, `ZELARI_MCP=0`, `ZELARI_BROWSER=0`, etc.
- Plan phase (`/plan` or `--phase plan`) blocks project-mutating tools

## Disclosure preference

Coordinated disclosure: please allow time for a fix before public write-ups.
We appreciate responsible researchers and will credit them if desired.
