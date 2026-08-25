import * as http from "node:http";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { isLoopbackHost } from "./host";
import { DEFAULT_HTTP_PORT } from "./config";
import { createMediaSkillHandler } from "./media";
import {
  generateBootToken,
  generateSiteToken,
  safeTokenEqual,
  tokenFromAuthorization,
  tokenFromQuery,
  writeBootToken,
} from "./auth";
import {
  MAX_PAYLOAD_BYTES,
  ObjectDepthExceededError,
  PayloadTooLargeError,
  asContactLookup,
  buildWebsiteRequest,
  evaluateSettingsRisk,
  isPlainObject,
  normalizeSettings,
  parseWebsiteResponse,
  sanitizeText,
  validateJsonNestingDepth,
  validateObjectDepth,
  validatePayloadSize,
  validateTextLength,
} from "@p2p-hub/sdk";
import type {
  ChildCertificate,
  ChildIdentity,
  EffectiveSettings,
  RiskAssessment,
  TaskResult,
  WebsiteErrorCode,
} from "@p2p-hub/sdk";
import {
  CoreAIProvider,
  NetworkRegistry,
  PluginHost,
  TaskBroker,
  TrustConfirmationDeniedError,
  TrustTierGate,
  atomicWriteFile,
  contentTypeForPath,
  isValidAgentLabel,
  mirrorDestination,
  mirrorFetchAndStore,
  readJsonFile,
  resolveAndContainFile,
  wireNetworkToBroker,
} from "@p2p-hub/core";
import type { TaskApprovalGate, TrustConfirmation } from "@p2p-hub/core";
import { NetworkLightProvider } from "@p2p-hub/network-light";

export interface CoreServerOptions {
  pluginsDir: string;
  dataDir: string;
  host?: string;
  port?: number;
  /**
   * Port for the network-light P2P transport (mDNS advertisement + TLS).
   * Defaults to 0 (ephemeral). The config loader feeds `P2P_HUB_P2P_PORT` →
   * `P2P_PORT` → `32837` here.
   */
  p2pPort?: number;
  /**
   * Bind host for the network-light P2P transport. Defaults to `0.0.0.0`
   * (the transport authenticates every peer on the wire and never holds the
   * boot token, so a wildcard bind is safe). The config loader feeds
   * `P2P_BIND_HOST` here.
   */
  p2pBindHost?: string;
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
   * A1/Slice 2: per-invocation human approval for agent-initiated remote
   * skills that need Tier-2 step-up. Delegated to the same native confirmation
   * channel as `trustConfirmation` (an `agent-task-approval` prompt). Absent by
   * default, which makes every agent task that needs approval fail closed.
   */
  taskApprovalGate?: TaskApprovalGate;
  /**
   * Start the P2P network transport (LAN discovery + inbound capability calls).
   * Default `true` — the core-server is by definition the P2P-capable backend.
   * Set to `false` for a fully local-only server: no identity is created, no
   * provider is started, nothing is advertised on the LAN. This mirrors the
   * `PluginHost`'s lazy identity/networking gate — a local-only server must not
   * fail hard on a corrupt vault.
   */
  networking?: boolean;
}

const DEFAULT_BRIDGED_EVENTS = ["core:ready", "calendar:eventAdded"];

/** Safe identifier for a skill's `<serviceId>` / `<method>` segments. */
const IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
/** Safe identifier for a peer reference (per-boot instance id or persistent peerId). */
const PEER_ID_RE = /^[a-zA-Z0-9-]{1,128}$/;

/** URL prefix under which the static site is served. */
const SITE_PREFIX = "/site";

/** URL prefix under which plugin UI assets are served. */
const UI_PREFIX = "/ui";

/**
 * URL prefix under which a *remote peer's* mirrored P2P website is served:
 * `/remote-site/<peerId>/*`. Assets are fetched over the P2P `p2p-hub:website:v1`
 * capability on request and stored under `<dataDir>/sites/<peerId>`. This is
 * the render side of the Fase-2 end criterion — it proves the site flow works
 * with no public HTTP server on the *origin* peer.
 */
const REMOTE_SITE_PREFIX = "/remote-site";

/** URL prefix under which the scoped PeerSite API is served. */
const PEERSITE_PREFIX = "/peersite";

/** Safe identifier for a plugin id (matches the manifest `id` rule). */
const PLUGIN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Max characters accepted in a `/peersite/message` body. */
const PEERSITE_MESSAGE_MAX_LENGTH = 10_000;

