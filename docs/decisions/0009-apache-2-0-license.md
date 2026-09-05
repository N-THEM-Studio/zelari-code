# ADR-0009: Apache-2.0 license for the whole monorepo

- **Status:** Accepted
- **Date:** 2026-08-13
- **Deciders:** Andrea (first-principles governance session)
- **Related:** ADR-0008 (monorepo MIT, superseded), ADR-0002 (core MIT), ADR-0010 (first principles)

## Context

ADR-0008 moved the whole monorepo to MIT (2026-07-15). During the first
principles governance session (ADR-0010) a tension emerged between the
secrecy policy ("product IP is proprietary and confidential") and a fully
public repository: the policy protects the in-session experience (model
refusals), it cannot protect the code, which is already public.

It was decided to:

- reformulate the secrecy policy as **"open runtime, protected experience"**;
- move the whole product from MIT to **Apache-2.0**, to add the explicit
  patent grant and trademark norms, better suited to a commercially
  exposed product and a contributor ecosystem.

## Decision

1. **The whole monorepo** (CLI `zelari-code`, `@zelari/core`, Desktop
   `apps/desktop`, Companion Android) is released under the **Apache
   License 2.0** (SPDX `Apache-2.0`).
2. `LICENSE` replaced with the canonical Apache-2.0 text; `license`
   fields updated in `package.json` (root, `packages/core`,
   `apps/desktop`) and in the root lockfile; README, docs and
   CONTRIBUTING aligned.
3. Copyright holder: **Anathema Studio** - https://anathema-studio.com/.
4. Third-party pattern attributions (OpenMausBot, diff, etc.) remain
   intact.
5. The secrecy policy remains active as protection of the **in-session
   experience** (not a claim of ownership over the code): wording
   updated without weakening the hard rules (refusal, scrub, marker
   unchanged).

## Consequences

- Contributors: contributions are under Apache-2.0 (CONTRIBUTING updated).
- Redistribution: attribution/NOTICE obligations and patent grant;
  consumers must include the license.
- ADR-0008 moves to **Superseded** (remains as the historical
  dual-license -> MIT step).
- Future: evaluate a `NOTICE` file for relevant attributions.