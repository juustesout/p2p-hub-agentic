import type {
  ActivityEvent,
  Capabilities,
  ConnectionState,
  ExecuteRequest,
  TaskResult,
  VaultKeyMeta,
  VaultModelInfo,
} from "../types";

const WS_PATH = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

type StateListener = (state: ConnectionState) => void;
type EventListener = (event: ActivityEvent) => void;

const HEARTBEAT_INTERVAL_MS = 5_000;
const DEGRADED_RTT_MS = 1_500;
const MAX_BACKOFF_MS = 10_000;

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
    this.open();
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

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private open(): void {
    if (this.socket) {
      return;
    }
    this.setState("reconnecting");
    this.socket = new WebSocket(WS_PATH);

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
      } catch {
        // Ignore malformed frames.
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
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
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
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }
}

export const coreBridge = new CoreBridge();
