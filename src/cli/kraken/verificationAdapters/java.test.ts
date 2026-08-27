/**
 * verificationAdapters/java tests — P1.A2 (t24): Gradle/Maven detection
 * scores, gradle-over-maven precedence, wrapper/platform naming, and the
 * honest-null typecheck slot.
 *
 * Fixtures are real tmpdir trees (win32-safe: path.join, no bash-isms).
 * Platform branches are driven deterministically through the exported
 * gradleCommand helper (platform injected); buildPlan tests assert the HOST
 * branch via process.platform with both wrapper files present.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { javaAdapter, resolveAdapterForRoot } from './index.js';
import { gradleCommand } from './java.js';

let roots: string[] = [];
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots = [];
});

async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'zelari-java-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, name), content, 'utf-8');
  }
  return root;
}

describe('java adapter — detect scoring', () => {
  it.each([
    ['gradlew', 4],
    ['gradlew.bat', 4],
    ['build.gradle', 3],
    ['build.gradle.kts', 3],
    ['pom.xml', 3],
    ['settings.gradle', 2],
    ['settings.gradle.kts', 2],
  ])('%s → %s', async (marker, score) => {
    expect(await javaAdapter.detect(await makeRepo({ [marker]: '' }))).toBe(score);
  });

  it('empty directory → 0; foreign ecosystems stay unclaimed', async () => {
    expect(await javaAdapter.detect(await makeRepo())).toBe(0);
    const foreign = await makeRepo({ 'package.json': '{}', 'go.mod': 'module x\n' });
    expect(await javaAdapter.detect(foreign)).toBe(0);
  });

  it('strongest present marker wins; gradle beats maven when both present', async () => {
    const all = await makeRepo({
      gradlew: '',
      'build.gradle': '',
      'settings.gradle': '',
      'pom.xml': '',
    });
    expect(await javaAdapter.detect(all)).toBe(4); // wrapper > build file > pom

    const ktsVsSettings = await makeRepo({ 'build.gradle.kts': '', 'settings.gradle.kts': '' });
    expect(await javaAdapter.detect(ktsVsSettings)).toBe(3); // build file > settings

    const pomVsSettings = await makeRepo({ 'settings.gradle': '', 'pom.xml': '' });
    expect(await javaAdapter.detect(pomVsSettings)).toBe(3); // pom > settings-only gradle
  });
});

describe('java adapter — buildPlan (gradle root)', () => {
  it('no wrapper files → bare `gradle test` / `gradle build` (any host)', async () => {
    const root = await makeRepo({ 'build.gradle': '', 'settings.gradle': '' });
    expect(await javaAdapter.buildPlan(root)).toEqual({
      typecheckCommand: null, // honest absence — no standalone verb exists
      testCommand: 'gradle test',
      buildCommand: 'gradle build',
    });
  });

  it('wrapper present → host-platform naming (win32 → gradlew.bat, else ./gradlew)', async () => {
    const root = await makeRepo({ gradlew: '#!/bin/sh\n', 'gradlew.bat': '@echo off\r\n' });
    const prefix = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
    const plan = await javaAdapter.buildPlan(root);
    expect(plan.testCommand).toBe(`${prefix} test`);
    expect(plan.buildCommand).toBe(`${prefix} build`);
  });

  it('gradleCommand — both platform branches deterministic (injected platform)', async () => {
    const bothWrappers = await makeRepo({ gradlew: '', 'gradlew.bat': '' });
    expect(await gradleCommand(bothWrappers, 'test', 'linux')).toBe('./gradlew test');
    expect(await gradleCommand(bothWrappers, 'build', 'win32')).toBe('gradlew.bat build');

    const onlyShWrapper = await makeRepo({ gradlew: '' });
    expect(await gradleCommand(onlyShWrapper, 'test', 'linux')).toBe('./gradlew test');
    expect(await gradleCommand(onlyShWrapper, 'test', 'win32')).toBe('gradle test'); // no .bat → PATH

    const onlyBatWrapper = await makeRepo({ 'gradlew.bat': '' });
    expect(await gradleCommand(onlyBatWrapper, 'build', 'win32')).toBe('gradlew.bat build');
    expect(await gradleCommand(onlyBatWrapper, 'build', 'linux')).toBe('gradle build'); // no sh wrapper → PATH

    const noWrapper = await makeRepo({ 'build.gradle': '' });
    expect(await gradleCommand(noWrapper, 'test', 'linux')).toBe('gradle test');
    expect(await gradleCommand(noWrapper, 'test', 'win32')).toBe('gradle test');
  });
});

describe('java adapter — buildPlan (maven root)', () => {
  it('pom.xml only → mvn test / mvn package; typecheck null; resolves via registry', async () => {
    const root = await makeRepo({ 'pom.xml': '<project/>' });
    expect(await resolveAdapterForRoot(root)).toBe(javaAdapter);
    expect(await javaAdapter.buildPlan(root)).toEqual({
      typecheckCommand: null,
      testCommand: 'mvn test',
      buildCommand: 'mvn package',
    });
  });

  it('build.gradle + pom.xml tie → gradle-first in buildPlan (detect score alone cannot say)', async () => {
    const root = await makeRepo({ 'build.gradle': '', 'pom.xml': '<project/>' });
    expect((await javaAdapter.buildPlan(root)).testCommand).toBe('gradle test');
  });

  it('no markers at all → all-null plan (defensive; registry never calls it)', async () => {
    expect(await javaAdapter.buildPlan(await makeRepo())).toEqual({
      typecheckCommand: null,
      testCommand: null,
      buildCommand: null,
    });
  });
});
