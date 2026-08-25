/**
 * Fase 3 Slice 2 — host-side adapter for a sandboxed plugin.
 *
 * Represents one plugin running in its own OS process. Owns the sandbox
 * lifecycle (spawn → initialize handshake → skill registration → active loop
 * → shutdown/kill), translates `TaskBroker` skill invocations into
 * `invokeSkill` IPC requests, and enforces the host-trust rules:
 *
 * - **Source-pinning:** the adapter binds the spawned child's transport to its
 *   `pluginId` at construction; every inbound request (e.g. `skill:register`)
 *   is accepted only from that transport.
 * - **Host-side manifest binding:** registration claims from the child are
 *   *never* trusted — the local skill name is validated and every permission
 *   decision (`localOnly: false`, `httpExposed: true`, `remote` gate `"any"`)
 *   is checked against the manifest the host loaded, exactly mirroring the
 *   in-process loader. The child supplies only a local name; the broker key
 *   is always derived host-side (`<pluginId>.<skillName>`).
 * - **Fail-closed execution:** `invokeSkill` carries a hard timeout; a
 *   hung/unresponsive sandbox is SIGKILLed and surfaces as a typed
 *   {@link PluginExecutionTimeoutError}. A crash (channel close, crash
 *   notification) rejects in-flight calls with {@link PluginCrashError} and
 *   unregisters every skill from the broker. There is no auto-respawn — a
 *   crashed sandbox stays crashed for the operator to act on.
 * - **Single enforcement point:** the `TaskBroker` still evaluates every
 *   remote/agent gate *before* the adapter dispatches; the sandbox process
 *   never sees peer identity material beyond the audit `context` the broker
 *   already computes for an in-process plugin.
 */

import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { IPCRequestMessage, IPCResponseMessage, PluginManifest } from "@p2p-hub/sdk";
import {
  IPCErrorCodes,
  makeIPCError,
  MAX_PAYLOAD_BYTES,
  validateObjectDepth,
  validatePayloadSize,
} from "@p2p-hub/sdk";
import type {
  SkillHandler,
  SkillInvocationContext,
  SkillRegistrationOptions,
} from "../task-broker/task-broker";
import type { TaskBroker } from "../task-broker/task-broker";
import type { RemoteGateKind } from "../task-broker/remote-access";
import type { IPCMessageEnvelope } from "@p2p-hub/sdk";
import { IPCSocketTransport, type IPCSocketTransportOptions } from "./ipc-transport";
import { spawnSandboxProcess } from "./launcher";
import type { InitializeResult } from "./runner";

const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;

const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** A skill invocation exceeded its hard execution timeout. */
export class PluginExecutionTimeoutError extends Error {
  readonly skill: string;
  readonly timeoutMs: number;
  constructor(skill: string, timeoutMs: number) {
    super(
      `sandboxed skill "${skill}" exceeded the ${timeoutMs}ms execution timeout`,
    );
    this.name = "PluginExecutionTimeoutError";
    this.skill = skill;
    this.timeoutMs = timeoutMs;
  }
}

/** The sandbox process crashed (or its channel closed) mid-flight. */
export class PluginCrashError extends Error {
  constructor(reason: string) {
    super(`sandboxed plugin crashed: ${reason}`);
    this.name = "PluginCrashError";
  }
}

/** The sandbox failed to come up (spawn/boot/activate failure). */
export class SandboxInitializationError extends Error {
  constructor(reason: string) {
    super(`sandbox initialization failed: ${reason}`);
    this.name = "SandboxInitializationError";
  }
}

