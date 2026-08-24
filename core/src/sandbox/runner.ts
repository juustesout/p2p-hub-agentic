/**
 * Fase 3 Slice 2 — sandbox runner entrypoint.
 *
 * The process-side bootstrap that hosts a plugin in its own OS process. The
 * host (`SandboxedPluginAdapter`) spawns this file via {@link spawnSandboxProcess}
 * (which adds the hardening flags `--no-addons`,
 * `--disallow-code-generation-from-strings` and `--max-old-space-size=<cap>`),
 * and the two sides talk exclusively through the length-prefixed
 * {@link IPCSocketTransport} on stdin/stdout.
 *
 * Request vocabulary (host → sandbox):
 *
 * - `initialize` `{ pluginId, envAllowlist? }` — validate the plugin root
 *   (passed as `--plugin-root <dir>`), read + validate the manifest, load the
 *   entry module and call `activate(ctx)`. The sandbox `ctx` is a
 *   fail-closed shim: only `skills.register/unregister`, `timers` and
 *   `onDispose` are real (proxied to the host / process-local); every other
 *   capability (`storage`, `vault`, `ai`, `identity`, `hooks`, `network`,
 *   `access`, `trust`, `dataDir`, ...) throws a
 *   {@link SandboxCapabilityUnavailableError} when touched — Slice 2 only
 *   proxies skill execution. On success, skills announced during `activate`
 *   have been registered with the host.
 *
 * NOTE — this is **process isolation for crash containment**, not an OS-level
 * security sandbox. The entry module is loaded with the plain Node `require`
 * and the child keeps full access to Node's built-in modules, so a plugin can
 * still call `require("fs")`/`require("net")`/`require("child_process")`
 * directly (running as the same OS user). The fail-closed `ctx` and the
 * hardening flags (`--no-addons`, `--disallow-code-generation-from-strings`,
 * `--max-old-space-size`) contain accidental bugs and the obvious escape
 * hatches; they do not stop deliberate module misuse.
 *
 * - `invokeSkill` `{ skill, payload, context }` — dispatch to a locally
 *   registered handler; resolves `{ ok: true, result }` or `{ ok: false,
 *   error }` (a throwing handler is a normal business outcome, the sandbox
 *   stays up).
 * - `sandbox:heartbeat` `{}` — liveness ping, answered `{ pong: true }`
 *   regardless of plugin state.
 * - `shutdown` — acknowledge, then exit(0).
 *
 * Request vocabulary (sandbox → host): `skill:register` / `skill:unregister`
 * (the host validates every claim against the manifest it loaded — a claim is
 * never trusted).
 *
 * The sandbox also redirects `console.log/info/debug/warn` to stderr so plugin
 * logging can never corrupt the framing on stdout.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { format } from "node:util";
import type {
  IPCNotificationMessage,
  IPCRequestMessage,
  IPCResponseMessage,
} from "@p2p-hub/sdk";
import {
  IPCErrorCodes,
  IPCParseError,
  makeIPCError,
  validateObjectDepth,
} from "@p2p-hub/sdk";
import type {
  SkillHandler,
  SkillInvocationContext,
  SkillRegistrationOptions,
} from "../task-broker/task-broker";
import type { PluginContext } from "../plugin-loader/plugin-context";
import { assertPluginDirNoEscapingSymlinks } from "../plugin-loader/plugin-dir";
import { IPCSocketTransport } from "./ipc-transport";

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

/** Fase 2C: manifest ids are dot-free (the dot is the namespace delimiter). */
const MANIFEST_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Default ceiling for a `skill:register` round-trip to the host. */
const DEFAULT_HOST_REQUEST_TIMEOUT_MS = 10_000;

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
  /** The loaded plugin's manifest identity. Only present on success. */
  plugin: { id: string; entry: string };
}

export interface RunnerOptions {
  maxFrameBytes?: number;
  /** Absolute plugin root directory (spawned via `--plugin-root <dir>`). */
  pluginRoot?: string;
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
 * Thrown by the sandboxed plugin `ctx` when a plugin touches a capability that
 * is deliberately not proxied in this slice. Loud, fail-closed failure: a
 * plugin that reaches for `ctx.vault`, `ctx.storage`, `ctx.ai`, ... crashes
 * with a clear reason instead of silently getting nothing.
 */
export class SandboxCapabilityUnavailableError extends Error {
  constructor(capability: string) {
    super(
      `${capability} is not available in the sandbox (Slice 2: only skill ` +
        `execution is proxied; capability proxies are a later slice)`,
    );
    this.name = "SandboxCapabilityUnavailableError";
  }
}

/** In-memory state of the sandboxed runtime. */
interface SandboxRuntime {
  transport: IPCSocketTransport;
  pluginRoot: string;
  pluginId: string;
  activated: boolean;
  /** Outbound (sandbox → host) request correlation. */
  pending: Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >;
  /** Locally registered skill name → handler (only host-approved ones). */
  skills: Map<string, SkillHandler>;
  /** In-flight `skill:register`/`skill:unregister` round-trips. Real plugins
   * call `ctx.skills.register` fire-and-forget (the in-process loader is
   * synchronous); the runner must wait for these to settle before answering
   * `initialize`, or the host can dispatch to a skill the sandbox has not
   * registered yet. */
  pendingSkillOps: Array<Promise<unknown>>;
  /** Cleanup callbacks registered through `ctx.onDispose`. */
  disposers: Array<() => void>;
}

/** Parse `--name value` pairs from `process.argv.slice(2)`. */
function readArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) {
    return undefined;
  }
  return argv[index + 1];
}

