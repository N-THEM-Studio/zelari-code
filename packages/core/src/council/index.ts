/**
 * Council — multi-agent orchestration primitives.
 * The 6 dantesche roles (Caronte, Nettuno, Gerione, Plutone, Minosse, Lucifero)
 * coordinate via a feedback loop driven by the `runCouncilPure` generator.
 */
export * from '../agents/councilApi.js';
export * from './runMode.js';
export * from './mission.js';
export * from './missionBrief.js';
export * from './modeBanners.js';
export * from './verification/index.js';
export * from './lessons/index.js';
export * from './completion/index.js';
export * from './scope/index.js';
export * from '../agents/roles.js';
export * from '../agents/promoteMember.js';
export * from '../agents/councilDirectives.js';
export * from '../agents/systemPromptBuilder.js';
export * from '../agents/promptModules.js';
