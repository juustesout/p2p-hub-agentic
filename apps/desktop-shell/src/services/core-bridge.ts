import type {
  ActivityEvent,
  BundleResponse,
  Capabilities,
  ClientGpuProbe,
  ConnectionState,
  DiagnosticsLevelName,
  DiagnosticsLogsQuery,
  DiagnosticsLogsResponse,
  DiagnosticSnapshot,
  EffectiveSettings,
  ExecuteRequest,
  ChatMessageRecordView,
  HelpAgentAskResult,
  HelpAgentProposal,
  HelpAgentStatus,
  HelpSupportInfo,
  RiskAssessment,
  SnapshotResponse,
  TaskResult,
  VaultGateState,
  VaultKeyMeta,
  VaultModelInfo,
} from "../types";

const HEARTBEAT_INTERVAL_MS = 5_000;
const DEGRADED_RTT_MS = 1_500;
const MAX_BACKOFF_MS = 10_000;

type StateListener = (state: ConnectionState) => void;
type EventListener = (event: ActivityEvent) => void;

let cachedBootToken: string | null | undefined;

interface BackendConfig {
  /** Origin for `/api/*` fetches, e.g. `http://127.0.0.1:44619`. */
  baseUrl: string;
  /** Origin for the `/ws` WebSocket, e.g. `ws://127.0.0.1:44619`. */
  wsUrl: string;
  /**
   * Per-boot token from the sidecar handshake, or `null` when the shell did not
   * supply one (plain-browser dev then falls back to `resolveBootToken`).
   */
  token: string | null;
  /**
   * Vault lock-gate hint from the boot handshake (`state: "locked"`), or
   * `null` when the shell supplied no config (plain-browser dev). This is a
   * startup hint only — `/api/health` is the authoritative source.
   */
  locked: boolean | null;
}

let cachedBackendConfig: BackendConfig | undefined;

/**
 * Test-only hook: drop the cached backend config so the next
 * {@link resolveBackendConfig} re-resolves (Tauri command, then same-origin).
 */
export function __resetBackendConfigCache(): void {
  cachedBackendConfig = undefined;
}

/**
 * Test-only hook: drop the cached boot token so the next {@link resolveBootToken}
 * re-reads its sources (Tauri command, then env fallback).
 */
export function __resetBootTokenCache(): void {
  cachedBootToken = undefined;
}

/**
 * Resolve where the core-server actually is.
 *
 * Under Tauri the Rust shell spawns the core-server as a sidecar on an
 * OS-assigned port and reports `{port, token}` out-of-band (the
 * `[P2P_HUB_READY]` stdout handshake → `get_backend_config` command), so the
 * frontend must NOT assume `location.host` or a hard-coded port. In a plain
 * browser (dev/preview) the Vite proxy forwards the app's own origin to the
 * core-server, so `location.host` is correct there.
 */
async function resolveBackendConfig(): Promise<BackendConfig> {
  if (cachedBackendConfig !== undefined) {
    return cachedBackendConfig;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const cfg = await invoke<{ port?: number; token?: string; locked?: boolean }>(
      "get_backend_config",
    );
    if (cfg && Number.isInteger(cfg.port) && (cfg.port as number) > 0) {
      cachedBackendConfig = {
        baseUrl: `http://127.0.0.1:${cfg.port}`,
        wsUrl: `ws://127.0.0.1:${cfg.port}`,
        token: cfg.token ?? null,
        locked: cfg.locked === true ? true : cfg.locked === false ? false : null,
      };
      return cachedBackendConfig;
    }
  } catch {
    // Not running under Tauri, or the sidecar is not up yet.
  }
  const scheme = location.protocol === "https:" ? "https" : "http";
  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  cachedBackendConfig = {
    baseUrl: `${scheme}://${location.host}`,
    wsUrl: `${wsScheme}://${location.host}`,
    token: null,
    locked: null,
  };
  return cachedBackendConfig;
}

/**
 * The vault lock-gate hint from the boot handshake, or `null` when unavailable
 * (plain-browser dev). `getHealth()` remains authoritative; this only lets the
 * shell seed a fail-closed lock state before the first health poll.
 */
export async function initialLockHint(): Promise<boolean | null> {
  return (await resolveBackendConfig()).locked;
}

/**
 * The core-server origin as an HTTP URL — the base every `/api/*` call and
 * every plugin-UI iframe shares. Shares the backend-config cache, so it reflects
 * the sidecar's OS-assigned port once resolved.
 */
