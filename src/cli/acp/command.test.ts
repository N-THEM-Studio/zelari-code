/**
 * `zelari-code acp` — flag parsing, help, and the whole command path on an
 * injected transport (initialize answered, unknown method rejected, EOF ->
 * clean exit 0). The turn dispatcher is never reached: no prompt is sent.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createMessageParser, encodeMessage } from './framing.js';
import { acpHelpText, parseAcpFlags, runAcpCommand } from './command.js';

function flush(ticks = 3): Promise<void> {
  return new Promise<void>((resolve) => {
    let n = 0;
    const step = (): void => {
      if (n++ >= ticks) return resolve();
      setImmediate(step);
    };
    step();
  });
}

describe('acp/command — flags', () => {
  it('reads --cwd/--model/--provider after the subcommand', () => {
    expect(parseAcpFlags(['acp', '--cwd', '/work', '--model', 'gpt-x', '--provider', 'openai'])).toEqual({
      cwd: '/work',
      model: 'gpt-x',
      provider: 'openai',
    });
  });

  it('detects --help/-h and ignores unknown or value-less flags', () => {
    expect(parseAcpFlags(['acp', '--help'])).toEqual({ help: true });
    expect(parseAcpFlags(['acp', '-h'])).toEqual({ help: true });
    expect(parseAcpFlags(['acp', '--nope', '--cwd'])).toEqual({});
    expect(parseAcpFlags(['acp', '--cwd', '--model', 'm'])).toEqual({ model: 'm' });
  });

  it('help text names the subcommand, the methods and the flags', () => {
    const help = acpHelpText();
    expect(help).toContain('zelari-code acp');
    for (const method of ['initialize', 'session/new', 'session/prompt', 'session/cancel']) {
      expect(help).toContain(method);
    }
    expect(help).toContain('--cwd');
    expect(help).toContain('--model');
  });
});

describe('acp/command — runAcpCommand', () => {
  it('--help prints to stdout and exits 0 without touching stdin', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(runAcpCommand({ help: true })).resolves.toBe(0);
      expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain('zelari-code acp');
    } finally {
      write.mockRestore();
    }
  });

  it('serves a request on the injected transport and exits 0 on EOF', async () => {
    const input = new PassThrough();
    const written: string[] = [];
    const output = {
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    };
    const running = runAcpCommand({ input, output });

    input.write(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await flush();
    const messages = createMessageParser().push(written.join('')) as Array<Record<string, any>>;
    expect(messages[0]).toMatchObject({ id: 1, result: { protocolVersion: 1 } });

    input.write(encodeMessage({ jsonrpc: '2.0', id: 2, method: 'nope/x', params: {} }));
    await flush();
    const after = createMessageParser().push(written.join('')) as Array<Record<string, any>>;
    expect(after.find((m) => m['id'] === 2)?.['error']?.['code']).toBe(-32601);

    input.end();
    await expect(running).resolves.toBe(0);
  });

  it('a stdout whose write throws never kills the transport (fail-soft, exit 0)', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const input = new PassThrough();
    const running = runAcpCommand({
      input,
      output: {
        write: () => {
          throw new Error('EPIPE');
        },
      },
    });
    input.write(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await flush();
    input.end();
    await expect(running).resolves.toBe(0);
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('EPIPE');
    err.mockRestore();
  });

  it('speaks ndjson end-to-end (the Zed wire format): bare lines in, bare lines out', async () => {
    const input = new PassThrough();
    const written: string[] = [];
    const output = {
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
    };
    const running = runAcpCommand({ input, output });

    input.write(
      '{"jsonrpc":"2.0","id":"z1","method":"initialize","params":{"protocolVersion":1}}\n',
    );
    input.write('\n'); // Zed sends a trailing blank line after each message
    input.write('{"jsonrpc":"2.0","method":"initialized"}\n');
    await flush();
    input.write('{"jsonrpc":"2.0","id":"z2","method":"session/new","params":{"cwd":"/tmp"}}\n');
    await flush();

    const lines = written
      .join('')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, any>);
    expect(written.join('')).not.toContain('Content-Length');
    expect(lines[0]).toMatchObject({ id: 'z1', result: { protocolVersion: 1 } });
    expect(lines[1]).toMatchObject({ id: 'z2', result: { sessionId: expect.any(String) } });

    input.end();
    await expect(running).resolves.toBe(0);
  });
});