/** Per-source-IP message rate limit (fixed window). */
const MESSAGE_RATE_LIMIT = 30;
const MESSAGE_RATE_WINDOW_MS = 60_000;

/** Security headers applied to every served static asset. */
const SITE_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;",
};

/**
 * Security headers applied to every `/ui/<pluginId>` response. Stricter than
 * the site headers: the plugin UI runs in a sandboxed iframe and must make no
 * network calls of its own — every capability goes through the shell bridge
 * (postMessage, which CSP does not govern) — so `connect-src 'none'` blocks
 * fetch/XHR/WebSocket outright. `'self'` here means the core-server origin,
 * which is what the iframe document is served from.
 */
const UI_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; worker-src 'self'; connect-src 'none'; " +
    "base-uri 'none'; form-action 'none'; object-src 'none'",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

interface ExecuteBody {
  peerId?: string;
  serviceId: string;
  method: string;
  requestId?: string;
  arguments?: unknown;
}

/**
 * Structural view of the activated `peersite` plugin. Core-server stays
 * type-ignorant of the plugin package: it only needs the site root the plugin
 * owns, read through `host.getActivated("peersite")` behind a `typeof` guard
 * (the same read-seam pattern as `ctx.trust`/`asContactLookup`).
 */
interface PeerSitePlugin {
  getSiteRoot(): Promise<string | null>;
  resolveAccessRequest?(requestId: string, approved: boolean): Promise<boolean>;
}

/**
 * Structural view of the activated `media` plugin. Core-server only resolves
 * the media-access confirmation requests the plugin raises: it listens for
 * `media:accessRequested`, runs the native Tier-2 confirmation (the
 * `TrustConfirmation` it already owns — same route as peersite's
 * `resolveAccessRequest`), and resolves back into the plugin.
 */
interface MediaPlugin {
  resolveMediaAccess?(requestId: string, granted: boolean): Promise<boolean>;
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
  private lanSiteAllowed = true;
  private siteToken = "";
  private peerId = "";
  private readonly messageTimestamps = new Map<string, number[]>();

  constructor(options: CoreServerOptions) {
    this.options = options;
    this.host = new PluginHost({
      pluginsDir: options.pluginsDir,
      dataDir: options.dataDir,
      masterKey: options.masterKey,
      taskApprovalGate: options.taskApprovalGate,
    });
    this.broker = this.host.taskBroker();
    this.trustGate = new TrustTierGate(options.trustConfirmation);
  }

