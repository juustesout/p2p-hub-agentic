/**
 * Fase 3 Slice 1 — sandbox runner entrypoint shell.
 *
 * The process-side bootstrap that will eventually host a plugin in its own OS
 * process (Slices 2+ wire this to the PluginHost's spawner). For this slice it
 * is a minimal, hostile-input-tolerant bootstrap:
 *
 * - listens for JSON-RPC frames on `process.stdin` / `process.stdout` via
 *   {@link IPCSocketTransport};
 * - answers `initialize` requests (with a *filtered* view of `process.env` —
 *   the sandbox never inherits the host's raw environment);
 * - contains crashes: `uncaughtException` / `unhandledRejection` produce a
 *   controlled `sandbox:crash` notification to the host instead of a silent
 *   exit, so the host can log/recover rather than hang on a dead pipe.
 *
 * `filteredEnv` is exported separately for tests and for the host-side tooling
 * that computes what the sandbox may see.
 */

import { IPCSocketTransport } from "./ipc-transport";
import type {
  IPCNotificationMessage,
  IPCRequestMessage,
  IPCResponseMessage,
} from "@p2p-hub/sdk";
import { IPCErrorCodes, makeIPCError } from "@p2p-hub/sdk";

/** The host's sandbox may inherit no environment by default. */
const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
];

/**
 * Defense-in-depth: even a key the host accidentally puts in the allowlist is
 * withheld when it looks like a credential. The sandbox must never see the
 * host's tokens/keys/private material.
 */
const SECRET_KEY_RE =
  /(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|session)/i;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Same shape as the manifest id rule — safe as a process/host identifier. */
const PLUGIN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface RunnerInitializeParams {
  /** Plugin id, e.g. `peersite`. Validated against the manifest id rule. */
  pluginId: string;
  /** Optional subset of `process.env` the sandbox may read. Default: none. */
  envAllowlist?: string[];
}

export interface InitializeResult {
  initialized: true;
  pid: number;
  platform: string;
  arch: string;
  nodeVersion: string;
  /** The filtered environment view the sandbox is allowed to read. */
  env: Record<string, string>;
}

export interface RunnerOptions {
  maxFrameBytes?: number;
  /** Override the filter used by `filteredEnv` (tests). */
  secretKeyRe?: RegExp;
}

/**
 * Build a read-only copy of `process.env` containing only allowlisted keys that
 * do not look like credentials. Unlisted keys and secret-looking keys are never
 * exposed — the sandbox gets exactly what the host opted into, nothing wider.
 */
export function filteredEnv(
  allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST,
  source: Record<string, string | undefined> = process.env,
  secretKeyRe: RegExp = SECRET_KEY_RE,
): Record<string, string> {
  const allowed = new Set(allowlist.filter((k) => ENV_NAME_RE.test(k)));
  const out: Record<string, string> = {};
  for (const key of allowed) {
    if (secretKeyRe.test(key)) {
      continue;
    }
    const value = source[key];
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Run the sandbox bootstrap against `process.stdin`/`process.stdout`. Blocks
 * forever until the channel closes (the host dies) or `shutdown` is handled.
 */
export function runSandboxRunner(options: RunnerOptions = {}): IPCSocketTransport {
  const transport = new IPCSocketTransport(
    process.stdin,
    process.stdout,
    { maxFrameBytes: options.maxFrameBytes },
  );

  let fatal = false;
  let exiting = false;

  const exit = (code: number): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    // Give stdout a tick to flush the last notification/response.
    setTimeout(() => process.exit(code), 25);
  };

  const crashNotification = (
    label: string,
    err: unknown,
  ): IPCNotificationMessage => {
    fatal = true;
    return {
      type: "notification",
      jsonrpc: "2.0",
      method: "sandbox:crash",
      params: {
        label,
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
      },
    };
  };

  // Contained crashes: notify the host, then exit nonzero. Without these the
  // default Node behaviour would die silently and the host would see only a
  // closed pipe with no reason.
  process.on("uncaughtException", (err) => {
    try {
      transport.send(crashNotification("uncaughtException", err));
    } catch {
      // Channel already dead — nothing left to notify into.
    }
    exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    try {
      transport.send(crashNotification("unhandledRejection", reason));
    } catch {
      // ignore
    }
    exit(1);
  });

  transport.onClose(() => {
    // Host closed the channel or we tore down after a malformed frame.
    exit(fatal ? 1 : 0);
  });

  transport.onMessage((message) => {
    if (message.type !== "request") {
      return; // notifications are one-way (host→sandbox); ignored here.
    }
    void handleRequest(message)
      .then((response) => transport.send(response))
      .catch((err) => {
        try {
          transport.send({
            type: "response",
            jsonrpc: "2.0",
            id: message.id,
            error: makeIPCError(
              IPCErrorCodes.INTERNAL_ERROR,
              err instanceof Error ? err.message : String(err),
            ),
          });
        } catch {
          // ignore — channel is gone
        }
      });
  });

  return transport;
}

async function handleRequest(
  request: IPCRequestMessage,
): Promise<IPCResponseMessage> {
  const respond = (
    result: unknown,
  ): IPCResponseMessage => ({ type: "response", jsonrpc: "2.0", id: request.id, result });
  const error = (
    code: number,
    message: string,
    data?: unknown,
  ): IPCResponseMessage => ({
    type: "response",
    jsonrpc: "2.0",
    id: request.id,
    error: makeIPCError(code as never, message, data),
  });

  switch (request.method) {
    case "initialize": {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const pluginId = params.pluginId;
      if (typeof pluginId !== "string" || !PLUGIN_ID_RE.test(pluginId)) {
        return error(
          IPCErrorCodes.INVALID_PARAMS,
          "initialize expects { pluginId: string } matching the manifest id rule",
        );
      }
      const rawAllowlist = params.envAllowlist;
      if (rawAllowlist !== undefined && !Array.isArray(rawAllowlist)) {
        return error(
          IPCErrorCodes.INVALID_PARAMS,
          "initialize expects envAllowlist to be an array of strings",
        );
      }
      const envAllowlist: string[] =
        rawAllowlist === undefined
          ? [...DEFAULT_ENV_ALLOWLIST]
          : rawAllowlist.filter((k): k is string => typeof k === "string");
      const result: InitializeResult = {
        initialized: true,
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        env: filteredEnv(envAllowlist),
      };
      return respond(result);
    }
    case "shutdown": {
      // Acknowledge, then leave the event loop once the response flushed.
      setTimeout(() => process.exit(0), 25);
      return respond({ shutdown: true });
    }
    default:
      return error(
        IPCErrorCodes.METHOD_NOT_FOUND,
        `unknown method "${request.method}"`,
      );
  }
}

// Run as a standalone process: `node core/dist/sandbox/runner.js`.
// When imported as a module (tests, Slice 2 host), the bootstrap stays inert.
if (require.main === module) {
  runSandboxRunner();
}
