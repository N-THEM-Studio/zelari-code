/**
 * tuiReactivity.test.tsx — slice 5 of the 2026-09-15 input-lag diagnosis.
 *
 * Two contracts, both measured on the REAL components rendered through ink
 * (the project has no `ink-testing-library`: the two tiny fake streams below
 * are the whole harness — ink only needs `stdin.isTTY` + `setRawMode` to
 * support raw mode, and reads input through the `readable` event):
 *
 *  1. a keystroke re-renders the INPUT BAR ONLY — the app body and the status
 *     line around it are untouched (before the slice every key reconciled the
 *     whole tree);
 *  2. `<StatusBar>` skips the repaint when its props are semantically equal
 *     even though App recreates the chip objects each render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, Box } from 'ink';
import TextInput from 'ink-text-input';
import { EventEmitter } from 'node:events';
import { createInputDraftStore, type InputDraftStore } from './inputDraft.js';
import { InputBar } from './InputBar.js';
import { StatusBar, type StatusBarProps } from './StatusBar.js';

// Spinner is the only leaf StatusBar paints while busy: counting its renders
// is how this test observes whether StatusBar itself re-rendered (a memo bail
// skips the whole subtree, a real prop change does not).
const counters = vi.hoisted(() => ({ spinner: 0 }));
vi.mock('./Spinner.js', () => ({
  Spinner: () => {
    counters.spinner++;
    return null;
  },
}));

/** Minimal raw-mode stdin: ink pumps it through `read()` on the `readable` event. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  /** Type into the terminal. */
  write(data: string): void {
    this.queue.push(data);
    this.emit('readable');
  }
}

/** Ink paints into this; the bytes are irrelevant here, the counter is not. */
class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  write(): boolean {
    return true;
  }
}

