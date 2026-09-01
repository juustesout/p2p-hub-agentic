import { coreBridge } from "./core-bridge";

/**
 * Webview-side diagnostics capture: routes the shell's own errors — uncaught
 * exceptions, unhandled promise rejections and (throttled) console output —
 * into the core-server log via `/api/debug/log`, so they land in the same
 * on-disk `<dataDir>/core-server.log` as the server's own records.
 *
 * The installed app's webview console is invisible to the user; without this,
 * a frontend crash is indistinguishable from a server crash. With it, both
 * ends of the wire appear in one greppable file.
 *
 * Everything here is best-effort and must never throw or recurse into the
 * console it wraps. Repeats of the same message are throttled so a polling
 * failure (health every 10s, etc.) does not flood the log.
 */

const THROTTLE_MS = 30_000;

const lastReported = new Map<string, number>();

function throttled(level: "debug" | "info" | "warn" | "error", message: string): boolean {
  const key = `${level}:${message}`;
  const now = Date.now();
  const last = lastReported.get(key) ?? 0;
  if (now - last < THROTTLE_MS) {
    return false;
  }
  lastReported.set(key, now);
  return true;
}

function report(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  context?: Record<string, unknown>,
): void {
  if (!throttled(level, message)) {
    return;
  }
  void coreBridge.reportClientError(level, message, context);
}

function stackOf(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message || String(err), stack: err.stack };
  }
  return { message: String(err) };
}

/**
 * Install the global handlers. Idempotent: calling it more than once (e.g.
 * under React StrictMode's double-invoke) must not double-wrap.
 */
let installed = false;
export function installClientDiagnostics(): void {
  if (installed) {
    return;
  }
  installed = true;

  window.addEventListener("error", (event) => {
    report("error", `window.onerror: ${event.message}`, {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const err = stackOf(event.reason);
    report("error", `unhandledrejection: ${err.message}`, {
      stack: err.stack,
    });
  });

  // Mirror console output. The wrappers call the ORIGINAL function so the
  // webview devtools still behave normally, and the report path never calls
  // back into console (reportClientError swallows its own failures).
  const original = {
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.debug = (...args: unknown[]) => {
    original.debug(...args);
    report("debug", `console.debug: ${String(args[0] ?? "")}`);
  };
  console.info = (...args: unknown[]) => {
    original.info(...args);
    report("info", `console.info: ${String(args[0] ?? "")}`);
  };
  console.warn = (...args: unknown[]) => {
    original.warn(...args);
    report("warn", `console.warn: ${String(args[0] ?? "")}`);
  };
  console.error = (...args: unknown[]) => {
    original.error(...args);
    report("error", `console.error: ${String(args[0] ?? "")}`);
  };
}