export async function resolveCoreOrigin(): Promise<string> {
  return (await resolveBackendConfig()).baseUrl;
}

/**
 * Resolve the per-boot token shared with the core-server. Under Tauri the token
 * is read from the local `boot-token` file (never over HTTP); in a plain
 * browser (dev/preview) it falls back to `VITE_P2P_HUB_TOKEN`.
 */
async function resolveBootToken(): Promise<string | null> {
  if (cachedBootToken !== undefined) {
    return cachedBootToken;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const token = await invoke<string>("get_boot_token");
    if (token) {
      cachedBootToken = token;
      return token;
    }
  } catch {
    // Not running under Tauri, or the command/file is unavailable.
  }
  const envToken = (
    import.meta as unknown as { env?: { VITE_P2P_HUB_TOKEN?: string } }
  ).env?.VITE_P2P_HUB_TOKEN;
  cachedBootToken = envToken ?? null;
  return cachedBootToken;
}

/**
 * Connection-resilient bridge to @p2p-hub/core-server. Maintains a persistent
 * WebSocket for real-time events and issues HTTP calls for capabilities and
 * task/service execution. Automatically reconnects with bounded exponential
 * backoff and reports a `degraded` state when round-trip latency climbs.
 */
export class CoreBridge {
  private socket: WebSocket | null = null;
  private state: ConnectionState = "offline";
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private lastRtt = 0;
  private manuallyClosed = false;

  private readonly stateListeners = new Set<StateListener>();
  private readonly eventListeners = new Set<EventListener>();

  connect(): void {
    this.manuallyClosed = false;
    void this.open();
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.setState("offline");
  }