/** Minimal manifest read + validation; the host does the authoritative checks. */
async function readSandboxManifest(
  pluginRoot: string,
): Promise<{ id: string; entry: string }> {
  const manifestPath = path.join(pluginRoot, "manifest.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read plugin manifest at ${manifestPath}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid plugin manifest at ${manifestPath}: not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid plugin manifest at ${manifestPath}: expected an object`);
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.id !== "string" || !MANIFEST_ID_RE.test(m.id)) {
    throw new Error(
      `invalid plugin manifest at ${manifestPath}: "id" must start with an ` +
        `alphanumeric and contain only alphanumerics, "_" or "-"`,
    );
  }
  if (typeof m.entry !== "string" || m.entry.length === 0) {
    throw new Error(
      `invalid plugin manifest at ${manifestPath}: missing or empty "entry"`,
    );
  }
  return { id: m.id, entry: m.entry };
}

/**
 * Resolve the module's `activate` export. Mirrors the in-process loader: a
 * tsc-compiled CommonJS default export surfaces as `{ default: fn }`, and a
 * dynamic-import of that surfaces as `{ default: { default: fn } }`.
 */
function resolveSandboxActivate(moduleValue: unknown): unknown {
  let candidate: unknown =
    typeof moduleValue === "object" &&
    moduleValue !== null &&
    typeof (moduleValue as Record<string, unknown>).default === "function"
      ? (moduleValue as Record<string, unknown>).default
      : moduleValue;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as Record<string, unknown>).default === "function"
  ) {
    candidate = (candidate as Record<string, unknown>).default;
  }
  return candidate;
}

/** Send a request to the host and await its correlated response. */
function sendToHost(
  runtime: SandboxRuntime,
  method: string,
  params: unknown,
  timeoutMs: number = DEFAULT_HOST_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    runtime.pending.set(id, { resolve, reject });
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (runtime.pending.delete(id)) {
          reject(new Error(`request "${method}" to the host timed out`));
        }
      }, timeoutMs);
    }
    runtime.transport.send({
      type: "request",
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
  });
}

function unavailable(capability: string): () => never {
  return () => {
    throw new SandboxCapabilityUnavailableError(`"${capability}"`);
  };
}

/**
 * Build the fail-closed `ctx` handed to `activate`. Only skill registration,
 * timers and disposal are real in Slice 2; every other capability is a stub
 * that throws loudly. `network`/`trust` are `null` (the same "absent" signal
 * the in-process context uses when those surfaces are not wired).
 */
