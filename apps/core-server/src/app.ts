import * as http from "node:http";
import * as path from "node:path";
import { DEFAULT_HTTP_PORT } from "./config";
import { PeerMatrixStore } from "./governance/matrix";
import { GovernanceService } from "./governance/service";
import { GovernanceStream } from "./governance/stream";
import { isNetworkExposedSkill } from "./governance/predicates";
import {
  generateBootToken,
  generateSiteToken,
  safeTokenEqual,
  tokenFromAuthorization,
  tokenFromQuery,
  writeBootToken,
} from "./auth";
import { MAX_PAYLOAD_BYTES, ObjectDepthExceededError, PayloadTooLargeError } from "@p2p-hub/sdk";
import {
  NetworkRegistry,
  PluginHost,
  TrustTierGate,
} from "@p2p-hub/core";
import type { TaskBroker } from "@p2p-hub/core";
import type { NetworkLightProvider } from "@p2p-hub/network-light";import { registerCoreSkills } from "./core-skills";
import { registerMediaSkill } from "./media";
import {
  wireMediaAccessConfirmations,
  wirePeerAccessConfirmations,
} from "./access-confirm";
import { createPeerPoller, startNetworking } from "./network";
import { startWanProvider } from "./wan-provider";
import type { WanProviderHandle } from "./wan-provider";
import { WsActivityBus, wireEventBridge } from "./ws-bus";
import { HostGate, hostFromHeader } from "./host-validation";
import { FixedWindowLimiter } from "./fixed-window";
import { decideSiteExposure } from "./site-exposure";
import { loadSettings, saveSettings } from "./settings";
import { registerGovernanceSkills, serveGovernance } from "./routes/governance";
import type { GovernanceContext } from "./routes/governance";
import { serveUi } from "./routes/ui";
import type { UiContext } from "./routes/ui";
import { servePeersite, serveRemoteSite, serveSite } from "./routes/sites";
import type { SitesContext } from "./routes/sites";
import { executeRemote, serveOperator } from "./routes/operator";
import type { OperatorContext } from "./routes/operator";
import { MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW_MS, REMOTE_SITE_FETCH_RATE_LIMIT, REMOTE_SITE_FETCH_RATE_WINDOW_MS, sendJson } from "./routes/helpers";
import type { CoreServerOptions } from "./options";
import {
  acquireInstanceLock,
  type InstanceLock,
} from "./instance-guard";

interface PeerSitePlugin {
  getSiteRoot(): Promise<string | null>;
  resolveAccessRequest?(requestId: string, approved: boolean): Promise<boolean>;
}

/**
 * Structural view of the activated `media` plugin: core-server only resolves
 * the `media:accessRequested` confirmations the plugin raises.
 */
interface MediaPlugin {
  resolveMediaAccess?(requestId: string, granted: boolean): Promise<boolean>;
}

/**
 * Thin HTTP + WebSocket bridge exposing a running `@p2p-hub/core` host to the
 * desktop shell. It is the only place where raw vault values are read, and it
 * deliberately never returns secret values over HTTP — the vault API only
 * returns existence + metadata.
 *
 * Since Slice 2 the HTTP route handlers live in `src/routes/*` and the wiring
 * helpers in the `src/*` support modules; this class is the startup/assembly
 * layer (dispatch order, auth gates, lifecycle).
 */
export class CoreServer {
  private readonly options: CoreServerOptions;
  private readonly host: PluginHost;
  private readonly broker: TaskBroker;
  private readonly registry = new NetworkRegistry();
  private provider: NetworkLightProvider | null = null;
  private wanProvider: WanProviderHandle | null = null;

  private httpServer: http.Server | null = null;
  private wsBus: WsActivityBus | null = null;
  private peerTimer: NodeJS.Timeout | null = null;
  private instanceLock: InstanceLock | null = null;
  private bootToken = "";
  private readonly trustGate: TrustTierGate;
  private governance: GovernanceService | null = null;
  private governanceStream: GovernanceStream | null = null;
  private lanSiteAllowed = true;
  private siteToken = "";
  private peerId = "";
  private readonly messageLimiters = new Map<string, FixedWindowLimiter>();
  private readonly remoteFetchLimiter: { allow(): boolean };
  private readonly hostGate: HostGate;