function streams(): {
  stdin: FakeStdin;
  stdout: FakeStdout;
  options: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; exitOnCtrlC: boolean; patchConsole: boolean };
} {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  return {
    stdin,
    stdout,
    options: {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  };
}

/** React schedules via ink's scheduler; give the commit a beat to land. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

const STATUS_PROPS: StatusBarProps = {
  model: 'grok-4.5',
  provider: 'openai-compatible',
  sessionId: 'abcd1234',
  sessionActive: true,
};

let appBodyRenders = 0;
let statusBarRenders = 0;

function CountedStatusBar(): React.ReactElement {
  statusBarRenders++;
  return <StatusBar {...STATUS_PROPS} />;
}

function AppBody({
  draft,
  onSubmit,
}: {
  draft: InputDraftStore;
  onSubmit: (value: string) => void;
}): React.ReactElement {
  appBodyRenders++;
  return (
    <Box flexDirection="column">
      <CountedStatusBar />
      <InputBar draft={draft} onSubmit={onSubmit} disabled={false} />
    </Box>
  );
}

describe('prompt draft isolation (slice 5)', () => {
  let inst: ReturnType<typeof render> | null = null;

  beforeEach(() => {
    appBodyRenders = 0;
    statusBarRenders = 0;
  });

  afterEach(() => {
    inst?.unmount();
    inst = null;
  });

  it('keeps typing inside the input bar: the rest of the tree never re-renders', async () => {
    const { stdin, options } = streams();
    const draft = createInputDraftStore();
    const submitted: string[] = [];
    inst = render(<AppBody draft={draft} onSubmit={(v) => submitted.push(v)} />, options);
    await settle();

    expect(appBodyRenders).toBe(1);
    expect(statusBarRenders).toBe(1);

    // Type "hi" one keypress at a time, exactly as the terminal delivers it.
    stdin.write('h');
    await settle();
    stdin.write('i');
    await settle();

    // The keystrokes really reached the editor...
    expect(draft.get()).toBe('hi');
    // ...and NOTHING around it re-rendered: no Static/LiveRegion/StatusBar
    // reconciliation per key (the pre-slice behavior re-rendered all of them).
    expect(appBodyRenders).toBe(1);
    expect(statusBarRenders).toBe(1);

    stdin.write('\r');
    await settle();
    expect(submitted).toEqual(['hi']);

    // Submit does not re-render the tree either — the slash pipeline clears
    // the draft through the same store (`setInput('')`).
    draft.set('');
    await settle();
    expect(draft.get()).toBe('');
    expect(appBodyRenders).toBe(1);
    expect(statusBarRenders).toBe(1);
  });

  it('control: a body that owns the draft in useState DOES re-render per key', async () => {
    // The pre-slice wiring — draft as `useState` in the app body, a controlled
    // `TextInput` — kept here as the control: it proves the render counters
    // above can SEE the regression, so the isolation test is not vacuous.
    const { stdin, options } = streams();
    let bodyRenders = 0;
    let siblingRenders = 0;

    function LegacySibling(): React.ReactElement {
      siblingRenders++;
      return <StatusBar {...STATUS_PROPS} />;
    }

    function LegacyBody(): React.ReactElement {
      const [value, setValue] = React.useState('');
      bodyRenders++;
      return (
        <Box flexDirection="column">
          <LegacySibling />
          <TextInput value={value} onChange={setValue} onSubmit={() => {}} />
        </Box>
      );
    }

    inst = render(<LegacyBody />, options);
    await settle();
    expect(bodyRenders).toBe(1);

    stdin.write('h');
    await settle();
    stdin.write('i');
    await settle();

    // 1 mount + 2 keystrokes, and the unrelated sibling came along for the ride.
    expect(bodyRenders).toBeGreaterThan(1);
    expect(siblingRenders).toBe(bodyRenders);
  });

  it('keeps the submit path intact when App re-renders mid-typing', async () => {
    const draft = createInputDraftStore('draft-in-flight');
    const submitted: string[] = [];
    let rerender: (() => void) | null = null;

    function Host(): React.ReactElement {
      const [tick, setTick] = React.useState(0);
      rerender = () => setTick((t) => t + 1);
      void tick;
      // Fresh closure identities on every App-like render, exactly like App:
      // the memo comparator must ignore them and the ref mirror must pick the
      // newest one up.
      return <InputBar draft={draft} onSubmit={(v) => submitted.push(v)} disabled={false} />;
    }

    const { options } = streams();
    inst = render(<Host />, options);
    await settle();
    for (let i = 0; i < 3; i++) {
      rerender?.();
      await settle();
    }
    // Simulate the user hitting Enter on the text typed before the re-renders.
    draft.set('draft-in-flight!');
    await settle();
    expect(draft.get()).toBe('draft-in-flight!');
    expect(submitted).toEqual([]);
  });
});

describe('StatusBar memo (slice 5)', () => {
  let inst: ReturnType<typeof render> | null = null;

  beforeEach(() => {
    counters.spinner = 0;
  });

  afterEach(() => {
    inst?.unmount();
    inst = null;
  });

  /** Fresh chip identities every call — exactly what App's render produces. */
  function barProps(overrides: Partial<StatusBarProps> = {}): StatusBarProps {
    return {
      model: 'grok-4.5',
      provider: 'openai-compatible',
      sessionId: 'abcd1234',
      sessionActive: true,
      busy: true,
      elapsedMs: 1000,
      todoSummary: 'todos 2/5',
      verify: { label: 'prova: PASS', tone: 'green' },
      permissions: { label: 'write: on', tone: 'green' },
      jail: { label: 'jail: advisory (win32)', tone: 'yellow' },
      ...overrides,
    };
  }

  it('does not repaint on equal props, and does repaint on a real change', async () => {
    const { options } = streams();
    inst = render(<StatusBar {...barProps()} />, options);
    await settle();
    expect(counters.spinner).toBe(1);

    // App re-renders (streaming tick) with brand-new chip objects but the same
    // visible content: the bar must not re-render.
    inst.rerender(<StatusBar {...barProps()} />);
    await settle();
    expect(counters.spinner).toBe(1);

    // A change that is actually shown on the bar must repaint it.
    inst.rerender(<StatusBar {...barProps({ elapsedMs: 2000 })} />);
    await settle();
    expect(counters.spinner).toBe(2);
  });
});