function createSandboxPluginContext(runtime: SandboxRuntime): PluginContext {
  const register = async (
    skillName: string,
    handler: SkillHandler,
    options?: SkillRegistrationOptions,
  ): Promise<void> => {
    const op = (async () => {
      await sendToHost(runtime, "skill:register", {
        skill: skillName,
        options: options ?? {},
      });
      runtime.skills.set(skillName, handler);
    })();
    // A fire-and-forget register that gets denied must surface through the
    // initialize handshake (Promise.all below), not as an unhandledRejection
    // that exits the sandbox out from under that handshake.
    op.catch(() => {});
    runtime.pendingSkillOps.push(op);
    await op;
  };
  const unregister = async (skillName: string): Promise<void> => {
    const op = (async () => {
      await sendToHost(runtime, "skill:unregister", { skill: skillName });
      runtime.skills.delete(skillName);
    })();
    op.catch(() => {});
    runtime.pendingSkillOps.push(op);
    await op;
  };
  const context: PluginContext = {
    skills: { register, unregister },
    timers: {
      setTimeout: (handler, ms) => {
        const timer = globalThis.setTimeout(() => handler(), ms);
        return { dispose: () => clearTimeout(timer) };
      },
      setInterval: (handler, ms) => {
        const timer = globalThis.setInterval(() => handler(), ms);
        return { dispose: () => clearInterval(timer) };
      },
    },
    onDispose: (disposer) => {
      runtime.disposers.push(disposer);
    },
    storage: {
      get: unavailable("ctx.storage.get"),
      set: unavailable("ctx.storage.set"),
      delete: unavailable("ctx.storage.delete"),
      list: unavailable("ctx.storage.list"),
    },
    readStorageOf: () => null,
    isPathInsideDataDir: unavailable("ctx.isPathInsideDataDir"),
    hooks: {
      on: unavailable("ctx.hooks.on"),
      emit: unavailable("ctx.hooks.emit"),
      registerFilter: unavailable("ctx.hooks.registerFilter"),
      applyFilters: unavailable("ctx.hooks.applyFilters"),
    },
    ai: {
      generateText: unavailable("ctx.ai.generateText"),
      generateImage: unavailable("ctx.ai.generateImage"),
    },
    vault: {
      setSecret: unavailable("ctx.vault.setSecret"),
      listSecretKeys: unavailable("ctx.vault.listSecretKeys"),
      deleteSecret: unavailable("ctx.vault.deleteSecret"),
    },
    identity: {
      sign: unavailable("ctx.identity.sign"),
      verify: unavailable("ctx.identity.verify"),
      peerId: unavailable("ctx.identity.peerId"),
    },
    network: null,
    access: {
      issue: unavailable("ctx.access.issue"),
      revoke: unavailable("ctx.access.revoke"),
      hasPass: unavailable("ctx.access.hasPass"),
    },
    trust: null,
    get dataDir(): string {
      throw new SandboxCapabilityUnavailableError("ctx.dataDir");
    },
  };
  return context;
}

/** Redirect plugin console output to stderr so stdout stays a pure IPC pipe. */
function redirectConsoleToStderr(): void {
  const methods = console as unknown as {
    [k: string]: (...args: unknown[]) => void;
  };
  for (const level of ["log", "info", "debug", "warn"] as const) {
    methods[level] = (...args: unknown[]) => {
      process.stderr.write(`${format(...args)}\n`);
    };
  }
}

/**
 * Run the sandbox bootstrap against `process.stdin`/`process.stdout`. Blocks
 * forever until the channel closes (the host dies), a crash is contained, or
 * `shutdown` is handled.
 */
