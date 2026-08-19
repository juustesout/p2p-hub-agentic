import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { isLoopbackHost } from "./host";
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
  evaluateSettingsRisk,
  isPlainObject,
  normalizeSettings,
  validateJsonNestingDepth,
  validateObjectDepth,
  validatePayloadSize,
} from "@p2p-hub/sdk";
import type {
  EffectiveSettings,
  RiskAssessment,
  TaskResult,
} from "@p2p-hub/sdk";
import {
  CoreAIProvider,
  NetworkRegistry,
  PluginHost,
  TaskBroker,
  TrustConfirmationDeniedError,
  TrustTierGate,
  atomicWriteFile,
  readJsonFile,
  wireNetworkToBroker,
} from "@p2p-hub/core";
import type { TrustConfirmation } from "@p2p-hub/core";
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
  /**
   * Native tier-2 confirmation capability injected by the host. Absent by
   * default, which makes every tier-2 settings change fail closed (denied).
   */
  trustConfirmation?: TrustConfirmation;
  /**
   * Path to a user-chosen directory served as a static site under `/site/*`.
   * Optional; when absent, static serving is disabled. Resolved and validated
   * at startup (realpath containment, data-dir block, loopback-only).
   */
  siteRoot?: string;
}

const DEFAULT_BRIDGED_EVENTS = ["core:ready", "calendar:eventAdded"];

/** Safe identifier for a skill's `<serviceId>` / `<method>` segments. */
const IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
/** Safe identifier for a peer reference (per-boot instance id or persistent peerId). */
const PEER_ID_RE = /^[a-zA-Z0-9-]{1,128}$/;

/** URL prefix under which the static site is served. */
const SITE_PREFIX = "/site";

/** Security headers applied to every served static asset. */
const SITE_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;",
};

const SITE_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const SITE_DEFAULT_MIME = "application/octet-stream";