/** Internal: a request to the sandbox exceeded its own timeout. */
class SandboxRequestTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;
  constructor(method: string, timeoutMs: number) {
    super(`sandbox request "${method}" timed out after ${timeoutMs}ms`);
    this.name = "SandboxRequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

type AdapterState = "spawning" | "running" | "crashed" | "stopped";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SandboxedPluginAdapterOptions {
  pluginId: string;
  pluginRoot: string;
  /** Manifest already loaded + validated by the host (permission authority). */
  manifest: PluginManifest;
  broker: TaskBroker;
  envAllowlist?: string[];
  maxFrameBytes?: number;
  heapSizeMb?: number;
  initializeTimeoutMs?: number;
  invokeSkillTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** Forward the child's stderr (its log channel). */
  stderr?: (chunk: string) => void;
  /** Override the runner script path (tests). */
  runnerPath?: string;
  /** Fired once when the sandbox transitions to `crashed`. */
  onCrashed?: (reason: string) => void;
}

/**
 * Mirrors the in-process loader's permission checks: exposing a skill to the
 * network, to the local HTTP bridge, or publicly (`any` gate) each require
 * their own explicit manifest permission. The child's claim is validated
 * here, host-side, against the manifest the host loaded.
 */
function assertSandboxRegistrationAllowed(
  manifest: PluginManifest,
  skillName: string,
  options: SkillRegistrationOptions,
): void {
  if (options.localOnly === false) {
    const permission = `network:skill:${manifest.id}.${skillName}`;
    if (!manifest.permissions.includes(permission)) {
      throw new Error(
        `plugin "${manifest.id}" exposes skill "${skillName}" to the network ` +
          `but lacks permission "${permission}"`,
      );
    }
  }
  if (options.httpExposed === true || options.httpBridgeOnly === true) {
    const permission = `network:http:${manifest.id}.${skillName}`;
    if (!manifest.permissions.includes(permission)) {
      throw new Error(
        `plugin "${manifest.id}" exposes skill "${skillName}" to the local ` +
          `HTTP bridge but lacks permission "${permission}"`,
      );
    }
  }
  const remote = options.remote;
  if (remote) {
    const gates: RemoteGateKind[] = Array.isArray(remote.gate)
      ? remote.gate
      : [remote.gate];
    if (gates.includes("any")) {
      const permission = `network:public:${manifest.id}.${skillName}`;
      if (!manifest.permissions.includes(permission)) {
        throw new Error(
          `plugin "${manifest.id}" marks skill "${skillName}" as publicly ` +
            `reachable (remote gate "any") but lacks permission "${permission}"`,
        );
      }
    }
  }
}

export class SandboxedPluginAdapter {
  readonly pluginId: string;
  readonly pluginRoot: string;

  private readonly options: SandboxedPluginAdapterOptions;
  private readonly manifest: PluginManifest;
  private readonly broker: TaskBroker;
  private readonly onCrashed?: (reason: string) => void;

  private state: AdapterState = "spawning";
  private crashedReason: string | null = null;
  private child: ChildProcess | null = null;
  private transport: IPCSocketTransport | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly registered = new Map<string, string>(); // brokerKey -> localName
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: SandboxedPluginAdapterOptions) {
    this.pluginId = options.pluginId;
    this.pluginRoot = options.pluginRoot;
    this.options = options;
    this.manifest = options.manifest;
    this.broker = options.broker;
    this.onCrashed = options.onCrashed;
  }

  get isCrashed(): boolean {
    return this.state === "crashed";
  }

  get stateLabel(): AdapterState {
    return this.state;
  }

  /** The underlying child process (tests inspect exit code / pid). */
  get childProcess(): ChildProcess | null {
    return this.child;
  }

  /** Broker keys currently registered for this sandbox. */
  get registeredSkillKeys(): string[] {
    return [...this.registered.keys()];
  }

  /**
   * Spawn the sandbox, run the initialize handshake (which activates the
   * plugin) and start heartbeats. Skills announced during activate are
   * registered with the broker as they arrive.
   */
  async start(): Promise<InitializeResult> {
    if (this.state !== "spawning") {
      throw new Error("adapter already started");
    }
    const spawned = spawnSandboxProcess({
      pluginRoot: this.pluginRoot,
      envAllowlist: this.options.envAllowlist,
      maxFrameBytes: this.options.maxFrameBytes,
      heapSizeMb: this.options.heapSizeMb,
      runnerPath: this.options.runnerPath,
      stderr: this.options.stderr,
    });
    this.child = spawned.child;
    this.transport = spawned.transport;
    this.wireTransport();

    try {
      const result = await this.request(
        "initialize",
        { pluginId: this.pluginId, envAllowlist: this.options.envAllowlist },
        this.options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      );
      if (
        typeof result !== "object" ||
        result === null ||
        (result as Record<string, unknown>).initialized !== true
      ) {
        throw new SandboxInitializationError(
          "initialize returned a non-success response",
        );
      }
      this.state = "running";
      this.startHeartbeat();
      return result as InitializeResult;
    } catch (err) {
      this.killAndCrash(
        `sandbox failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err instanceof SandboxInitializationError
        ? err
        : new SandboxInitializationError(
            err instanceof Error ? err.message : String(err),
          );
    }
  }

  /** Graceful stop: `shutdown` ack, wait briefly, then force-kill if needed. */
  async shutdown(timeoutMs = 2_000): Promise<void> {
    if (this.state === "stopped") {
      return;
    }
    this.clearHeartbeat();
    try {
      if (this.state === "running") {
        await this.request("shutdown", {}, timeoutMs);
      }
    } catch {
      // child may already be dead — force-kill below regardless.
    }
    this.state = "stopped";
    this.cleanupRegisteredAndPending("sandbox shut down");
    if (this.child && this.child.exitCode === null) {
      const code = await this.waitForExit(150);
      if (code === null && this.child.exitCode === null) {
        this.child.kill("SIGKILL");
      }
    }
    this.transport?.close();
    this.transport = null;
  }

  /** Hard stop — no graceful ack, no crash callback. */
  kill(): void {
    if (this.state === "stopped") {
      return;
    }
    this.clearHeartbeat();
    this.state = "stopped";
    this.cleanupRegisteredAndPending("sandbox killed");
    if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGKILL");
    }
    this.transport?.close();
    this.transport = null;
  }

  private assertRunning(): void {
    if (this.state !== "running") {
      throw new PluginCrashError(
        this.crashedReason ?? "sandbox is not running",
      );
    }
  }

  /** Send a request, correlating the response by UUID, with a hard timeout. */
  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (
        this.transport === null ||
        (this.state !== "running" && method !== "initialize")
      ) {
        reject(
          new PluginCrashError(this.crashedReason ?? "sandbox not running"),
        );
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new SandboxRequestTimeoutError(method, timeoutMs));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send({
          type: "request",
          jsonrpc: "2.0",
          id,
          method,
          params,
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          err instanceof Error &&
            err.name === "IPCParseError" &&
            (err as { code?: number }).code === IPCErrorCodes.CHANNEL_CLOSED
            ? new PluginCrashError("sandbox channel closed")
            : err,
        );
      }
    });
  }

  /**
   * The broker handler for every skill this sandbox registers. Forwards the
   * call to the child and maps the outcome: `{ ok: true, result }` becomes the
   * result, `{ ok: false, error }` becomes a thrown error (the broker wraps it
   * into a `status: "error"` TaskResult), a timeout becomes a
   * {@link PluginExecutionTimeoutError} and a dead sandbox a
   * {@link PluginCrashError}.
   */
  private async invoke(
    localSkill: string,
    payload: unknown,
    context?: SkillInvocationContext,
  ): Promise<unknown> {
    this.assertRunning();
    try {
      const response = await this.request(
        "invokeSkill",
        { skill: localSkill, payload, context },
        this.options.invokeSkillTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS,
      );
      const r = response as { ok?: unknown; result?: unknown; error?: unknown };
      if (r?.ok !== true) {
        const message =
          typeof r?.error === "string" && r.error.length > 0
            ? r.error
            : `skill "${localSkill}" invocation failed`;
        throw new Error(message);
      }
      // The child's result is a hostile value once it crosses the process
      // boundary — validate it before it flows to the broker's caller.
      validateObjectDepth(r.result);
      validatePayloadSize(
        JSON.stringify(r.result ?? null),
        MAX_PAYLOAD_BYTES,
      );
      return r.result;
    } catch (err) {
      if (err instanceof SandboxRequestTimeoutError) {
        const timeoutMs =
          this.options.invokeSkillTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
        this.killAndCrash(
          `skill "${localSkill}" exceeded the ${timeoutMs}ms execution timeout`,
        );
        throw new PluginExecutionTimeoutError(localSkill, timeoutMs);
      }
      throw err;
    }
  }

  private wireTransport(): void {
    const transport = this.transport;
    if (!transport) {
      return;
    }
    transport.onMessage((message: IPCMessageEnvelope) => {
      if (this.state === "stopped") {
        return;
      }
      if (message.type === "response") {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return; // unknown/duplicate id — fail-closed, never dispatch
        }
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      if (message.type === "notification") {
        if (message.method === "sandbox:crash") {
          const params = (message.params ?? {}) as Record<string, unknown>;
          const reason =
            typeof params.message === "string" && params.message.length > 0
              ? params.message
              : "sandbox reported an unhandled crash";
          this.killAndCrash(`sandbox reported a crash: ${reason}`);
        }
        // Unknown notifications are ignored (no-op), never acted on.
        return;
      }
      // A request from the child (skill:register / skill:unregister / ...).
      void this.handleChildRequest(message)
        .then((response) => {
          try {
            transport.send(response);
          } catch {
            // channel is gone
          }
        })
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
            // ignore
          }
        });
    });
    transport.onError((err) => {
      if (this.state !== "stopped") {
        this.killAndCrash(`sandbox channel error: ${err.message}`);
      }
    });
    transport.onClose(() => {
      if (this.state !== "stopped" && this.state !== "crashed") {
        this.killAndCrash("sandbox channel closed unexpectedly");
      }
    });
  }

  private async handleChildRequest(
    request: IPCRequestMessage,
  ): Promise<IPCResponseMessage> {
    const respond = (
      result: unknown,
    ): IPCResponseMessage => ({ type: "response", jsonrpc: "2.0", id: request.id, result });
    const error = (
      code: number,
      message: string,
    ): IPCResponseMessage => ({
      type: "response",
      jsonrpc: "2.0",
      id: request.id,
      error: makeIPCError(code as never, message),
    });

    switch (request.method) {
      case "skill:register": {
        const params = (request.params ?? {}) as Record<string, unknown>;
        const skill = params.skill;
        if (typeof skill !== "string" || !SKILL_NAME_RE.test(skill)) {
          return error(IPCErrorCodes.INVALID_PARAMS, "invalid skill name");
        }
        const rawOptions = params.options;
        if (
          rawOptions !== undefined &&
          (typeof rawOptions !== "object" || rawOptions === null || Array.isArray(rawOptions))
        ) {
          return error(IPCErrorCodes.INVALID_PARAMS, "options must be an object");
        }
        const options = (rawOptions ?? {}) as SkillRegistrationOptions;
        try {
          assertSandboxRegistrationAllowed(this.manifest, skill, options);
        } catch (err) {
          return error(
            IPCErrorCodes.INVALID_REQUEST,
            err instanceof Error ? err.message : String(err),
          );
        }
        const brokerKey = `${this.pluginId}.${skill}`;
        const handler: SkillHandler = (payload, context) =>
          this.invoke(skill, payload, context);
        try {
          this.broker.registerSkill(brokerKey, handler, options);
        } catch (err) {
          return error(
            IPCErrorCodes.INVALID_PARAMS,
            `registration rejected: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this.registered.set(brokerKey, skill);
        return respond({ ok: true, skill: brokerKey });
      }
      case "skill:unregister": {
        const params = (request.params ?? {}) as Record<string, unknown>;
        const skill = params.skill;
        if (typeof skill !== "string" || !SKILL_NAME_RE.test(skill)) {
          return error(IPCErrorCodes.INVALID_PARAMS, "invalid skill name");
        }
        const brokerKey = `${this.pluginId}.${skill}`;
        this.broker.unregisterSkill(brokerKey);
        this.registered.delete(brokerKey);
        return respond({ ok: true });
      }
      default:
        return error(
          IPCErrorCodes.METHOD_NOT_FOUND,
          `unknown method "${request.method}"`,
        );
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = globalThis.setInterval(() => {
      void this.ping();
    }, this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async ping(): Promise<void> {
    if (this.state !== "running") {
      return;
    }
    try {
      await this.request(
        "sandbox:heartbeat",
        {},
        this.options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      );
    } catch (err) {
      this.killAndCrash(
        err instanceof SandboxRequestTimeoutError
          ? "heartbeat timeout — sandbox unresponsive"
          : err instanceof Error
            ? err.message
            : String(err),
      );
    }
  }

  private cleanupRegisteredAndPending(reason: string): void {
    for (const brokerKey of [...this.registered.keys()]) {
      try {
        this.broker.unregisterSkill(brokerKey);
      } catch {
        // ignore
      }
    }
    this.registered.clear();
    for (const { reject, timer } of [...this.pending.values()]) {
      clearTimeout(timer);
      reject(new PluginCrashError(reason));
    }
    this.pending.clear();
  }

  private killAndCrash(reason: string): void {
    if (this.state === "crashed" || this.state === "stopped") {
      return;
    }
    this.state = "crashed";
    this.crashedReason = reason;
    this.clearHeartbeat();
    this.cleanupRegisteredAndPending(reason);
    if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGKILL");
    }
    this.onCrashed?.(reason);
  }

  private waitForExit(ms: number): Promise<number | null> {
    if (!this.child || this.child.exitCode !== null) {
      return Promise.resolve(this.child?.exitCode ?? null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      this.child!.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}

// Re-export so callers can construct transports with the same defaults.
export type { IPCSocketTransportOptions };
