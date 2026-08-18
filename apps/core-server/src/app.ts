import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
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
  /** Hook events to bridge to the WebSocket activity bus. */
  bridgedEvents?: string[];
}

const DEFAULT_BRIDGED_EVENTS = ["core:ready", "calendar:eventAdded"];

interface ExecuteBody {
  peerId?: string;
  serviceId: string;
  method: string;
  requestId?: string;
  arguments?: unknown;
  timeout?: number;
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

    this.registerCoreSkills();
    this.bridgeHookEvents();

    const remoteSkills = this.broker
      .listSkills()
      .filter((s) => !s.localOnly)
      .map((s) => s.skill);

    this.provider = new NetworkLightProvider({ port: 0, skills: remoteSkills });
    this.registry.register(this.provider);
    wireNetworkToBroker(this.provider, this.broker);
    await this.provider.start();

    this.httpServer = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    this.wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });
    this.wss.on("connection", (socket) => this.handleSocket(socket));

    const port = this.options.port ?? 8787;
    const host = this.options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(port, host, () => resolve());
    });

    this.peerTimer = setInterval(() => this.pollPeers(), 2000);
    this.pollPeers();
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

  private handleSocket(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as {
          type?: string;
          ts?: number;
        };
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
      return this.sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
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
    const skill = `${body.serviceId}.${body.method}`;
    const id =
      typeof body.requestId === "string" && body.requestId.length > 0
        ? body.requestId
        : randomUUID();

    this.broadcast("task:started", {
      requestId: id,
      serviceId: body.serviceId,
      method: body.method,
      peerId: body.peerId ?? null,
    });

    const result = body.peerId
      ? await this.executeRemote(body.peerId, skill, id, body.arguments)
      : await this.broker.handleHttp({ id, skill, payload: body.arguments });

    this.broadcast("task:completed", {
      requestId: id,
      serviceId: body.serviceId,
      method: body.method,
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
    const peer = this.provider.listPeers().find((p) => p.id === peerId);
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
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}