  getState(): ConnectionState {
    return this.state;
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // -------------------------------------------------------------------
  // RPC over HTTP
  // -------------------------------------------------------------------

  async getCapabilities(): Promise<Capabilities> {
    return this.request<Capabilities>("/api/capabilities");
  }

  async execute(req: ExecuteRequest): Promise<TaskResult> {
    return this.request<TaskResult>("/api/execute", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async vaultKeys(): Promise<{
    keys: VaultKeyMeta[];
    masterKeyConfigured: boolean;
  }> {
    return this.request("/api/vault/keys");
  }

  async vaultModel(): Promise<VaultModelInfo> {
    return this.request("/api/vault/model");
  }

  async vaultSet(key: string, value: string): Promise<{ ok: boolean }> {
    return this.request("/api/vault/set", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    });
  }

  async vaultDelete(key: string): Promise<{ ok: boolean; deleted: boolean }> {
    return this.request(`/api/vault/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
  }

  async getSettings(): Promise<{
    settings: EffectiveSettings;
    risk: RiskAssessment;
  }> {
    return this.request("/api/settings");
  }

  async applySettings(settings: EffectiveSettings): Promise<{
    ok: boolean;
    risk?: RiskAssessment;
    requiredTier?: number;
    error?: string;
  }> {
    const backend = await resolveBackendConfig();
    const token = backend.token ?? (await resolveBootToken());
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(backend.baseUrl + "/api/settings/apply", {
      method: "POST",
      headers,
      body: JSON.stringify(settings),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      risk?: RiskAssessment;
      requiredTier?: number;
      error?: string;
    } | null;
    return {
      ok: res.ok,
      risk: body?.risk,
      requiredTier: body?.requiredTier,
      error: body?.error,
    };
  }

  // -------------------------------------------------------------------
  // Vault lock-gate (Slice 2)
  // -------------------------------------------------------------------

  /**
   * Poll `/api/health` for the lock-gate state. While `locked` the desktop
   * shows the unlock screen; `vaultExists` distinguishes "first run, nothing
   * to unlock" from "a vault exists but the key is not entered yet".
   */
  async getHealth(): Promise<VaultGateState> {
    const body = await this.request<{
      ok?: boolean;
      locked?: boolean;
      vaultExists?: boolean;
      networkPaused?: boolean;
    }>("/api/health");
    return {
      locked: body.locked === true,
      vaultExists: body.vaultExists === true,
      networkPaused: body.networkPaused === true,
    };
  }

  /**
   * Unlock the vault with the operator's master key. A wrong key returns
   * `{ ok: false, error: "invalid master key" }` — deliberately terse (no
   * hint about whether the vault even exists), surfaced as a 401.
   */
  async unlockVault(
    masterKey: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const backend = await resolveBackendConfig();
    const token = backend.token ?? (await resolveBootToken());
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(backend.baseUrl + "/api/vault/unlock", {
      method: "POST",
      headers,
      body: JSON.stringify({ masterKey }),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      detail?: string;
    } | null;
    if (res.ok) {
      return { ok: true };
    }
    // Prefer the `detail` field (the server surfaces the real exception message
    // there, e.g. "internal error" + reason) so the toast shows what actually
    // happened instead of only the generic status text.
    return {
      ok: false,
      error: body?.detail ?? body?.error ?? `unlock failed: ${res.status}`,
    };
  }

  async lockVault(): Promise<void> {
    await this.request<{ ok: boolean }>("/api/vault/lock", { method: "POST" });
  }

  async setNetworkPaused(paused: boolean): Promise<void> {
    await this.request<{ ok: boolean }>(
      paused ? "/api/network/pause" : "/api/network/resume",
      { method: "POST" },
    );
  }

  // -------------------------------------------------------------------
  // HelpCenter diagnostics (7C) — operator-facing read/toggle surface
  // -------------------------------------------------------------------

  /**
   * The diagnostics source register. When `source` is omitted the server also
   * returns a bounded (50-record) tail per source; the caller normally passes
   * `source` to fetch exactly the records of one log tab.
   */
  async diagnosticsLogs(query: DiagnosticsLogsQuery = {}): Promise<DiagnosticsLogsResponse> {
    const params = new URLSearchParams();
    if (query.source) {
      params.set("source", query.source);
    }
    if (query.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    if (query.level) {
      params.set("level", query.level);
    }
    if (query.unredacted) {
      params.set("unredacted", "1");
    }
    const qs = params.toString();
    return this.request<DiagnosticsLogsResponse>(`/api/diagnostics/logs${qs ? `?${qs}` : ""}`);
  }

  /** Set the global diagnostics level (pino set, e.g. "debug"). */
  async diagnosticsSetLevel(level: DiagnosticsLevelName): Promise<void> {
    await this.request<{ ok: boolean }>("/api/diagnostics/level", {
      method: "PATCH",
      body: JSON.stringify({ level }),
    });
  }

  /** Enable/disable one diagnostics source (secure sources refuse server-side). */
  async diagnosticsSetSourceEnabled(id: string, enabled: boolean): Promise<void> {
    await this.request<{ ok: boolean }>("/api/diagnostics/source", {
      method: "PATCH",
      body: JSON.stringify({ id, enabled }),
    });
  }

  /**
   * Collect a fresh diagnostic snapshot. Pass the shell's webview GPU probe to
   * fill the hardware WebGL/scale-factor hooks (POST); omit it for the
   * server-only snapshot (GET).
   */
  async diagnosticsSnapshot(clientGpu?: ClientGpuProbe | null): Promise<SnapshotResponse> {
    if (clientGpu) {
      return this.request<SnapshotResponse>("/api/diagnostics/snapshot", {
        method: "POST",
        body: JSON.stringify({ clientGpu }),
      });
    }
    return this.request<SnapshotResponse>("/api/diagnostics/snapshot");
  }

  /** Build one redacted diagnostic bundle (snapshot sections + log sources). */
  async createDiagnosticsBundle(req: {
    sections: string[];
    sources: string[];
    userNote?: string;
    clientGpu?: ClientGpuProbe | null;
  }): Promise<BundleResponse> {
    return this.request<BundleResponse>("/api/diagnostics/bundle", {
      method: "POST",
      body: JSON.stringify({
        sections: req.sections,
        sources: req.sources,
        ...(req.userNote !== undefined ? { userNote: req.userNote } : {}),
        ...(req.clientGpu ? { clientGpu: req.clientGpu } : {}),
      }),
    });
  }

  /** Raw snapshot type accessor for the Diagnose tab. */
  async rawSnapshot(): Promise<DiagnosticSnapshot> {
    return (await this.diagnosticsSnapshot()).snapshot;
  }

  // -------------------------------------------------------------------
  // HelpCenter chat + help-agent (7D)
  // -------------------------------------------------------------------

  /** The baked-in support contact (configured when an operator supplied one). */
  async helpSupport(): Promise<HelpSupportInfo> {
    const res = await this.request<{ ok: boolean; support: HelpSupportInfo }>(
      "/api/help/support",
    );
    return res.support;
  }

  /** Whether the help-agent has an AI provider configured. */
  async helpAgentStatus(): Promise<HelpAgentStatus> {
    return this.request<HelpAgentStatus>("/api/help/agent/status");
  }

  /** Ask the read-only help-agent one question (propose-then-confirm). */
  async helpAgentAsk(question: string): Promise<HelpAgentAskResult> {
    const body = await this.request<{ ok: boolean; code?: string; detail?: string } & Partial<{ proposal: HelpAgentProposal }>>(
      "/api/help/agent/ask",
      {
        method: "POST",
        body: JSON.stringify({ question }),
      },
    );
    if (body.ok && body.proposal) {
      return { ok: true, proposal: body.proposal };
    }
    return { ok: false, code: body.code, detail: body.detail };
  }

  /** Send one chat message to a peer via the chat plugin's httpBridgeOnly skill. */
  async chatSendMessage(toPeerId: string, text: string): Promise<ChatMessageRecordView> {
    const res = await this.execute({
      serviceId: "chat",
      method: "sendMessage",
      arguments: { toPeerId, text },
    });
    if (res.status !== "ok") {
      throw new Error(res.error ?? "send failed");
    }
    return res.result as ChatMessageRecordView;
  }

  /** The support thread's stored messages via the chat plugin's getThread skill. */
  async chatThread(peerId: string): Promise<ChatMessageRecordView[]> {
    const res = await this.execute({
      serviceId: "chat",
      method: "getThread",
      arguments: { peerId },
    });
    if (res.status !== "ok") {
      throw new Error(res.error ?? "load failed");
    }
    return (res.result as ChatMessageRecordView[]) ?? [];
  }

  // -------------------------------------------------------------------
  // Client-side diagnostics
  // -------------------------------------------------------------------

  /**
   * Forward a webview-side diagnostic into the core-server's log (and thus into
   * the on-disk `<dataDir>/core-server.log` the desktop shell drains). This is
   * how the UI's own errors — uncaught exceptions, rejected promises, failed
   * fetches — become visible on the machine instead of living only in an
   * invisible webview console. Best-effort: any failure here is swallowed.
   */
  async reportClientError(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const backend = await resolveBackendConfig();
      const token = backend.token ?? (await resolveBootToken());
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      await fetch(backend.baseUrl + "/api/debug/log", {
        method: "POST",
        headers,
        body: JSON.stringify({ level, message, context }),
      });
    } catch {
      // The bridge or server may be down (that is often exactly why we are
      // reporting) — never let diagnostics add new failures.
    }
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private async open(): Promise<void> {
    if (this.socket) {
      return;
    }
    this.setState("reconnecting");
    const backend = await resolveBackendConfig();
    const token = backend.token ?? (await resolveBootToken());
    const wsUrl = token
      ? `${backend.wsUrl}/ws?token=${encodeURIComponent(token)}`
      : `${backend.wsUrl}/ws`;
    this.socket = new WebSocket(wsUrl);

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.setState("connected");
      this.startHeartbeat();
    };

    this.socket.onmessage = (message) => {
      try {
        const data = JSON.parse(String(message.data)) as {
          type?: string;
          event?: string;
          payload?: unknown;
          ts?: number;
        };
        if (data.type === "pong") {
          this.lastRtt = Date.now() - (data.ts ?? Date.now());
          this.applyDegraded();
          return;
        }
        if (data.type === "event" && data.event) {
          this.emit({ event: data.event, payload: data.payload, ts: data.ts ?? Date.now() });
        }
      } catch (err) {
        // Ignore malformed frames, but log them so client diagnostics can
        // surface a misbehaving peer/server in the on-disk log.
        console.error("[shell] malformed ws frame", err);
      }
    };

    this.socket.onclose = () => {
      this.socket = null;
      this.stopHeartbeat();
      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      }
    };

    this.socket.onerror = () => {
      this.socket?.close();
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      250 * 2 ** this.reconnectAttempts,
      MAX_BACKOFF_MS,
    );
    this.reconnectAttempts += 1;
    this.setState("reconnecting");
    this.reconnectTimer = window.setTimeout(() => void this.open(), delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private applyDegraded(): void {
    if (this.state !== "connected") {
      return;
    }
    if (this.lastRtt > DEGRADED_RTT_MS) {
      this.setState("degraded");
    } else {
      this.setState("connected");
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  private emit(event: ActivityEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const backend = await resolveBackendConfig();
    const token = backend.token ?? (await resolveBootToken());
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(backend.baseUrl + path, {
      ...init,
      headers: {
        ...headers,
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        detail?: string;
      } | null;
      const reason =
        body?.detail != null
          ? `${body?.error ?? "internal error"}: ${body.detail}`
          : body?.error ?? `request failed: ${res.status}`;
      throw new Error(reason);
    }
    return (await res.json()) as T;
  }
}

export const coreBridge = new CoreBridge();
