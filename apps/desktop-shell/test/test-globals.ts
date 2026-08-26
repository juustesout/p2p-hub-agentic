/**
 * Node-side test environment for the desktop-shell browser services.
 *
 * The services under test reference `location`, `window`, and `WebSocket` at
 * module scope (e.g. `const WS_PATH = ... location ...`), so those globals are
 * installed before any service module is evaluated. The bundler emits this
 * file first in every test bundle (it is imported at the top of each test).
 *
 * `window` forwards timer calls through to `globalThis` at call time so that
 * `node:test`'s `mock.timers` (which replaces the global timers) is honoured.
 */

interface StoredListener {
  listener: (event: unknown) => void;
}

const messageListeners = new Set<(event: unknown) => void>();

const windowStub = {
  setTimeout: (...args: Parameters<typeof setTimeout>) =>
    globalThis.setTimeout(...args),
  clearTimeout: (...args: Parameters<typeof clearTimeout>) =>
    globalThis.clearTimeout(...args),
  setInterval: (...args: Parameters<typeof setInterval>) =>
    globalThis.setInterval(...args),
  clearInterval: (...args: Parameters<typeof clearInterval>) =>
    globalThis.clearInterval(...args),
  addEventListener: (type: string, listener: (event: unknown) => void) => {
    if (type === "message") {
      messageListeners.add(listener);
    }
  },
  removeEventListener: (type: string, listener: (event: unknown) => void) => {
    if (type === "message") {
      messageListeners.delete(listener);
    }
  },
  __emitMessage: (event: unknown) => {
    for (const listener of messageListeners) {
      listener(event);
    }
  },
};

class StubWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: StubWebSocket[] = [];

  url: string;
  readyState = StubWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    StubWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = StubWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" });
  }

  send(): void {}
}

(globalThis as Record<string, unknown>).location = {
  protocol: "http:",
  host: "127.0.0.1:8787",
};

(globalThis as Record<string, unknown>).window = windowStub;
(globalThis as Record<string, unknown>).WebSocket = StubWebSocket;
