import { performance } from 'node:perf_hooks';
import type { MemoryService } from '@zelari/core/memory';

export interface MemoryPerformanceReport {
  nodes: number;
  samples: number;
  addP50Ms: number;
  addP95Ms: number;
  recallP50Ms: number;
  recallP95Ms: number;
  contextP50Ms: number;
  contextP95Ms: number;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

async function measured<T>(samples: number[], operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await operation(); }
  finally { samples.push(performance.now() - started); }
}

/** Real-backend microbenchmark. Hosts choose scale; embeddings are intentionally excluded. */
export async function benchmarkMemoryService(
  memory: MemoryService,
  options: { nodes?: number; samples?: number } = {},
): Promise<MemoryPerformanceReport> {
  const nodes = Math.max(1, Math.min(options.nodes ?? 1_000, 100_000));
  const sampleCount = Math.max(1, Math.min(options.samples ?? 50, 1_000));
  const add: number[] = [];
  const recall: number[] = [];
  const context: number[] = [];
  for (let index = 0; index < nodes; index += 1) {
    await measured(add, () => memory.remember({
      kind: index % 10 === 0 ? 'decision' : 'fact',
      content: `Benchmark memory ${index}: subsystem-${index % 37} uses bounded retry policy ${index % 11}.`,
      tags: [`subsystem-${index % 37}`, 'benchmark'],
      source: { agent: 'memory-benchmark', sessionId: `sample-${Math.floor(index / 100)}` },
    }));
  }
  for (let index = 0; index < sampleCount; index += 1) {
    const query = `subsystem-${index % 37} retry policy`;
    await measured(recall, () => memory.recall({ text: query, limit: 8, useGraph: true }));
    await measured(context, () => memory.buildContext({ text: query, maxChars: 2_000, maxMemories: 8 }));
  }
  return {
    nodes,
    samples: sampleCount,
    addP50Ms: percentile(add, 0.5),
    addP95Ms: percentile(add, 0.95),
    recallP50Ms: percentile(recall, 0.5),
    recallP95Ms: percentile(recall, 0.95),
    contextP50Ms: percentile(context, 0.5),
    contextP95Ms: percentile(context, 0.95),
  };
}