  /** Vault lock-gate state: transports + plugin storage gated until unlocked. */
  private vaultUnlocked = false;
  private vaultExists = false;
  /** Network pause toggle: transports stopped, vault stays unlocked. */
  private networkPaused = false;
  /** Whether the deferred boot phase (`PluginHost.boot` + wiring) has run. */
  private booted = false;

  /** Periodic peer-discovery poller (owns the known-peer set). */
  private readonly peerPoller: { poll(): Promise<void> };

  /** HTTP route contexts — narrow, closure-based views of this server. */
  private readonly routes: {
    governance: GovernanceContext;
    ui: UiContext;
    sites: SitesContext;
    operator: OperatorContext;
  };

  constructor(options: CoreServerOptions) {
    this.options = options;
    this.host = new PluginHost({
      pluginsDir: options.pluginsDir,
      dataDir: options.dataDir,
      masterKey: options.masterKey,
      taskApprovalGate: options.taskApprovalGate,
      // Stap 6: the event layer's outbound emit gate consults the governance
      // matrix for a per-peer rate override at emit time. `this.governance` is
      // null until initGovernance() runs — the resolver then yields undefined
      // and every peer keeps the default budget (fail-closed, never unlimited).
      eventsOptions: {
        peerRateLimit: (peerId) => this.governance?.peerRateLimit(peerId),
      },
    });
    this.broker = this.host.taskBroker();
    this.trustGate = new TrustTierGate(options.trustConfirmation);
    // The Host allowlist gate and the /remote-site fetch budget are fixed for
    // the server's lifetime and must exist before the route contexts (which
    // close over them) are built.
    this.hostGate = new HostGate({
      bindHost: options.host ?? "127.0.0.1",
      exposed: options.exposed ?? false,
      extraHosts: options.allowedHosts,
    });
    this.remoteFetchLimiter =
      options.remoteFetchLimiter ??
      new FixedWindowLimiter(
        REMOTE_SITE_FETCH_RATE_LIMIT,
        REMOTE_SITE_FETCH_RATE_WINDOW_MS,
      );
    this.peerPoller = createPeerPoller({
      provider: () => this.provider,
      probeSkill: () => this.broker.listSkills().find((s) => !s.localOnly)?.skill,
      broadcast: (event, payload) => this.broadcast(event, payload),
    });
    this.routes = this.buildRoutes();
  }

  /** Wire the HTTP route modules to this server's internals. */
  private buildRoutes(): CoreServer["routes"] {
    return {
      governance: {
        governance: () => this.governance,
        governanceStream: () => this.governanceStream,
        broadcast: (event, payload) => this.broadcast(event, payload),
      },
      ui: {
        lanSiteAllowed: () => this.lanSiteAllowed,
        pluginUiRoot: (pluginId) => this.host.pluginUiRoot(pluginId),
        listPlugins: () => this.host.listPlugins(),
      },
      sites: {
        lanSiteAllowed: () => this.lanSiteAllowed,
        dataDir: this.options.dataDir,
        peerId: () => this.peerId,
        listPlugins: () => this.host.listPlugins(),
        effectiveSiteRoot: () => this.effectiveSiteRoot(),
        siteAuthorized: (req) => this.isSiteAuthorized(req),
        allowMessage: (remote) => this.allowMessage(remote),
        allowRemoteFetch: () => this.remoteFetchLimiter.allow(),
        broadcast: (event, payload) => this.broadcast(event, payload),
        executeRemote: (peerId, skill, id, args) =>
          executeRemote(this.routes.operator, peerId, skill, id, args),
        invokeSkill: (input) => this.broker.handleHttp(input),
        authorizeTier2: async (summary) => {
          await this.trustGate.authorize("critical", summary, {
            authenticated: true,
          });
        },
      },
      operator: {
        host: this.host,
        broker: this.broker,
        provider: () => this.provider,
        trustGate: this.trustGate,
        broadcast: (event, payload) => this.broadcast(event, payload),
        loadSettings: () => loadSettings(this.options.dataDir),
        saveSettings: (settings) => saveSettings(this.options.dataDir, settings),
        isVaultUnlocked: () => this.vaultUnlocked,
        unlockVault: (key) => this.unlockVault(key),
        lockVault: () => this.lockVault(),
        setNetworkPaused: (paused) => this.setNetworkPaused(paused),
        vaultState: () => this.vaultState(),
      },
    };
  }

