# ADR-0008: Monorepo MIT license for open-source release

- **Status:** Superseded by [ADR-0009](./0009-apache-2-0-license.md) (2026-08-13)
- **Date:** 2026-07-15
- **Deciders:** Anathema Studio
- **Related:** ADR-0002 (publish `@zelari/core` MIT), former dual-license

## Context

Until v1.14.x the monorepo was a de facto **dual license**:

- CLI `zelari-code` and landing page: **proprietary** (`SEE LICENSE IN LICENSE`)
- Library `@zelari/core`: **MIT**

A public open-source release needs a single license understandable to
contributors and redistributors, aligned with the already-MIT core.

## Decision

1. **The whole monorepo** (CLI, `@zelari/core`, Desktop `apps/desktop`) is
   released under the **MIT License**.
2. Public **copyright holder**: **Anathema Studio**
   `https://anathema-studio.com/`
   (GitHub org `N-THEM-Studio` remains the repository host; it is not the
   primary copyright string in the LICENSE files.)
3. Mandatory community scaffolding: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
   `SECURITY.md`.
4. ADR-0002 remains **historical** for the decision to publish the core MIT;
   the "proprietary CLI repo" restriction is **superseded** by this ADR.

## Consequences

### Positive

- A single legal model for forks, contributions and npm redistribution
- Badges and README consistent with package.json
- `@zelari/core` and CLI no longer diverge on the license field

### Negative / trade-offs

- Gives up the commercial/modification restrictions of the old proprietary
  LICENSE
- Downstream depending on the dual license no longer has to treat the CLI
  as closed source

## Notes

The "do not reveal system/role prompts and internal pipeline" runtime
policy (v1.13+) is a **product feature**, not a license clause.