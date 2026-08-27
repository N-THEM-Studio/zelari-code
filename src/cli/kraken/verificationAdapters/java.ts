/**
 * verificationAdapters/java — JVM builds: Gradle and Maven (P1.A2 / t24).
 *
 * Ecosystem ownership: Gradle roots (wrapper script, build.gradle[.kts],
 * settings.gradle[.kts]) and Maven roots (pom.xml). Gradle WINS over Maven
 * when markers coexist: the wrapper scores above pom.xml, and the remaining
 * tie (build.gradle 3 vs pom.xml 3) is resolved gradle-first inside
 * buildPlan — detect's single score cannot express within-root precedence.
 *
 * Detect scores (highest present marker wins): gradlew / gradlew.bat = 4
 * (a project-local toolchain is the strongest evidence), build.gradle /
 * build.gradle.kts = 3, pom.xml = 3, settings.gradle[.kts] = 2. No markers
 * → 0.
 *
 * Honest-unknown rule: Java has NO standalone typecheck verb — compilation
 * is inlined into `gradle build` / the Maven lifecycle — so the typecheck
 * slot binds null (dropped downstream) instead of a fabricated command that
 * would misreport a missing tool as `fail`.
 *
 * Wrapper resolution: `./gradlew <verb>` on non-win32 when the `gradlew`
 * file exists, `gradlew.bat <verb>` on win32 when the wrapper batch file
 * exists, else bare `gradle <verb>` (PATH invocation). `platform` is
 * injectable in gradleCommand (default process.platform) so both namings
 * stay deterministically testable on any host.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { NativePackCommands, VerificationAdapter } from './types.js';

/** Tiny fs helpers stay LOCAL per adapter (shared utils would couple sibling adapters). */
async function fileExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** Gradle markers, strongest first (see header). */
const GRADLE_MARKERS: ReadonlyArray<readonly [marker: string, score: number]> = [
  ['gradlew', 4],
  ['gradlew.bat', 4],
  ['build.gradle', 3],
  ['build.gradle.kts', 3],
  ['settings.gradle', 2],
  ['settings.gradle.kts', 2],
];

/** Full detection set: every gradle marker plus Maven's pom.xml (3). */
const DETECT_MARKERS: ReadonlyArray<readonly [marker: string, score: number]> = [
  ...GRADLE_MARKERS,
  ['pom.xml', 3],
];

async function hasGradleMarker(root: string): Promise<boolean> {
  for (const [marker] of GRADLE_MARKERS) {
    if (await fileExists(path.join(root, marker))) return true;
  }
  return false;
}

/**
 * Gradle invocation for `verb` at `root`: the platform-appropriate wrapper
 * when its file exists, else bare `gradle` (PATH). Exported (unlike sibling
 * helpers) so tests can drive BOTH platform branches deterministically;
 * buildPlan passes process.platform.
 */
export async function gradleCommand(
  root: string,
  verb: 'test' | 'build',
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const wrapper = platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  if (await fileExists(path.join(root, wrapper))) {
    return platform === 'win32' ? `gradlew.bat ${verb}` : `./gradlew ${verb}`;
  }
  return `gradle ${verb}`;
}

export const javaAdapter: VerificationAdapter = {
  async detect(root: string): Promise<number> {
    let best = 0;
    for (const [marker, score] of DETECT_MARKERS) {
      if (score > best && (await fileExists(path.join(root, marker)))) best = score;
    }
    return best;
  },

  async buildPlan(root: string): Promise<NativePackCommands> {
    // Gradle-first precedence — see header. detect cannot encode the
    // build.gradle(3) vs pom.xml(3) tie, so buildPlan decides.
    if (await hasGradleMarker(root)) {
      return {
        typecheckCommand: null, // no standalone verb — honest absence
        testCommand: await gradleCommand(root, 'test'),
        buildCommand: await gradleCommand(root, 'build'),
      };
    }
    if (await fileExists(path.join(root, 'pom.xml'))) {
      return {
        typecheckCommand: null, // compilation rides the test/package lifecycle
        testCommand: 'mvn test',
        buildCommand: 'mvn package',
      };
    }
    // Defensive (the registry never calls buildPlan on a 0-score root):
    // all-null, never fabricated.
    return { typecheckCommand: null, testCommand: null, buildCommand: null };
  },
};