  async start(): Promise<void> {
    await this.host.boot();

    this.bootToken = this.resolveBootToken();

    this.siteToken = generateSiteToken();

    await this.initSite();

    this.registerCoreSkills();
    this.registerMediaSkill();
    this.bridgeHookEvents();
    this.registerPeerAccessHandler();
    this.registerMediaAccessHandler();

    if (this.options.networking !== false) {
      await this.startNetworking();
    } else {
      console.warn(
        "[core-server] networking disabled: no LAN discovery, no inbound P2P " +
          "calls, no peer identity is created. Local-only mode.",
      );
    }

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

    const port = this.options.port ?? DEFAULT_HTTP_PORT;
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

  /**
   * Start the P2P transport behind the same identity/vault gate as
   * `PluginHost.startNetworking`. The core-server is *by definition* where
   * network functionality is expected, so a corrupt vault fails loudly here
   * (deliberate — see CLAUDE.md "Core-server identity/vault dependency").
   * Callers that want a local-only server pass `networking: false` and this
   * block is never reached.
   */
  private async startNetworking(): Promise<void> {
    const remoteSkills = this.broker
      .listSkills()
      .filter((s) => !s.localOnly)
      .map((s) => s.skill);

    const identity = await this.host.identityManager().getOrCreateIdentity();
    this.peerId = identity.peerId;
    this.provider = new NetworkLightProvider({
      port: this.options.p2pPort ?? 0,
      host: this.options.p2pBindHost ?? "0.0.0.0",
      skills: remoteSkills,
      identity,
      // Fase 1B: prove this identity on the wire. The private key stays in
      // IdentityManager; the provider only receives signed bytes.
      identitySigner: (data) => this.host.identityManager().sign(data),
    });
    this.registry.register(this.provider);
    wireNetworkToBroker(this.provider, this.broker);
    await this.provider.start();
  }

  private registerCoreSkills(): void {
    this.broker.registerSkill(
      "core.echo",
      async (payload) => payload,
      {
        localOnly: false,
        httpExposed: true,
        remote: { gate: "any" },
        capabilityType: "action",
      },
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
      {
        localOnly: true,
        httpExposed: true,
        capabilityType: "action",
      },
    );
  }

  /**
   * Register the `core.media.request` skill — the `p2p-hub:media:v1` capability
   * (design doc "Decision 2").
   *
   * A remote peer asks for live camera/microphone access. The envelope is
   * parsed fail-closed through the SDK contract (no identity/token fields on
   * the wire), then the request must be approved by the shell's native Tier-2
   * confirmation (`confirmMediaRequest`) — the browser's `getUserMedia` UI is
   * deliberately not part of this path. A grant is minted only after that
   * approval; there is no route that skips it.
   *
   * Access is `verified-contact` only (media is sensitive, so an established
   * relationship is required before the native prompt is even shown), it is
   * NOT HTTP-exposed (the local HTTP bridge is not a media-request surface),
   * and a per-peer cooldown stops a peer from spamming native prompts.
   */
  private registerMediaSkill(): void {
    this.broker.registerSkill(
      "core.media.request",
      createMediaSkillHandler({ trustGate: this.trustGate }),
      {
        localOnly: false,
        httpExposed: false,
        remote: { gate: "verified-contact" },
        capabilityType: "action",
      },
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

  /**
   * Handle a `peersite:accessRequested` event emitted by the peersite plugin
   * after it has verified a knock. The request is resolved through the host's
   * native tier-2 confirmation (`confirmPeerAccess`, fail-closed), then passed
   * back to the plugin via `resolveAccessRequest`.
   */
  private registerPeerAccessHandler(): void {
    this.host
      .hookRegistry()
      .on("peersite:accessRequested", (payload) => {
        void this.handlePeerAccessRequest(payload);
      });
  }

  private async handlePeerAccessRequest(payload: unknown): Promise<void> {
    const req = (payload ?? {}) as {
      requestId?: unknown;
      peerId?: unknown;
      claim?: unknown;
      expiresInMs?: unknown;
    };
    if (
      typeof req.requestId !== "string" ||
      typeof req.peerId !== "string" ||
      typeof req.claim !== "string" ||
      typeof req.expiresInMs !== "number"
    ) {
      return;
    }

    const approved = await this.trustGate.confirmPeerAccess(
      req.peerId,
      req.claim,
      req.expiresInMs,
    );

    const plugin = this.peersite();
    if (plugin?.resolveAccessRequest) {
      await plugin.resolveAccessRequest(req.requestId, approved);
    }
  }

  /**
   * Handle a `media:accessRequested` event emitted by the media plugin before
   * any SDP/ICE exchange with a peer. The request is resolved through the
   * host's native tier-2 confirmation (`confirmMediaRequest`, fail-closed —
   * the same `TrustConfirmation` core-server already owns for peersite), then
   * passed back to the plugin via `resolveMediaAccess`. The plugin never
   * calls `requestMediaAccess` itself; it only raises the hook.
   */
  private registerMediaAccessHandler(): void {
    this.host
      .hookRegistry()
      .on("media:accessRequested", (payload) => {
        void this.handleMediaAccessRequest(payload);
      });
  }

  private async handleMediaAccessRequest(payload: unknown): Promise<void> {
    const req = (payload ?? {}) as {
      requestId?: unknown;
      peerId?: unknown;
      kind?: unknown;
      direction?: unknown;
      expiresInMs?: unknown;
    };
    if (
      typeof req.requestId !== "string" ||
      typeof req.peerId !== "string" ||
      (req.kind !== "camera" && req.kind !== "microphone") ||
      typeof req.expiresInMs !== "number"
    ) {
      return;
    }

    const granted = await this.trustGate.confirmMediaRequest(
      req.peerId,
      req.kind,
      undefined,
      req.expiresInMs,
    );

    const plugin = this.media();
    if (plugin?.resolveMediaAccess) {
      await plugin.resolveMediaAccess(req.requestId, granted);
    }
  }

  private async pollPeers(): Promise<void> {
    if (!this.provider) {
      return;
    }
    // Warm the provider's capability cache for every discovered peer. Without
    // this, `listPeers()` returns peers with an empty `skills` set until some
    // other component happens to run a capability probe. `discover(skill)`
    // probes every peer regardless of the requested skill, so a single call
    // with any network-exposed skill name warms the whole cache; probing is
    // cached per peer after the first successful handshake, so this is cheap
    // once warm.
    const probeSkill = this.broker
      .listSkills()
      .find((s) => !s.localOnly)?.skill;
    if (probeSkill !== undefined) {
      this.provider.discover(probeSkill).catch(() => {
        // Probe failures are retried internally (PROBE_RETRY_MS); never let a
        // peer that is momentarily unreachable take down the poll loop.
      });
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
    if (!this.isAuthorizedWs(request)) {
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
      if (await this.tryServePeersite(req, res, path)) {
        return;
      }
      if (await this.tryServeUi(req, res, path)) {
        return;
      }
      if (await this.tryServeRemoteSite(req, res, path)) {
        return;
      }
      if (req.method === "GET" && path === "/api/health") {
        return this.sendJson(res, 200, { ok: true, uptime: process.uptime() });
      }
      if (req.method === "GET" && path === "/api/capabilities") {
        return this.sendJson(res, 200, await this.buildCapabilities());
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
      if (req.method === "GET" && path === "/api/agents") {
        const agents: unknown[] = [];
        for (const { label } of await this.host
          .identityManager()
          .listChildIdentities()) {
          const child = await this.host.identityManager().getChildIdentity(label);
          if (child) {
            agents.push(agentView(child));
          }
        }
        return this.sendJson(res, 200, { agents });
      }
      if (req.method === "POST" && path === "/api/agents") {
        const body = (await readJson(req)) as { label?: unknown };
        if (typeof body.label !== "string" || !isValidAgentLabel(body.label)) {
          return this.sendJson(res, 400, {
            ok: false,
            error: "create expects a valid agent label (^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$)",
          });
        }
        const child = await this.host
          .identityManager()
          .deriveChildIdentity(body.label);
        return this.sendJson(res, 200, { ok: true, agent: agentView(child) });
      }
      if (req.method === "DELETE" && path.startsWith("/api/agents/")) {
        const label = decodeURIComponent(path.slice("/api/agents/".length));
        if (!isValidAgentLabel(label)) {
          return this.sendJson(res, 400, {
            ok: false,
            error: `invalid agent label "${label}"`,
          });
        }
        const deleted = await this.host
          .identityManager()
          .deleteChildIdentity(label);
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
    const root = await this.effectiveSiteRoot();
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

    // Containment (dot-segments, dotfiles, symlinks, data-dir escapes) is
    // decided once, in the shared helper — identical to the P2P fetchAsset path.
    const resolved = resolveAndContainFile(root, decoded);
    if (!resolved) {
      this.sendSiteEmpty(res, 404, false);
      return true;
    }

    let contents: Buffer;
    try {
      contents = await fsp.readFile(resolved);
    } catch {
      this.sendSiteEmpty(res, 404, false);
      return true;
    }

    this.sendSiteFile(res, req.method === "HEAD", contents, resolved);
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
    const contentType = contentTypeForPath(filePath);
    res.writeHead(200, {
      ...SITE_SECURITY_HEADERS,
      "Content-Type": contentType,
      "Content-Length": contents.length,
    });
    res.end(headOnly ? undefined : contents);
  }

  // ---------------------------------------------------------------------
  // Plugin UI serving (/ui/<pluginId>/*)
  // ---------------------------------------------------------------------

  /**
   * Attempt to serve a plugin's bundled UI document and assets. Returns `true`
   * (and writes a response) when the request targeted the `/ui` prefix;
   * returns `false` so the caller can continue routing when it did not.
   *
   * Deliberate deviation from the earlier plan note ("boot-token"): `/ui/*` is
   * served WITHOUT the boot token, exactly like `/site/*`. The boot token must
   * never appear in the sandboxed iframe's URL, because the plugin's own UI
   * code can read `location.search` — giving a sandboxed plugin the full
   * `/api/*` token would let it invoke *any* skill directly, defeating the
   * shell bridge's allowlist entirely. `/ui` instead relies on the same
   * controls as `/site`: loopback-only default bind, strict per-request
   * containment, and a hardened CSP. It serves only the plugin's own public
   * UI assets (already on the user's disk), and every capability request must
   * still present the boot token elsewhere.
   */
  private async tryServeUi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (!this.lanSiteAllowed) {
      return false;
    }
    if (pathname !== UI_PREFIX && !pathname.startsWith(UI_PREFIX + "/")) {
      return false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      this.sendUiEmpty(res, 405, false);
      return true;
    }

    // `/ui/<pluginId>/<subpath>` — the plugin id is the first segment after
    // the prefix. It is only ever used as a Map key (never joined into a
    // path), and it must still match the manifest id rule so an encoded or
    // traversing segment is refused up front.
    const rest = pathname.slice(UI_PREFIX.length);
    if (!rest.startsWith("/")) {
      this.sendUiEmpty(res, 404, false);
      return true;
    }
    const rawSegments = rest.slice(1).split("/");
    const pluginId = rawSegments[0];
    if (typeof pluginId !== "string" || !PLUGIN_ID_RE.test(pluginId)) {
      this.sendUiEmpty(res, 404, false);
      return true;
    }

    const uiRoot = await this.host.pluginUiRoot(pluginId);
    if (!uiRoot) {
      this.sendUiEmpty(res, 404, false);
      return true;
    }

    let rawSubpath = rawSegments.slice(1).join("/");
    if (rawSubpath.length === 0) {
      // Bare `/ui/<pluginId>/` serves the manifest entry document.
      const manifest = this.host.listPlugins().find((p) => p.id === pluginId);
      const entry = manifest?.ui?.entry;
      if (typeof entry !== "string") {
        this.sendUiEmpty(res, 404, false);
        return true;
      }
      rawSubpath = path.basename(entry);
    }

    if (
      /%2e/i.test(rawSubpath) ||
      /%00/i.test(rawSubpath) ||
      rawSubpath.includes("..") ||
      rawSubpath.includes("\0")
    ) {
      this.sendUiEmpty(res, 404, false);
      return true;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSubpath);
    } catch {
      this.sendUiEmpty(res, 404, false);
      return true;
    }

    // Containment (dot-segments, dotfiles, symlinks, escapes) is decided once,
    // in the shared helper — identical to the P2P fetchAsset and /site paths.
    const resolved = resolveAndContainFile(uiRoot, decoded);
    if (!resolved) {
      this.sendUiEmpty(res, 404, false);
      return true;
    }

    let contents: Buffer;
    try {
      contents = await fsp.readFile(resolved);
    } catch {
      this.sendUiEmpty(res, 404, false);
      return true;
    }

    const contentType = contentTypeForPath(resolved);
    res.writeHead(200, {
      ...UI_SECURITY_HEADERS,
      "Content-Type": contentType,
      "Content-Length": contents.length,
    });
    res.end(req.method === "HEAD" ? undefined : contents);
    return true;
  }

  private sendUiEmpty(
    res: http.ServerResponse,
    status: number,
    withHeaders: boolean,
  ): void {
    res.writeHead(status, withHeaders ? UI_SECURITY_HEADERS : {});
    res.end();
  }

  // ---------------------------------------------------------------------
  // Remote site mirror serving (/remote-site/<peerId>/*)
  // ---------------------------------------------------------------------

  /**
   * Attempt to serve a mirrored remote P2P site. Returns `true` (and writes a
   * response) when the request targeted the `/remote-site` prefix.
   *
   * This is the render side of the Fase-2 end criterion: peer B renders peer
   * A's `p2p-hub:website:v1` capability inside the same sandboxed-iframe model
   * as `/ui`. A never runs a public HTTP server — B fetches assets over the
   * P2P protocol on request and stores them in `<dataDir>/sites/<peerId>`.
   *
   * Hardening mirrors `/ui` (CLAUDE.md principle #10): served WITHOUT the boot
   * token (the iframe is untrusted remote content and must never hold a token
   * in its URL), loopback-gated, GET/HEAD-only, strict per-request containment
   * (shared {@link mirrorDestination} on the write side, {@link resolveAndContainFile}
   * semantics on the serve side), and the hardened UI CSP with `connect-src
   * 'none'`. The peerId is validated as hex before it ever builds a path, so
   * the mirror root is contained by construction. Every failure is a quiet 404.
   */
  private async tryServeRemoteSite(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (!this.lanSiteAllowed) {
      return false;
    }
    if (
      pathname !== REMOTE_SITE_PREFIX &&
      !pathname.startsWith(REMOTE_SITE_PREFIX + "/")
    ) {
      return false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      this.sendUiEmpty(res, 405, false);
      return true;
    }

    const rest = pathname.slice(REMOTE_SITE_PREFIX.length);
    if (!rest.startsWith("/")) {
      this.sendUiEmpty(res, 404, false);
      return true;
    }
    const rawSegments = rest.slice(1).split("/");
    const peerId = rawSegments[0];
    // The peerId is a directory name AND the remote task target. It must be a
    // valid 64-hex identity before it is used for either.
    if (typeof peerId !== "string" || !PEER_ID_RE.test(peerId)) {
      this.sendUiEmpty(res, 404, false);
      return true;
    }

    let rawSubpath = rawSegments.slice(1).join("/");
    if (rawSubpath.length === 0) {
      rawSubpath = "index.html";
    }

    if (
      /%2e/i.test(rawSubpath) ||
      /%00/i.test(rawSubpath) ||
      rawSubpath.includes("..") ||
      rawSubpath.includes("\0")
    ) {
      this.sendUiEmpty(res, 404, false);
      return true;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSubpath);
    } catch {
      this.sendUiEmpty(res, 404, false);
      return true;
    }
    // A directory URL (`/remote-site/<peerId>/sub/`) maps to its index, exactly
    // as the origin peer's `resolveAndContainFile` would resolve it.
    if (decoded.endsWith("/")) {
      decoded += "index.html";
    }

    const mirrorRoot = path.join(this.options.dataDir, "sites", peerId);
    const destination = mirrorDestination(mirrorRoot, decoded);
    if (!destination) {
      this.sendUiEmpty(res, 404, false);
      return true;
    }

    let contents: Buffer;
    try {
      contents = await fsp.readFile(destination);
    } catch {
      // Miss: fetch the asset from the remote peer over P2P, then serve it.
      const stored = await mirrorFetchAndStore({
        fetcher: (pid, p) => this.fetchRemoteSiteAsset(pid, p),
        mirrorRoot,
        peerId,
        path: decoded,
      });
      if (!stored) {
        this.sendUiEmpty(res, 404, false);
        return true;
      }
      try {
        contents = await fsp.readFile(stored);
      } catch {
        this.sendUiEmpty(res, 404, false);
        return true;
      }
    }

    const contentType = contentTypeForPath(destination);
    res.writeHead(200, {
      ...UI_SECURITY_HEADERS,
      "Content-Type": contentType,
      "Content-Length": contents.length,
    });
    res.end(req.method === "HEAD" ? undefined : contents);
    return true;
  }

  /**
   * Outbound `p2p-hub:website:v1` asset request to a remote peer, wired to the
   * platform's own network transport. Authorization is entirely the remote
   * peer's platform decision (its broker gate on the transport-verified caller
   * identity) — this side only formats the versioned envelope and validates the
   * response. Every failure is mapped to a typed error code, never leaked.
   */
  private async fetchRemoteSiteAsset(
    peerId: string,
    assetPath: string,
  ): Promise<
    | { ok: true; contentType: string; data: string; name: string }
    | { ok: false; code: WebsiteErrorCode }
  > {
    const result = await this.executeRemote(
      peerId,
      "peersite.fetchAsset",
      randomUUID(),
      buildWebsiteRequest(assetPath),
    );
    if (result.status !== "ok" || !result.result) {
      return { ok: false, code: "not-found" };
    }
    const parsed = parseWebsiteResponse(result.result);
    if (!parsed) {
      return { ok: false, code: "malformed" };
    }
    if (parsed.status === "error") {
      return { ok: false, code: parsed.code };
    }
    return {
      ok: true,
      contentType: parsed.contentType,
      data: parsed.data,
      name: parsed.name,
    };
  }

  // ---------------------------------------------------------------------
  // Scoped PeerSite API (/peersite/*)
  // ---------------------------------------------------------------------

  /**
   * Attempt to handle a scoped PeerSite API request. Returns `true` when the
   * request targeted `/peersite` and was answered; `false` otherwise. The API
   * is only active when the site is enabled (the peersite plugin has a
   * configured root). The scoped site credential is the *only* thing that can
   * authenticate `/peersite/*` — the boot token never applies here, and the
   * site credential never applies to `/api/*` or `/ws`.
   */
  private async tryServePeersite(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (!(await this.effectiveSiteRoot())) {
      return false;
    }
    if (
      pathname !== PEERSITE_PREFIX &&
      !pathname.startsWith(PEERSITE_PREFIX + "/")
    ) {
      return false;
    }

    if (req.method === "GET" && pathname === "/peersite/status") {
      this.sendJson(res, 200, {
        online: true,
        peerName: this.peerId,
        activePluginsCount: this.host.listPlugins().length,
      });
      return true;
    }

    if (req.method === "POST" && pathname === "/peersite/message") {
      if (!this.isSiteAuthorized(req)) {
        this.sendJson(res, 401, { error: "unauthorized" });
        return true;
      }
      const remote = req.socket.remoteAddress ?? "unknown";
      if (!this.allowMessage(remote)) {
        this.sendJson(res, 429, { error: "rate limit exceeded" });
        return true;
      }
      const body = (await readJson(req)) as { message?: unknown };
      if (typeof body.message !== "string") {
        this.sendJson(res, 400, {
          ok: false,
          error: "message expects { message: string }",
        });
        return true;
      }
      validateTextLength(body.message, PEERSITE_MESSAGE_MAX_LENGTH);
      const clean = sanitizeText(body.message);
      this.broadcast("peersite:message", { message: clean, ts: Date.now() });
      this.sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === "POST" && pathname === "/peersite/execute-skill") {
      if (!this.isSiteAuthorized(req)) {
        this.sendJson(res, 401, { error: "unauthorized" });
        return true;
      }
      const body = (await readJson(req)) as {
        serviceId?: unknown;
        method?: unknown;
        arguments?: unknown;
      };
      const { serviceId, method } = body;
      if (
        typeof serviceId !== "string" ||
        typeof method !== "string" ||
        !IDENTIFIER_RE.test(serviceId) ||
        !IDENTIFIER_RE.test(method)
      ) {
        this.sendJson(res, 400, {
          ok: false,
          error: "execute-skill expects safe serviceId and method identifiers",
        });
        return true;
      }
      try {
        await this.trustGate.authorize(
          "critical",
          `Execute skill ${serviceId}.${method} from PeerSite`,
          { authenticated: true },
        );
      } catch (err) {
        if (err instanceof TrustConfirmationDeniedError) {
          this.sendJson(res, 403, {
            ok: false,
            error: "confirmation required",
            requiredTier: err.requiredTier,
          });
          return true;
        }
        throw err;
      }
      const id = randomUUID();
      const result = await this.broker.handleHttp({
        id,
        skill: `${serviceId}.${method}`,
        payload: body.arguments,
      });
      this.sendJson(res, 200, result);
      return true;
    }

    return false;
  }

  private async buildCapabilities(): Promise<unknown> {
    const plugins = this.host.listPlugins().map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      kind: p.kind,
      version: p.version,
      // Fase 2B: manifest-declared UI surface. `skills` is the bridge allowlist
      // the shell must register — never derived from the full skill list.
      ui: p.ui
        ? {
            entry: p.ui.entry,
            defaultWidth: p.ui.defaultWidth,
            defaultHeight: p.ui.defaultHeight,
            skills: p.ui.skills ?? [],
          }
        : null,
    }));

    const skills = this.broker.listSkills().map((s) => ({
      skill: s.skill,
      localOnly: s.localOnly,
      httpExposed: s.httpExposed,
      httpBridgeOnly: s.httpBridgeOnly,
      capabilityType: s.capabilityType,
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

    // Same duck-typed contacts read-seam the host's RemoteGate uses (Fase 2A):
    // distinguish verified contacts from anonymous/self-signed peers so the
    // shell can render per-peer trust instead of assuming everyone is equal.
    const contacts = asContactLookup(this.host.getActivated("contacts"));
    const peers = this.provider
      ? await Promise.all(
          this.provider.listPeers().map(async (peer) => {
            let trust = "self-signed";
            if (peer.peerId && contacts) {
              const info = await contacts.getContact(peer.peerId);
              if (info?.trustState === "verified") {
                trust = "verified";
              }
            }
            return {
              id: peer.id,
              peerId: peer.peerId ?? null,
              name: peer.name ?? peer.id,
              address: peer.address,
              skills: peer.skills,
              transport: this.provider!.id,
              trust,
            };
          }),
        )
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

  /**
   * Authorize an HTTP `/api/*` request via the `Authorization` header only.
   * A `?token=` query string on an API request would put the boot token in
   * server access logs, browser history and any reverse-proxy logs — an
   * avoidable exposure, because a fetch/XHR caller can always set a header.
   * The query string remains the *only* accepted path for `/ws` (see
   * {@link isAuthorizedWs}), where the browser WebSocket API forces it.
   */
  private isAuthorized(req: http.IncomingMessage): boolean {
    return safeTokenEqual(
      tokenFromAuthorization(req.headers.authorization),
      this.bootToken,
    );
  }

  /**
   * Authorize a `/ws` upgrade via the `Authorization` header or `?token=`
   * query string. The query string is accepted here only because the browser
   * WebSocket API cannot attach custom headers to the handshake; this is the
   * accepted risk documented in CLAUDE.md (mitigated operationally: loopback,
   * short-lived per-boot token, never logged).
   */
  private isAuthorizedWs(req: http.IncomingMessage): boolean {
    return (
      safeTokenEqual(
        tokenFromAuthorization(req.headers.authorization),
        this.bootToken,
      ) ||
      safeTokenEqual(tokenFromQuery(req), this.bootToken)
    );
  }

  /**
   * Resolve the LAN exposure decision at startup. The site root itself is
   * owned by the `peersite` plugin (see {@link effectiveSiteRoot}); this only
   * decides whether a configured site may be served beyond loopback.
   *
   * Loopback serving is always allowed. Serving beyond loopback is an explicit
   * opt-in: it requires both `peersiteEnabled` and `peersiteLanExposed` from
   * the persisted settings, and when enabled it logs a loud exposure + risk
   * warning (CLAUDE.md principle #8 — no silent widening).
   */
  private async initSite(): Promise<void> {
    const host = this.options.host ?? "127.0.0.1";
    if (!isLoopbackHost(host)) {
      const settings = await this.loadSettings();
      if (!settings.peersiteEnabled || !settings.peersiteLanExposed) {
        console.warn(
          "[core-server] PeerSite: the bridge is not bound to loopback and " +
            "peersiteEnabled/peersiteLanExposed are not both enabled; static + " +
            "/peersite serving is refused (loopback-only).",
        );
        this.lanSiteAllowed = false;
        return;
      }
      const risk = evaluateSettingsRisk(settings).aggregate;
      console.warn(
        `[core-server] PeerSite: EXPOSING the static site and /peersite API on ` +
          `non-loopback "${host}". Anyone who can reach this port can read the ` +
          `published site and call the scoped peersite API. Active risk level: ` +
          `${risk}. Keep the site token secret and treat the network as untrusted.`,
      );
    }
  }

  /**
   * The currently-active site root, owned by the `peersite` plugin and read
   * through `host.getActivated("peersite")`. Returns `null` (site disabled)
   * when the plugin is absent, has no configured root, or LAN exposure was
   * refused. The root is already a canonical realpath (validated by the
   * plugin's `setSiteRoot` via the shared {@link validateSiteRoot}).
   */
  private async effectiveSiteRoot(): Promise<string | null> {
    if (!this.lanSiteAllowed) {
      return null;
    }
    const plugin = this.peersite();
    if (!plugin) {
      return null;
    }
    return plugin.getSiteRoot();
  }

  /** Activated `peersite` plugin, duck-typed (fail-closed) — never a blind cast. */
  private peersite(): PeerSitePlugin | null {
    const instance = this.host.getActivated("peersite");
    if (
      typeof instance === "object" &&
      instance !== null &&
      typeof (instance as { getSiteRoot?: unknown }).getSiteRoot === "function"
    ) {
      return instance as PeerSitePlugin;
    }
    return null;
  }

  /** Activated `media` plugin, duck-typed (fail-closed) — never a blind cast. */
  private media(): MediaPlugin | null {
    const instance = this.host.getActivated("media");
    if (
      typeof instance === "object" &&
      instance !== null &&
      typeof (instance as { resolveMediaAccess?: unknown }).resolveMediaAccess ===
        "function"
    ) {
      return instance as MediaPlugin;
    }
    return null;
  }

  /**
   * The scoped site credential, exposed for the host (desktop shell) to read
   * out-of-band. It is in-memory only — never persisted and never injected into
   * served static HTML — and only authorizes `/peersite/*` routes.
   */
  siteCredential(): string {
    return this.siteToken;
  }

  /** Authorize a request using the scoped site credential (not the boot token). */
  private isSiteAuthorized(req: http.IncomingMessage): boolean {
    return (
      safeTokenEqual(tokenFromAuthorization(req.headers.authorization), this.siteToken) ||
      safeTokenEqual(tokenFromQuery(req), this.siteToken)
    );
  }

  /** Fixed-window rate limit for `/peersite/message`, keyed by source IP. */
  private allowMessage(remoteAddress: string): boolean {
    const now = Date.now();
    const recent = (this.messageTimestamps.get(remoteAddress) ?? []).filter(
      (t) => now - t < MESSAGE_RATE_WINDOW_MS,
    );
    if (recent.length >= MESSAGE_RATE_LIMIT) {
      return false;
    }
    recent.push(now);
    this.messageTimestamps.set(remoteAddress, recent);
    return true;
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

/**
 * Public view of a derived agent identity for the `/api/agents` surface. Only
 * public material is exposed: the peerId, the public key, the operator-signed
 * certificate and its `issuedAt`. The private key never leaves
 * `IdentityManager` — it is structurally absent from this view (CLAUDE.md
 * principle #6).
 */
function agentView(child: ChildIdentity): {
  label: string;
  peerId: string;
  publicKeyHex: string;
  certificate: ChildCertificate;
  createdAt: number;
} {
  return {
    label: child.label,
    peerId: child.peerId,
    publicKeyHex: child.publicKeyHex,
    certificate: child.certificate,
    createdAt: child.certificate.issuedAt,
  };
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
