/**
 * runtime/fingerprints.ts — full behavioural fingerprints (2.6.1 plan §7).
 * Names alone are NOT a harness fingerprint: a renamed description or a
 * changed inputSchema changes model-visible behaviour and must change the
 * harness manifest hash. Canonical (stableStringify) sha256, order-free.
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '../core/requestSnapshot.js';

export interface ToolFingerprint {
  name: string;
  description?: string;
  /** JSON Schema of the tool args, stringified canonically before hashing. */
  inputSchema?: unknown;
  outputContractVersion?: string;
  capabilityFlags?: readonly string[];
}

export function toolFingerprintHash(tools: readonly ToolFingerprint[]): string {
  const canonical = [...tools]
    .map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
      ...(t.outputContractVersion !== undefined ? { outputContractVersion: t.outputContractVersion } : {}),
      ...(t.capabilityFlags !== undefined ? { capabilityFlags: [...t.capabilityFlags].sort() } : {}),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

export interface SkillFingerprint {
  id: string;
  version?: string;
  /** sha256 hex of the skill CONTENT — ids alone miss content edits (§7). */
  contentDigest?: string;
}

export function skillFingerprintHash(skills: readonly SkillFingerprint[]): string {
  const canonical = [...skills]
    .map((s) => ({
      id: s.id,
      ...(s.version !== undefined ? { version: s.version } : {}),
      ...(s.contentDigest !== undefined ? { contentDigest: s.contentDigest } : {}),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash('sha256').update(stableStringify(canonical)).digest('hex');
}
