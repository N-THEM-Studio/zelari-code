import { taskMatchesNfrKeywords } from './extractTaskScope.js';

/**
 * Soft design-phase check: warn when Nettuno plans motion/perf/budget work
 * but does not emit createNfrSpec. No forced retry in v0.9.1.
 */
export function warnIfNfrSpecMissing(
  memberId: string,
  userMessage: string,
  emittedToolNames: string[],
  planText?: string,
): boolean {
  if (memberId !== 'nettun') return false;
  if (!taskMatchesNfrKeywords(userMessage, planText)) return false;
  const count = emittedToolNames.filter((n) => n === 'createNfrSpec').length;
  if (count >= 1) return false;

  // eslint-disable-next-line no-console
  console.warn(
    '[council] member "nettun" did not emit createNfrSpec for an NFR-heavy task ' +
      '(motion/perf/budget keywords detected). Implementation will fall back to ' +
      'DEFAULT_NFR_SPEC until .zelari/nfr-spec.json exists. Emit createNfrSpec in ' +
      'design-phase when constraints are measurable.',
  );
  return true;
}
