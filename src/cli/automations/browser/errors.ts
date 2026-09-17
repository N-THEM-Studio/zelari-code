/**
 * automations/browser/errors.ts — typed errors shared by every browser publisher
 * (F3.2 X, F3.3 Facebook).
 *
 * Kept in a leaf module (no imports) so the X and Facebook composer flows can
 * throw the SAME typed errors with no circular dependency, and so the runner has
 * one source of truth for the ReloginRequiredError → `relogin_required`/exit 4
 * mapping. `composer.ts` and `publisher.ts` re-export these for back-compat.
 */

/** Thrown when the profile is not logged in — the run is unproven, not failed. */
export class ReloginRequiredError extends Error {
  readonly channel: string;
  constructor(channel: string) {
    super(`relogin_required: ${channel} session is not logged in`);
    this.name = 'ReloginRequiredError';
    this.channel = channel;
  }
}

/** Thrown on a failing composer step; `step` names exactly what broke. */
export class PublishStepError extends Error {
  readonly step: string;
  constructor(step: string, message: string) {
    super(`${step}: ${message}`);
    this.name = 'PublishStepError';
    this.step = step;
  }
}
