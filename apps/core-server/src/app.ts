import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  generateBootToken,
  safeTokenEqual,
  tokenFromAuthorization,
  tokenFromQuery,
  writeBootToken,
} from "./auth";
import {
  MAX_PAYLOAD_BYTES,
  ObjectDepthExceededError,
  PayloadTooLargeError,
  validateJsonNestingDepth,
  validateObjectDepth,
  validatePayloadSize,
} from "@p2p-hub/sdk";
import type { TaskResult } from "@p2p-hub/sdk";
import {
  CoreAIProvider,
  NetworkRegistry,
  PluginHost,
  TaskBroker,
  wireNetworkToBroker,
} from "@p2p-hub/core";
import { NetworkLightProvider } from "@p2p-hub/network-light";

export interface CoreServerOptions {
  pluginsDir: string;
  dataDir: string;
  host?: string;
  port?: number;
  /** Vault master passphrase (falls back to env / dev key). */
  masterKey?: string;
  /** Explicit boot token; overrides env and auto-generation. */
  bootToken?: string;
  /** Hook events to bridge to the WebSocket activity bus. */
  bridgedEvents?: string[];
}

const DEFAULT_BRIDGED_EVENTS = ["core:ready", "calendar:eventAdded"];

/** Safe identifier for a skill's `<serviceId>` / `<method>` segments. */
const IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
/** Safe identifier for a peer reference (per-boot instance id or persistent peerId). */
const PEER_ID_RE = /^[a-zA-Z0-9-]{1,128}$/;

interface ExecuteBody {
  peerId?: string;
  serviceId: string;
  method: string;
  requestId?: string;
  arguments?: unknown;
}

/**
 * Thin HTTP + WebSocket bridge that exposes a running `@p2p-hub/core` host to
 * the desktop shell. It is the only place where raw vault values are read, and
 * it deliberately never returns secret values over HTTP — the vault API only
 * returns existence + metadata.
 */
export class CoreServer {
  private readonly options: CoreServerOptions;
  private readonly host: PluginHost;
  private readonly broker: TaskBroker;
  private readonly registry = new NetworkRegistry();
  private provider: NetworkLightProvider | null = null;

  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private readonly knownPeers = new Set<string>();
  private peerTimer: NodeJS.Timeout | null = null;
  private bootToken = "";

  constructor(options: CoreServerOptions) {
    this.options = options;
    this.host = new PluginHost({
      pluginsDir: options.pluginsDir,
      dataDir: options.dataDir,
      masterKey: options.masterKey,
    });
    this.broker = this.host.taskBroker();
  }

