/**
 * sessionScope — per-harness-session isolation for process-wide CLI state.
 *
 * WHY: `--serve-harness` hosts every Desktop/companion chat as a concurrent
 * session inside ONE Node process. A lot of CLI state was written as simple
 * module state (`let phase`, `let activeSurface`, the todo list) or as
 * `globalThis.__zelari*` per-turn channels (candidates, verify check results,
 * spawn counters, live tentacles, turn metrics) plus per-turn `process.env`
 * writes (Kraken tentacle models, delegation, permission preset). With two
 * chats running at once they overwrote each other: a build turn flipped a
 * plan-phase chat to `build` (phase gate bypassed), chat A's todos and
 * tentacle activity surfaced in chat B, one turn's start reset the other's
 * verify obligation, and Kraken model settings leaked across chats.
 *
 * HOW: the harness server already runs each `run.turn` inside an
 * AsyncLocalStorage context carrying the harness session id
 * (`runWithSession`, serve/sessionControl.ts). Everything here keys off that
 * id; OUTSIDE a served session (TUI, plain `--headless`, tests) every
 * accessor falls back to the exact process-global behaviour it replaced.
 *
 *   - `sessionLocal(init)`  — replacement for a module-level `let`;
 *   - `turnGlobals()`       — replacement for `globalThis` in `__zelari*` bags;
 *   - `setTurnEnv` / `turnEnv()` — per-session env overlay over `process.env`
 *     (reads fall through to the real env for keys the session never set).
 *
 * The desktop creates one harness session per run, so session scope is also
 * turn scope there; `disposeSessionScope` drops the state on session.dispose.
 */
import { getCurrentHarnessSessionId } from './serve/sessionControl.js';

interface Scope {
  globals: Record<string, unknown>;
  locals: Map<symbol, unknown>;
  env: Record<string, string>;
  envView?: NodeJS.ProcessEnv;
}

const scopes = new Map<string, Scope>();

function currentScope(): Scope | undefined {
  const id = getCurrentHarnessSessionId();
  if (!id) return undefined;
  let scope = scopes.get(id);
  if (!scope) {
    scope = { globals: {}, locals: new Map(), env: {} };
    scopes.set(id, scope);
  }
  return scope;
}

/** A module-level variable that is per-session inside a served session. */
export interface SessionLocal<T> {
  get(): T;
  set(value: T): void;
}

export function sessionLocal<T>(init: () => T): SessionLocal<T> {
  const key = Symbol('sessionLocal');
  let processValue = init();
  return {
    get() {
      const scope = currentScope();
      if (!scope) return processValue;
      if (!scope.locals.has(key)) scope.locals.set(key, init());
      return scope.locals.get(key) as T;
    },
    set(value) {
      const scope = currentScope();
      if (!scope) processValue = value;
      else scope.locals.set(key, value);
    },
  };
}

/**
 * The object that holds `__zelari*` per-turn channels: the session's own bag
 * inside a served session, `globalThis` everywhere else.
 */
export function turnGlobals<T extends object>(): T {
  return (currentScope()?.globals ?? globalThis) as T;
}

/**
 * Set a per-turn env knob. Inside a served session it lands in the session
 * overlay (never `process.env`, which every concurrent chat shares); outside
 * it writes `process.env` exactly as before. `undefined` removes the key.
 */
export function setTurnEnv(key: string, value: string | undefined): void {
  const scope = currentScope();
  if (!scope) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    return;
  }
  if (value === undefined) delete scope.env[key];
  else scope.env[key] = value;
}

/**
 * The env a per-turn reader must consult: `process.env` outside a served
 * session (or when the session set nothing), else a read-through view where
 * the session overlay wins.
 */
export function turnEnv(): NodeJS.ProcessEnv {
  const scope = currentScope();
  if (!scope || Object.keys(scope.env).length === 0) return process.env;
  if (!scope.envView) {
    const overlay = scope.env;
    scope.envView = new Proxy(overlay, {
      get: (target, prop) =>
        typeof prop === 'string' && Object.hasOwn(target, prop)
          ? target[prop]
          : (process.env as Record<string | symbol, unknown>)[prop],
      has: (target, prop) => Object.hasOwn(target, prop) || prop in process.env,
      ownKeys: (target) => [...new Set([...Reflect.ownKeys(process.env), ...Reflect.ownKeys(target)])],
      getOwnPropertyDescriptor: (target, prop) => {
        const value =
          typeof prop === 'string' && Object.hasOwn(target, prop)
            ? target[prop]
            : (process.env as Record<string | symbol, unknown>)[prop];
        return value === undefined
          ? undefined
          : { value, writable: true, enumerable: true, configurable: true };
      },
    }) as NodeJS.ProcessEnv;
  }
  return scope.envView;
}

/** Drop every piece of state a harness session accumulated (session.dispose). */
export function disposeSessionScope(sessionId: string): void {
  scopes.delete(sessionId);
}

/** Test/diagnostic: number of live session scopes. */
export function liveSessionScopeCount(): number {
  return scopes.size;
}