  async start(): Promise<void> {
    // Slice 3: refuse to boot a second instance on the same data directory —
    // two processes would race each other's atomic storage writes. Acquired
    // before anything touches the data dir; released on clean stop and on any
    // failed boot (fail-hard, see instance-guard.ts).
    this.instanceLock = acquireInstanceLock(this.options.dataDir);
    try {
      await this.startLocked();
    } catch (err) {
      this.instanceLock?.release();
      this.instanceLock = null;
      // The lock gate binds the HTTP/WS bridge *before* the vault check, so a
      // failed boot (corrupt vault, bad config) must not leak a live listener.
      this.wsBus?.close();
      this.wsBus = null;
      if (this.httpServer) {
        await new Promise<void>((resolve) => {
          this.httpServer!.close(() => resolve());
        });
        this.httpServer = null;
      }
      throw err;
    }
  }

  /**
   * Boot the HTTP/WS bridge and — unless a pre-existing vault demands a master
   * key first — the full plugin/networking stack.
   *
   * Vault lock gate (Slice 2): when a vault file already exists AND networking
   * is enabled, the server starts **locked**. It binds the loopback bridge and
   * serves the operator API (health, `POST /api/vault/unlock`), but defers
   * `PluginHost.boot()` (plugin storage, identity) and every P2P transport
   * until the correct master key arrives. A vault that does not exist yet is
   * first run — there is nothing to protect, so the server boots straight to
   * ready exactly as before. Networking-disabled (local-only) mode never locks:
   * it touches neither the vault nor any transport, and a corrupt vault must
   * not fail a local-only boot (Fase 0D invariant).
   */
  private async startLocked(): Promise<void> {
    this.bootToken = this.resolveBootToken();
    this.siteToken = generateSiteToken();
    this.lanSiteAllowed = await decideSiteExposure(
      this.options.host ?? "127.0.0.1",
      () => loadSettings(this.options.dataDir),
    );

    this.httpServer = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    this.wsBus = new WsActivityBus({
      server: this.httpServer,
      path: "/ws",
      maxPayload: MAX_PAYLOAD_BYTES,
      isAuthorized: (req) => this.isAuthorizedWs(req),
      isAllowedHost: (hostHeader) => this.hostGate.isAllowed(hostHeader),
    });

    const port = this.options.port ?? DEFAULT_HTTP_PORT;
    const host = this.options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(port, host, () => resolve());
    });

    const vault = this.host.vaultManager();
    this.vaultExists = await vault.hasVaultFile();
    const shouldLock = this.vaultExists && this.options.networking !== false;
    if (shouldLock) {
      // Fail loudly on a corrupt vault at boot (CLAUDE.md principle #9) — the
      // lock gate defers plugin loading, but corruption is never "locked".
      await vault.assertLoadable();
      console.warn(
        "[core-server] existing vault detected: starting LOCKED. P2P transports " +
          "and plugin storage stay disabled until the master key is provided " +
          "via POST /api/vault/unlock.",
      );
      return;
    }

    this.vaultUnlocked = true;
    await this.finishBoot();
  }

  /**
   * The lock-gate status as of `start()`: `"locked"` when a pre-existing vault
   * is awaiting its master key, `"ready"` otherwise. Reported over the sidecar
   * boot handshake so the desktop shell can show the unlock screen without
   * probing storage itself.
   */
  bootState(): "locked" | "ready" {
    return this.vaultUnlocked ? "ready" : "locked";
  }

  /**
   * Complete the deferred boot phase and bring P2P transports up, if unlocked.
   *
   * Idempotent: `PluginHost.boot()` and the skill/governance wiring run exactly
   * once; later calls only (re)start transports. Called by {@link startLocked}
   * on first run and by `POST /api/vault/unlock` / `POST /api/network/resume`.
   */
  async finishBoot(): Promise<void> {
    if (!this.booted) {
      await this.host.boot();
      registerCoreSkills(this.broker, this.host.vaultManager());
      registerMediaSkill(this.broker, this.trustGate);
      wireEventBridge(
        this.host,
        (event, payload) => this.broadcast(event, payload),
        this.options.bridgedEvents,
      );
      wirePeerAccessConfirmations(this.host, this.trustGate, () => this.peersite());
      wireMediaAccessConfirmations(this.host, this.trustGate, () => this.media());
      await this.initGovernance();
      this.booted = true;
    }

    if (this.vaultUnlocked && !this.networkPaused) {
      await this.startP2P();
    }

    if (this.peerTimer === null) {
      this.peerTimer = setInterval(() => void this.peerPoller.poll(), 2000);
      void this.peerPoller.poll();
    }
  }

  /** Start the LAN provider and (opt-in) WAN transport. */
  private async startP2P(): Promise<void> {
    if (this.options.networking === false) {
      console.warn(
        "[core-server] networking disabled: no LAN discovery, no inbound P2P " +
          "calls, no peer identity is created. Local-only mode.",
      );
      return;
    }
    this.provider = await startNetworking({
      broker: this.broker,
      host: this.host,
      registry: this.registry,
      p2pPort: this.options.p2pPort,
      p2pBindHost: this.options.p2pBindHost,
    });
    if (this.options.wanEnabled) {
      // WAN transport (network-libp2p), strictly opt-in. Shares the p2p-hub
      // identity with the LAN transport (Optie B unification); dials only
      // operator-configured relays/listen addresses, never discovers.
      this.wanProvider = await startWanProvider({
        broker: this.broker,
        host: this.host,
        registry: this.registry,
        relayAddr: this.options.wanRelayAddr,
        listenAddrs: this.options.wanListenAddrs,
      });
    }
  }

  /** Stop both P2P transports and drop them from the registries. */
  private async stopP2P(): Promise<void> {
    if (this.provider) {
      this.registry.unregister(this.provider.id);
      this.host.networkRegistry().unregister(this.provider.id);
      await this.provider.stop();
      this.provider = null;
    }
    if (this.wanProvider) {
      this.registry.unregister(this.wanProvider.id);
      this.host.networkRegistry().unregister(this.wanProvider.id);
      await this.wanProvider.stop();
      this.wanProvider = null;
    }
  }

  /**
   * Unlock the vault with the operator's master key, then complete the boot
   * phase (plugins, identity, transports) and broadcast `vault:unlocked`.
   *
   * Security shape (CLAUDE.md principles #6/#7): the raw key is verified
   * against the vault here and installed on the VaultManager — it never leaves
   * this call and is never echoed in a response. A wrong key returns a bare
   * "invalid master key" (401), never *why* it failed.
   */
  async unlockVault(masterKey: string): Promise<{ ok: boolean; error?: string }> {
    if (this.vaultUnlocked) {
      return { ok: true };
    }
    if (typeof masterKey !== "string" || masterKey.length === 0) {
      return { ok: false, error: "a master key is required" };
    }
    const vault = this.host.vaultManager();
    const vaultExists = await vault.hasVaultFile();
    if (vaultExists) {
      const valid = await vault.verifyKey(masterKey);
      if (!valid) {
        return { ok: false, error: "invalid master key" };
      }
    }
    vault.setKey(masterKey);
    this.vaultUnlocked = true;
    this.networkPaused = false;
    await this.finishBoot();
    this.broadcast("vault:unlocked", { at: new Date().toISOString() });
    return { ok: true };
  }

  /**
   * Lock the vault: stop every P2P transport and block the HTTP vault surface
   * again (the unlock endpoint stays reachable). Plugins stay loaded — the
   * lock is a session gate on network + operator storage access, not a reload.
   * A server that was never unlocked stays locked.
   */
  async lockVault(): Promise<void> {
    if (!this.booted) {
      return;
    }
    await this.stopP2P();
    this.vaultUnlocked = false;
    this.broadcast("vault:locked", { at: new Date().toISOString() });
  }

  /**
   * Pause (stop transports, keep the vault unlocked) or resume the P2P layer.
   * While paused, peers cannot reach any skill and no discovery happens; the
   * vault and plugin surface stay available to the local operator.
   */
  async setNetworkPaused(paused: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!this.vaultUnlocked) {
      return { ok: false, error: "vault is locked" };
    }
    if (paused === this.networkPaused) {
      return { ok: true };
    }
    if (paused) {
      await this.stopP2P();
      this.networkPaused = true;
      this.broadcast("network:paused", { at: new Date().toISOString() });
    } else {
      await this.startP2P();
      this.networkPaused = false;
      this.broadcast("network:resumed", { at: new Date().toISOString() });
    }
    return { ok: true };
  }

  /** Current lock/pause state, surfaced via `GET /api/health`. */
  vaultState(): { locked: boolean; vaultExists: boolean; networkPaused: boolean } {
    return {
      locked: !this.vaultUnlocked,
      vaultExists: this.vaultExists,
      networkPaused: this.networkPaused,
    };
  }

  /** Bound address of the HTTP server, or null before `start()`. */
  address(): { host: string; port: number } | null {
    const addr = this.httpServer?.address();
    if (addr && typeof addr === "object") {
      return { host: addr.address, port: addr.port };
    }
    return null;
  }

  /**
   * The per-boot token guarding `/api/*` and `/ws`, or `""` before `start()`.
   * Exposed so the sidecar host can report it out-of-band (the `[P2P_HUB_READY]`
   * stdout handshake) without reaching into the bridge's internals.
   */
  getBootToken(): string {
    return this.bootToken;
  }

  async stop(): Promise<void> {
    this.instanceLock?.release();
    this.instanceLock = null;
    if (this.peerTimer) {
      clearInterval(this.peerTimer);
      this.peerTimer = null;
    }
    this.governanceStream?.stop();
    this.governanceStream = null;
    await this.stopP2P();
    if (this.wsBus) {
      this.wsBus.close();
      this.wsBus = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  // ---------------------------------------------------------------------
  // Governance wiring
  // ---------------------------------------------------------------------

  /**
   * Stap 6 — build the governance subsystem (permission matrix + service +
   * SSE stream) and inject the matrix gate into the TaskBroker, after
   * `host.boot()` so the manifest-exposed catalog is complete. The tier-2
   * step-up reuses the `TrustTierGate` core-server already owns — a boot token
   * alone never authorizes a governance write.
   */
  private async initGovernance(): Promise<void> {
    const validateSkill = (skill: string) =>
      this.broker.listSkills().some(
        (s) => s.skill === skill && isNetworkExposedSkill(s),
      );
    const validateTopic = (topic: string) =>
      this.host.exposedEventTopics().includes(topic);

    const matrix = new PeerMatrixStore({
      filePath: path.join(this.options.dataDir, "governance-matrix.json"),
      validateSkill,
      validateTopic,
    });
    await matrix.load();

    this.governance = new GovernanceService({
      host: this.host,
      matrix,
      // Governance writes are operator-driven only: `authenticated: true`
      // reflects the boot token already presented, and the tier-2 native
      // confirmation is the second, independent factor.
      authorizeTier2: async (summary) => {
        await this.trustGate.authorize("critical", summary, { authenticated: true });
      },
    });

    // The broker was created before the matrix store existed, so the gate is
    // installed after the fact. From here on every network task is checked
    // against the intersection: manifest exposure (broker), then this matrix.
    this.broker.setPeerSkillGate(this.governance);

    this.governanceStream = new GovernanceStream();
    this.governanceStream.start(() => this.governance!.matrixList());

    registerGovernanceSkills({
      broker: this.broker,
      getGovernance: () => {
        if (!this.governance) {
          throw new Error("governance is not initialized");
        }
        return this.governance;
      },
      broadcast: (event, payload) => this.broadcast(event, payload),
    });
  }

  // ---------------------------------------------------------------------
  // HTTP dispatcher
  // ---------------------------------------------------------------------

  /**
   * Dispatch one HTTP request. The Host-header allowlist gate runs first, on
   * every path (route-agnostic, so `/api/*`, `/site`, `/peersite`, `/ui` and
   * `/remote-site` all share the same DNS-rebinding protection); the global
   * `/api/*` boot-token gate runs second (header-only — see {@link isAuthorized}).
   * Route modules then run in a fixed order (site → peersite → ui →
   * remote-site → governance → operator). The exact gating/exception
   * semantics were moved verbatim, not rewritten.
   */
  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // Deny-by-default host gate (DNS rebinding): the tokenless surfaces can
    // only be read through a Host header the browser cannot fake. This runs
    // before the token gate on purpose — a rebinding page must not even reach
    // the auth paths. Missing/mismatched Host → generic 403, logged server-side
    // (CLAUDE.md principle: no details that help an attacker refine).
    if (!this.hostGate.isAllowed(req.headers.host)) {
      console.warn(
        `[core-server] rejecting request with disallowed Host header from ` +
          `${req.socket.remoteAddress ?? "unknown"} (host ` +
          `"${hostFromHeader(req.headers.host) ?? "(missing)"}")`,
      );
      sendJson(res, 403, { error: "forbidden" });
      return;
    }

    if (path.startsWith("/api/") && !this.isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    try {
      if (await serveSite(this.routes.sites, req, res, path)) {
        return;
      }
      if (await servePeersite(this.routes.sites, req, res, path)) {
        return;
      }
      if (await serveUi(this.routes.ui, req, res, path)) {
        return;
      }
      if (await serveRemoteSite(this.routes.sites, req, res, path)) {
        return;
      }
      if (await serveGovernance(this.routes.governance, req, res, path)) {
        return;
      }
      if (await serveOperator(this.routes.operator, req, res, path)) {
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: "request body too large" });
        return;
      }
      if (err instanceof ObjectDepthExceededError || err instanceof SyntaxError) {
        sendJson(res, 400, { error: "invalid request body" });
        return;
      }
      console.error("[core-server] request failed:", err);
      sendJson(res, 500, { error: "internal error" });
    }
  }

  // ---------------------------------------------------------------------
  // Site / peer access helpers
  // ---------------------------------------------------------------------

  /**
   * The currently-active site root, owned by the `peersite` plugin and read
   * through `host.getActivated("peersite")`. Returns `null` (site disabled)
   * when the plugin is absent, has no configured root, or LAN exposure was
   * refused. The root is already a canonical realpath.
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
   * out-of-band. In-memory only, never persisted; only authorizes `/peersite/*`.
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
    let limiter = this.messageLimiters.get(remoteAddress);
    if (!limiter) {
      limiter = new FixedWindowLimiter(MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW_MS);
      this.messageLimiters.set(remoteAddress, limiter);
    }
    return limiter.allow();
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
   * server access logs, browser history and any reverse-proxy logs. The query
   * string remains the *only* accepted path for `/ws` (see {@link isAuthorizedWs}),
   * where the browser WebSocket API forces it.
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
   * WebSocket API cannot attach custom headers to the handshake (see CLAUDE.md
   * "Accepted risk").
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

  /** Broadcast an event to every connected WebSocket activity client. */
  private broadcast(event: string, payload: unknown): void {
    this.wsBus?.broadcast(event, payload);
  }
}