export function runSandboxRunner(options: RunnerOptions = {}): IPCSocketTransport {
  const runtime: SandboxRuntime = {
    transport: undefined as unknown as IPCSocketTransport,
    pluginRoot: options.pluginRoot ?? "",
    pluginId: "",
    activated: false,
    pending: new Map(),
    skills: new Map(),
    pendingSkillOps: [],
    disposers: [],
  };
  const transport = new IPCSocketTransport(
    process.stdin,
    process.stdout,
    { maxFrameBytes: options.maxFrameBytes },
  );
  runtime.transport = transport;
  redirectConsoleToStderr();

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

  const respond = (
    id: string,
    result: unknown,
  ): IPCResponseMessage => ({ type: "response", jsonrpc: "2.0", id, result });
  const error = (
    id: string,
    code: number,
    message: string,
  ): IPCResponseMessage => ({
    type: "response",
    jsonrpc: "2.0",
    id,
    error: makeIPCError(code as never, message),
  });

  async function handleRequest(request: IPCRequestMessage): Promise<IPCResponseMessage> {
    switch (request.method) {
      case "initialize": {
        const params = (request.params ?? {}) as Record<string, unknown>;
        const pluginId = params.pluginId;
        if (typeof pluginId !== "string" || !PLUGIN_ID_RE.test(pluginId)) {
          return error(
            request.id,
            IPCErrorCodes.INVALID_PARAMS,
            "initialize expects { pluginId: string } matching the manifest id rule",
          );
        }
        const rawAllowlist = params.envAllowlist;
        if (rawAllowlist !== undefined && !Array.isArray(rawAllowlist)) {
          return error(
            request.id,
            IPCErrorCodes.INVALID_PARAMS,
            "initialize expects envAllowlist to be an array of strings",
          );
        }
        const envAllowlist: string[] =
          rawAllowlist === undefined
            ? [...DEFAULT_ENV_ALLOWLIST]
            : rawAllowlist.filter((k): k is string => typeof k === "string");
        if (!runtime.pluginRoot) {
          return error(
            request.id,
            IPCErrorCodes.INTERNAL_ERROR,
            "sandbox launched without a plugin root (--plugin-root)",
          );
        }
        try {
          const manifest = await readSandboxManifest(runtime.pluginRoot);
          if (manifest.id !== pluginId) {
            return error(
              request.id,
              IPCErrorCodes.INVALID_PARAMS,
              `manifest id "${manifest.id}" does not match initialized pluginId "${pluginId}"`,
            );
          }
          // Mirror the in-process loader: a lexical containment check is blind
          // to symlinks, and this child is exactly where a hostile plugin would
          // run. Reject the directory up front when any symlink escapes it.
          try {
            await assertPluginDirNoEscapingSymlinks(runtime.pluginRoot);
          } catch (err) {
            return error(
              request.id,
              IPCErrorCodes.INTERNAL_ERROR,
              `plugin directory rejected: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          const entryPath = path.resolve(runtime.pluginRoot, manifest.entry);
          if (
            entryPath !== runtime.pluginRoot &&
            !entryPath.startsWith(runtime.pluginRoot + path.sep)
          ) {
            return error(
              request.id,
              IPCErrorCodes.INTERNAL_ERROR,
              `plugin entry "${manifest.entry}" escapes its directory`,
            );
          }
          const moduleValue = require(entryPath);
          const activate = resolveSandboxActivate(moduleValue);
          if (typeof activate !== "function") {
            return error(
              request.id,
              IPCErrorCodes.INTERNAL_ERROR,
              `plugin "${pluginId}" does not export a default activate function`,
            );
          }
          const ctx = createSandboxPluginContext(runtime);
          await (activate as (ctx: PluginContext) => unknown)(ctx);
          // Real plugins call `ctx.skills.register` fire-and-forget (the
          // in-process loader is synchronous). Wait for those round-trips so a
          // registration the host approved is visible locally before the
          // initialize handshake completes — otherwise the host can dispatch
          // to a skill the sandbox has not registered yet.
          await Promise.all(runtime.pendingSkillOps);
          runtime.pendingSkillOps.length = 0;
          runtime.activated = true;
          runtime.pluginId = pluginId;
          const result: InitializeResult = {
            initialized: true,
            pid: process.pid,
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            env: filteredEnv(envAllowlist),
            plugin: { id: pluginId, entry: manifest.entry },
          };
          return respond(request.id, result);
        } catch (err) {
          // A plugin that fails to load can never serve requests — exit so the
          // host observes a terminated sandbox, not a half-initialized one.
          exit(1);
          return error(
            request.id,
            IPCErrorCodes.INTERNAL_ERROR,
            `plugin activation failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      case "invokeSkill": {
        if (!runtime.activated) {
          return error(
            request.id,
            IPCErrorCodes.INTERNAL_ERROR,
            "plugin not activated",
          );
        }
        const params = (request.params ?? {}) as Record<string, unknown>;
        const skill = params.skill;
        if (typeof skill !== "string" || !runtime.skills.has(skill)) {
          return error(
            request.id,
            IPCErrorCodes.METHOD_NOT_FOUND,
            `no skill "${typeof skill === "string" ? skill : String(skill)}" registered in the sandbox`,
          );
        }
        // Defense-in-depth: the host validated payload depth/size before
        // sending; re-validate so a deep payload can never blow the plugin's
        // stack inside the sandbox.
        try {
          validateObjectDepth(params.payload);
        } catch (err) {
          return error(
            request.id,
            IPCErrorCodes.INVALID_PARAMS,
            `payload failed depth validation: ${(err as Error).message}`,
          );
        }
        const handler = runtime.skills.get(skill) as SkillHandler;
        const context = params.context as SkillInvocationContext | undefined;
        try {
          const result = await handler(params.payload, context);
          let serialized: string;
          try {
            serialized = JSON.stringify(result);
          } catch {
            return respond(request.id, {
              ok: false,
              error: `skill "${skill}" returned a non-serializable result`,
            });
          }
          if (serialized === undefined) {
            return respond(request.id, { ok: true, result: null });
          }
          return respond(request.id, { ok: true, result: JSON.parse(serialized) });
        } catch (err) {
          return respond(request.id, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      case "sandbox:heartbeat": {
        return respond(request.id, { pong: true });
      }
      case "shutdown": {
        exit(0);
        return respond(request.id, { shutdown: true });
      }
      default:
        return error(
          request.id,
          IPCErrorCodes.METHOD_NOT_FOUND,
          `unknown method "${request.method}"`,
        );
    }
  }

  transport.onMessage((message) => {
    if (message.type === "response") {
      const pending = runtime.pending.get(message.id);
      if (!pending) {
        return; // unknown/duplicate id — fail-closed, never dispatch
      }
      runtime.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new IPCParseError(message.error.code as never, message.error.message),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
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

// Run as a standalone process: `node core/dist/sandbox/runner.js
// --plugin-root <dir>`. When imported as a module (tests, Slice 2 host), the
// bootstrap stays inert.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const pluginRoot = readArg(argv, "--plugin-root");
  runSandboxRunner({ pluginRoot: pluginRoot ?? undefined });
}