  async start(): Promise<void> {
    await this.host.boot();

    this.bootToken = this.resolveBootToken();

    this.registerCoreSkills();
    this.bridgeHookEvents();

    const remoteSkills = this.broker
      .listSkills()
      .filter((s) => !s.localOnly)
      .map((s) => s.skill);

    const identity = await this.host.identityManager().getOrCreateIdentity();
    this.provider = new NetworkLightProvider({
      port: 0,
      skills: remoteSkills,
      identity,
    });
    this.registry.register(this.provider);
    wireNetworkToBroker(this.provider, this.broker);
    await this.provider.start();

    this.httpServer = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: "/ws",
      maxPayload: MAX_PAYLOAD_BYTES,
    });
    this.wss.on("connection", (socket, request) =>
      this.handleSocket(socket, request),
    );

    const port = this.options.port ?? 8787;
    const host = this.options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(port, host, () => resolve());
    });

    this.peerTimer = setInterval(() => this.pollPeers(), 2000);
    this.pollPeers();
  }

  /** Bound address of the HTTP server, or null before `start()`. */
  address(): { host: string; port: number } | null {
    const addr = this.httpServer?.address();
    if (addr && typeof addr === "object") {
      return { host: addr.address, port: addr.port };
    }
    return null;
  }

  async stop(): Promise<void> {
    if (this.peerTimer) {
      clearInterval(this.peerTimer);
      this.peerTimer = null;
    }
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    if (this.provider) {
      await this.provider.stop();
      this.provider = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  // ---------------------------------------------------------------------
  // Core wiring
  // ---------------------------------------------------------------------

  private registerCoreSkills(): void {
    this.broker.registerSkill(
      "core.echo",
      async (payload) => payload,
      { localOnly: false, httpExposed: true },
    );

    const aiProvider = new CoreAIProvider({ vault: this.host.vaultManager() });
    this.broker.registerSkill(
      "core.ai.generateText",
      async (payload) => {
        const { prompt, system, model } = (payload ?? {}) as {
          prompt?: unknown;
          system?: unknown;
          model?: unknown;
        };
        if (typeof prompt !== "string") {
          throw new Error("generateText expects { prompt: string }");
        }
        return aiProvider.generateText({
          prompt,
          system: typeof system === "string" ? system : undefined,
          model: typeof model === "string" ? model : undefined,
        });
      },
      { localOnly: true, httpExposed: true },
    );
  }

  private bridgeHookEvents(): void {
    const events = new Set<string>(DEFAULT_BRIDGED_EVENTS);
    for (const event of this.options.bridgedEvents ?? []) {
      events.add(event);
    }
    for (const plugin of this.host.listPlugins()) {
      for (const event of plugin.exposedEvents ?? []) {
        events.add(event);
      }
    }
    for (const event of events) {
      this.host.hookRegistry().on(event, (payload) => {
        this.broadcast(event, payload);
      });
    }
  }

  private async pollPeers(): Promise<void> {
    if (!this.provider) {
      return;
    }
    const peers = this.provider.listPeers();
    const current = new Set(peers.map((p) => p.id));
    for (const peer of peers) {
      if (!this.knownPeers.has(peer.id)) {
        this.knownPeers.add(peer.id);
        this.broadcast("peer:connected", {
          peerId: peer.id,
          name: peer.name ?? peer.id,
        });
      }
    }
    for (const id of [...this.knownPeers]) {
      if (!current.has(id)) {
        this.knownPeers.delete(id);
        this.broadcast("peer:disconnected", { peerId: id });
      }
    }
  }

  // ---------------------------------------------------------------------
  // WebSocket (activity bus)
  // ---------------------------------------------------------------------

  private handleSocket(socket: WebSocket, request: http.IncomingMessage): void {
    if (!this.isAuthorized(request)) {
      socket.close(1008, "unauthorized");
      return;
    }
    this.clients.add(socket);
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as {
          type?: string;
          ts?: number;
        };
        validateObjectDepth(message);
        if (message.type === "ping") {
          socket.send(JSON.stringify({ type: "pong", ts: message.ts ?? Date.now() }));
        }
      } catch {
        // Ignore malformed client frames.
      }
    });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
  }

  private broadcast(event: string, payload: unknown): void {
    const message = JSON.stringify({
      type: "event",
      event,
      payload,
      ts: Date.now(),
    });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  // ---------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path.startsWith("/api/") && !this.isAuthorized(req)) {
      return this.sendJson(res, 401, { error: "unauthorized" });
    }

    try {
      if (req.method === "GET" && path === "/api/health") {
        return this.sendJson(res, 200, { ok: true, uptime: process.uptime() });
      }
      if (req.method === "GET" && path === "/api/capabilities") {
        return this.sendJson(res, 200, this.buildCapabilities());
      }
      if (req.method === "POST" && path === "/api/execute") {
        const body = (await readJson(req)) as ExecuteBody;
        const result = await this.execute(body);
        return this.sendJson(res, 200, result);
      }
      if (req.method === "GET" && path === "/api/vault/keys") {
        const vault = this.host.vaultManager();
        return this.sendJson(res, 200, {
          keys: await vault.listSecretMetadata(),
          masterKeyConfigured: !vault.usesFallbackKey,
        });
      }
      if (req.method === "GET" && path === "/api/vault/model") {
        const vault = this.host.vaultManager();
        const hasModel = await vault.hasSecret("ai.model");
        const hasBaseUrl = await vault.hasSecret("ai.baseUrl");
        const hasApiKey = await vault.hasSecret("ai.apiKey");
        return this.sendJson(res, 200, { hasModel, hasBaseUrl, hasApiKey });
      }
      if (req.method === "POST" && path === "/api/vault/set") {
        const body = (await readJson(req)) as { key?: unknown; value?: unknown };
        if (typeof body.key !== "string" || typeof body.value !== "string") {
          return this.sendJson(res, 400, {
            ok: false,
            error: "set expects { key: string, value: string }",
          });
        }
        const reserved = this.reservedPrefixFor(body.key);
        if (reserved) {
          return this.sendJson(res, 403, {
            ok: false,
            error: `vault key "${body.key}" is in the reserved namespace "${reserved}" and cannot be modified over HTTP`,
          });
        }
        await this.host.vaultManager().setSecret(body.key, body.value);
        this.broadcast("vault:updated", { key: body.key, action: "set" });
        return this.sendJson(res, 200, { ok: true, key: body.key });
      }
      if (req.method === "DELETE" && path.startsWith("/api/vault/")) {
        const key = decodeURIComponent(path.slice("/api/vault/".length));
        const reserved = this.reservedPrefixFor(key);
        if (reserved) {
          return this.sendJson(res, 403, {
            ok: false,
            error: `vault key "${key}" is in the reserved namespace "${reserved}" and cannot be modified over HTTP`,
          });
        }
        const deleted = await this.host.vaultManager().deleteSecret(key);
        this.broadcast("vault:updated", { key, action: "delete" });
        return this.sendJson(res, 200, { ok: true, deleted });
      }

      return this.sendJson(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return this.sendJson(res, 413, { error: "request body too large" });
      }
      if (err instanceof ObjectDepthExceededError || err instanceof SyntaxError) {
        return this.sendJson(res, 400, { error: "invalid request body" });
      }
      console.error("[core-server] request failed:", err);
      return this.sendJson(res, 500, { error: "internal error" });
    }
  }

  private buildCapabilities(): unknown {
    const plugins = this.host.listPlugins().map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      kind: p.kind,
      version: p.version,
    }));

    const skills = this.broker.listSkills().map((s) => ({
      skill: s.skill,
      localOnly: s.localOnly,
      httpExposed: s.httpExposed,
      pluginId: s.skill.split(".")[0] ?? "",
    }));

    const events = new Set<string>(DEFAULT_BRIDGED_EVENTS);
    for (const plugin of this.host.listPlugins()) {
      for (const event of plugin.exposedEvents ?? []) {
        events.add(event);
      }
    }
    events.add("peer:connected");
    events.add("peer:disconnected");
    events.add("task:started");
    events.add("task:completed");
    events.add("vault:updated");

    const peers = this.provider
      ? this.provider.listPeers().map((peer) => ({
          id: peer.id,
          peerId: peer.peerId ?? null,
          name: peer.name ?? peer.id,
          address: peer.address,
          skills: peer.skills,
          transport: this.provider!.id,
          trust: "self-signed",
        }))
      : [];

    return {
      local: {
        plugins,
        skills,
        events: [...events],
        connection: {
          providerId: this.provider?.id ?? null,
          ready: this.provider?.isReady() ?? false,
        },
      },
      remote: { peers },
    };
  }

  private async execute(body: ExecuteBody): Promise<TaskResult> {
    const id =
      typeof body.requestId === "string" && body.requestId.length > 0
        ? body.requestId
        : randomUUID();

    const { serviceId, method } = body;
    if (
      typeof serviceId !== "string" ||
      typeof method !== "string" ||
      !IDENTIFIER_RE.test(serviceId) ||
      !IDENTIFIER_RE.test(method)
    ) {
      return {
        taskId: id,
        status: "error",
        error: "execute expects serviceId and method as safe identifier strings",
      };
    }
    if (
      body.peerId !== undefined &&
      (typeof body.peerId !== "string" || !PEER_ID_RE.test(body.peerId))
    ) {
      return {
        taskId: id,
        status: "error",
        error: "execute expects peerId as a safe identifier string",
      };
    }

    const skill = `${serviceId}.${method}`;

    this.broadcast("task:started", {
      requestId: id,
      serviceId,
      method,
      peerId: body.peerId ?? null,
    });

    const result = body.peerId
      ? await this.executeRemote(body.peerId, skill, id, body.arguments)
      : await this.broker.handleHttp({ id, skill, payload: body.arguments });

    this.broadcast("task:completed", {
      requestId: id,
      serviceId,
      method,
      peerId: body.peerId ?? null,
      status: result.status,
    });

    return result;
  }

  private async executeRemote(
    peerId: string,
    skill: string,
    id: string,
    args: unknown,
  ): Promise<TaskResult> {
    if (!this.provider) {
      return { taskId: id, status: "error", error: "no active network provider" };
    }
    const peers = this.provider.listPeers();
    // Resolve by the persistent `peerId` (identity) first — the same concept
    // `ctx.network.sendTask` uses — and fall back to the per-boot instance
    // `id` for clients that still address peers by session id.
    const peer =
      peers.find((p) => p.peerId === peerId) ??
      peers.find((p) => p.id === peerId);
    if (!peer) {
      return { taskId: id, status: "error", error: `unknown peer "${peerId}"` };
    }
    return this.provider.sendTask(peer, { id, skill, payload: args });
  }

  /**
   * Return the reserved namespace a key falls into (e.g. `ai.`), or null when
   * the key is writable. This mirrors the `assertWritable` guard the plugin
   * loader enforces on the plugin-facing {@link VaultContext}; the HTTP client
   * must not be able to rewrite the AI key/endpoint that core later uses.
   */
  private reservedPrefixFor(key: string): string | null {
    const reserved = this.host.vaultManager().reservedPrefixes;
    return reserved.find((p) => key.startsWith(p)) ?? null;
  }

  /**
   * Resolve (or generate) the boot token and persist it to the data directory
   * so the desktop shell can read it out-of-band. The env override exists for
   * headless/tests; a token is always written so `get_boot_token` never races
   * a missing file.
   */
  private resolveBootToken(): string {
    const token =
      this.options.bootToken ??
      process.env.P2P_HUB_BOOT_TOKEN ??
      generateBootToken();
    writeBootToken(this.options.dataDir, token);
    return token;
  }

  /** Authorize a request via its `Authorization` header or `?token=` query. */
  private isAuthorized(req: http.IncomingMessage): boolean {
    return (
      safeTokenEqual(tokenFromAuthorization(req.headers.authorization), this.bootToken) ||
      safeTokenEqual(tokenFromQuery(req), this.bootToken)
    );
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
  ): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buf.length;
    if (received > MAX_PAYLOAD_BYTES) {
      throw new PayloadTooLargeError(received, MAX_PAYLOAD_BYTES);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  validatePayloadSize(raw, MAX_PAYLOAD_BYTES);
  validateJsonNestingDepth(raw);
  const parsed: unknown = JSON.parse(raw);
  validateObjectDepth(parsed);
  return parsed;
}