/** Explicit, extension-only MIME lookup (never trusts a user-provided type). */
function SITE_CONTENT_TYPE(extension: string): string {
  const lower = extension.toLowerCase();
  return SITE_MIME_TYPES[lower] ?? SITE_DEFAULT_MIME;
}

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
  private readonly trustGate: TrustTierGate;
  private siteRootReal: string | null = null;

  constructor(options: CoreServerOptions) {
    this.options = options;
    this.host = new PluginHost({
      pluginsDir: options.pluginsDir,
      dataDir: options.dataDir,
      masterKey: options.masterKey,
    });
    this.broker = this.host.taskBroker();
    this.trustGate = new TrustTierGate(options.trustConfirmation);
  }

  async start(): Promise<void> {
    await this.host.boot();

    this.bootToken = this.resolveBootToken();

    this.initSite();

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
      if (await this.tryServeSite(req, res, path)) {
        return;
      }
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
      if (req.method === "GET" && path === "/api/settings") {
        const settings = await this.loadSettings();
        return this.sendJson(res, 200, {
          settings,
          risk: evaluateSettingsRisk(settings),
        });
      }
      if (req.method === "POST" && path === "/api/settings/apply") {
        const body = await readJson(req);
        if (!isPlainObject(body)) {
          return this.sendJson(res, 400, {
            ok: false,
            error: "apply expects a settings object",
          });
        }
        const settings = normalizeSettings(body);
        const risk = evaluateSettingsRisk(settings);
        try {
          await this.trustGate.authorize(
            risk.aggregate,
            settingsApplySummary(risk),
            { authenticated: true },
          );
        } catch (err) {
          if (err instanceof TrustConfirmationDeniedError) {
            return this.sendJson(res, 403, {
              ok: false,
              error: "confirmation required",
              requiredTier: err.requiredTier,
            });
          }
          throw err;
        }
        await this.saveSettings(settings);
        this.broadcast("settings:updated", { settings, risk });
        return this.sendJson(res, 200, { ok: true, risk });
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

  // ---------------------------------------------------------------------
  // Static site serving (loopback-only, hardened)
  // ---------------------------------------------------------------------

  /**
   * Attempt to serve a request from the configured site root. Returns `true`
   * (and writes a response) when the request targeted the `/site` prefix;
   * returns `false` so the caller can continue routing when it did not.
   *
   * Hardening: raw `..`/`%2e`/`%00` segments are rejected before decoding, the
   * decoded sub-path is re-checked segment-by-segment (dot-segments, dotfiles,
   * backslashes, null bytes), and the final file is resolved with `realpath`
   * and required to stay under the real site root (blocks symlink escapes).
   * Every reject is a 404 — never 403 — to avoid leaking directory structure.
   */
  private async tryServeSite(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    const root = this.siteRootReal;
    if (!root) {
      return false;
    }
    if (pathname !== SITE_PREFIX && !pathname.startsWith(SITE_PREFIX + "/")) {
      return false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      this.sendSiteEmpty(res, 405, false);
      return true;
    }

    const rawSubpath = pathname.slice(SITE_PREFIX.length);
    if (
      /%2e/i.test(rawSubpath) ||
      /%00/i.test(rawSubpath) ||
      rawSubpath.includes("..") ||
      rawSubpath.includes("\0")
    ) {
      this.sendSiteEmpty(res, 404, false);
      return true;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSubpath);
    } catch {
      this.sendSiteEmpty(res, 404, false);
      return true;
    }

    const segments = decoded.split("/").filter((segment) => segment.length > 0);
    for (const segment of segments) {
      // Dot-segments (`.`, `..`) and dotfiles (`.env`, `.git`) all begin with
      // a dot and are default-denied. Backslashes and null bytes are never
      // valid in a served path.
      if (
        segment.startsWith(".") ||
        segment.includes("\\") ||
        segment.includes("\0")
      ) {
        this.sendSiteEmpty(res, 404, false);
        return true;
      }
    }

    let candidate = path.join(root, ...segments);
    try {
      candidate = fs.realpathSync(candidate);
    } catch {
      this.sendSiteEmpty(res, 404, false);
      return true;
    }
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      this.sendSiteEmpty(res, 404, false);
      return true;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(candidate);
    } catch {
      this.sendSiteEmpty(res, 404, false);
      return true;
    }

    if (stat.isDirectory()) {
      try {
        const index = fs.realpathSync(path.join(candidate, "index.html"));
        if (index !== root && !index.startsWith(root + path.sep)) {
          this.sendSiteEmpty(res, 404, false);
          return true;
        }
        candidate = index;
      } catch {
        this.sendSiteEmpty(res, 404, false);
        return true;
      }
    }

    let contents: Buffer;
    try {
      contents = await fsp.readFile(candidate);
    } catch {
      this.sendSiteEmpty(res, 404, false);
      return true;
    }

    this.sendSiteFile(res, req.method === "HEAD", contents, candidate);
    return true;
  }

  private sendSiteEmpty(
    res: http.ServerResponse,
    status: number,
    withHeaders: boolean,
  ): void {
    res.writeHead(status, withHeaders ? SITE_SECURITY_HEADERS : {});
    res.end();
  }

  private sendSiteFile(
    res: http.ServerResponse,
    headOnly: boolean,
    contents: Buffer,
    filePath: string,
  ): void {
    const contentType = SITE_CONTENT_TYPE(path.extname(filePath));
    res.writeHead(200, {
      ...SITE_SECURITY_HEADERS,
      "Content-Type": contentType,
      "Content-Length": contents.length,
    });
    res.end(headOnly ? undefined : contents);
  }

  // ---------------------------------------------------------------------
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

  /** Path of the minimal settings file (only the effective security flags). */
  private settingsFile(): string {
    return path.join(this.options.dataDir, "settings.json");
  }

  private async loadSettings(): Promise<EffectiveSettings> {
    const stored = await readJsonFile<Partial<EffectiveSettings>>(
      this.settingsFile(),
    );
    return normalizeSettings(stored ?? undefined);
  }

  private async saveSettings(settings: EffectiveSettings): Promise<void> {
    await atomicWriteFile(this.settingsFile(), JSON.stringify(settings));
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

  /**
   * Resolve and validate `options.siteRoot` at startup. Static serving is
   * loopback-only: a non-loopback bind disables the site with a loud warning
   * (no silent widening). The resolved realpath is the canonical root for
   * containment on every request.
   */
  private initSite(): void {
    const siteRoot = this.options.siteRoot;
    if (!siteRoot) {
      this.siteRootReal = null;
      return;
    }

    const host = this.options.host ?? "127.0.0.1";
    if (!isLoopbackHost(host)) {
      console.warn(
        "[core-server] PeerSite: siteRoot configured but the bridge is not " +
          "bound to loopback; static serving is refused (loopback-only).",
      );
      this.siteRootReal = null;
      return;
    }

    let rootReal: string;
    try {
      rootReal = fs.realpathSync(path.resolve(siteRoot));
    } catch {
      throw new Error(
        `PeerSite siteRoot "${siteRoot}" does not exist or cannot be resolved`,
      );
    }

    const dataReal = fs.realpathSync(this.options.dataDir);
    if (rootReal === dataReal || rootReal.startsWith(dataReal + path.sep)) {
      throw new Error(
        "PeerSite siteRoot must not be the agent data directory or a path inside it",
      );
    }

    this.siteRootReal = rootReal;
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

/** Human-readable summary shown to the native tier-2 confirmation prompt. */
function settingsApplySummary(risk: RiskAssessment): string {
  if (risk.findings.length === 0) {
    return "Apply security settings (no known risks)";
  }
  return `Apply security settings (${risk.aggregate}): ${risk.findings
    .map((f) => f.id)
    .join(", ")}`;
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
