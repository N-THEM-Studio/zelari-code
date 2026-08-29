/**
 * harnessClient — minimal NDJSON client for the harness App Server wire
 * protocol (t32, Pilastro B residuo; see harnessServer.ts for the server
 * contract). Shared seam for Node hosts: the companion RunManager client
 * mode (ZELARI_HARNESS_SERVER=1) drives it today.
 *
 * Wire rules (protocol v2, unchanged):
 *   requests carry `id`; responses answer with the same `id` + ok/result |
 *   error; unsolicited server lines carry `type` (protocol_info handshake,
 *   BrainEvents, §24 control acks) and are demultiplexed to `onEvent`.
 *
 * Transports are pluggable:
 *   - createInProcessHarnessTransport(): boots a real startHarnessServer
 *     over a PassThrough pair — same NDJSON bytes, ZERO child processes
 *     (tests and embedders);
 *   - a stdio transport to `--serve-harness` (RunManager builds one) keeps
 *     full BrainEvent fidelity for long-lived deployments.
 */
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { startHarnessServer, type StartHarnessServerOptions } from './harnessServer.js';
import type { HarnessAppServer } from '@zelari/core/harness';

export interface HarnessTransport {
  /** Client → server: one NDJSON request line. */
  write(line: string): void;
  /** Server → client line feed (single consumer: the client). */
  onLine(listener: (line: string) => void): void;
  /** Idempotent teardown; resolves once the server side is disposed. */
  close(): Promise<void>;
}

/** Typed protocol error — `code` mirrors the server error codes. */
export class HarnessClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HarnessClientError';
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: HarnessClientError) => void;
}

export class HarnessClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;

  constructor(
    private readonly transport: HarnessTransport,
    /** Unsolicited server events (protocol_info, BrainEvents, control acks). */
    private readonly onEvent?: (event: Record<string, unknown>) => void,
  ) {
    transport.onLine((line) => this.handleLine(line));
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // a malformed server line is never a client crash
    }
    const id = envelope['id'];
    if (id !== undefined && id !== null && this.pending.has(id as number)) {
      const pendingRequest = this.pending.get(id as number)!;
      this.pending.delete(id as number);
      if (envelope['ok'] === true) {
        pendingRequest.resolve(envelope['result']);
      } else {
        const error = envelope['error'] as { code?: string; message?: string } | undefined;
        pendingRequest.reject(
          new HarnessClientError(
            error?.code ?? 'method_failed',
            error?.message ?? 'harness request failed',
          ),
        );
      }
      return;
    }
    this.onEvent?.(envelope);
  }

  /** One request/response roundtrip; rejects with HarnessClientError on !ok. */
  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new HarnessClientError('transport_closed', 'harness client is closed'),
      );
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.write(JSON.stringify({ id, method, params }));
    });
  }

  async createSession(workspaceRoot: string): Promise<string> {
    const result = (await this.request('session.create', { workspaceRoot })) as {
      sessionId: string;
    };
    return result.sessionId;
  }

  /** `run.turn` — resolves with the final turn result ({exitCode, …}). */
  async runTurn(
    sessionId: string,
    input: Record<string, unknown>,
  ): Promise<{ exitCode: number } & Record<string, unknown>> {
    return (await this.request('run.turn', {
      sessionId,
      ...input,
    })) as { exitCode: number } & Record<string, unknown>;
  }

  /** Session-scoped steer (§24: resolves on ACCEPTANCE, not application). */
  async steer(
    sessionId: string,
    text: string,
    controlId?: string,
  ): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { sessionId, text };
    if (controlId !== undefined) params['controlId'] = controlId;
    return (await this.request('session.steer', params)) as Record<string, unknown>;
  }

  async cancel(sessionId: string, reason?: string): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { sessionId };
    if (reason !== undefined) params['reason'] = reason;
    return (await this.request('session.cancel', params)) as Record<string, unknown>;
  }

  async disposeSession(sessionId: string): Promise<void> {
    await this.request('session.dispose', { sessionId });
  }

  /** Rejects every pending request, then tears the transport down. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pendingRequest of this.pending.values()) {
      pendingRequest.reject(
        new HarnessClientError('transport_closed', 'harness client closed'),
      );
    }
    this.pending.clear();
    await this.transport.close();
  }
}

/**
 * In-process transport: a real startHarnessServer over a PassThrough pair.
 * Zero child processes — same wire bytes as the stdio deployment, and the
 * kernel guarantees still hold (close() awaits server.dispose(), which
 * drains pending completion-proof writes before services die).
 */
export function createInProcessHarnessTransport(
  options: StartHarnessServerOptions = {},
): { transport: HarnessTransport; server: HarnessAppServer; close(): Promise<void> } {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const started = startHarnessServer({
    io: { input: clientToServer, output: serverToClient },
    ...options,
  });
  const transport: HarnessTransport = {
    write(line: string): void {
      try {
        clientToServer.write(line + '\n');
      } catch {
        /* server side gone — in-flight requests surface as transport_closed */
      }
    },
    onLine(listener: (line: string) => void): void {
      const rl = createInterface({ input: serverToClient });
      rl.on('line', listener);
    },
    close: () => started.close(),
  };
  return { transport, server: started.server, close: () => started.close() };
}
