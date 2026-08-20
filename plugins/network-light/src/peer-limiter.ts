/**
 * Per-peer abuse protection (Fase 1C). A P2P peer is an untrusted external
 * actor, so the broker-level transport must bound what one peer can do before
 * any skill handler runs. Limits are keyed by remote IP address — the one
 * thing a peer cannot forge at the TCP layer until it has authenticated — and
 * enforced deny-by-default: exceeding a limit does not queue, it refuses.
 *
 * Three independent gates, each independently configured:
 *
 * - **Connections**: how many concurrent TLS connections one IP may hold.
 *   Bounds the cost of a connection-flood / handshake-storm before any bytes
 *   are parsed.
 * - **In-flight tasks**: how many tasks from one IP may be executing at the
 *   same time. Bounds memory/CPU exhaustion from a slow-handler flood (each
 *   accepted task parks a handler invocation).
 * - **Requests per window**: a fixed-window counter of handshakes + tasks from
 *   one IP. Bounds sustained request rate (the flood that never needs to keep
 *   many connections or handlers open at once).
 *
 * Counts are tracked per IP string; the caller decides what an IP is
 * (`socket.remoteAddress`). The limiter is deliberately clock-injectable so
 * window behaviour is testable without sleeping.
 */
export interface PeerLimitConfig {
  /** Max concurrent TLS connections per remote IP. Default 8. */
  maxConnectionsPerIp: number;
  /** Max concurrently executing tasks per remote IP. Default 4. */
  maxConcurrentTasksPerIp: number;
  /** Max handshakes+tasks per IP within {@link requestWindowMs}. Default 120. */
  maxRequestsPerWindowPerIp: number;
  /** Width of the fixed request-counting window in ms. Default 10s. */
  requestWindowMs: number;
}

export const DEFAULT_PEER_LIMITS: PeerLimitConfig = {
  maxConnectionsPerIp: 8,
  maxConcurrentTasksPerIp: 4,
  maxRequestsPerWindowPerIp: 120,
  requestWindowMs: 10_000,
};

interface WindowState {
  count: number;
  startedAt: number;
}

export interface PeerLimitSnapshot {
  ip: string;
  connections: number;
  tasks: number;
  requests: number;
}

export class PeerLimiter {
  private readonly connections = new Map<string, number>();
  private readonly tasks = new Map<string, number>();
  private readonly windows = new Map<string, WindowState>();
  private readonly now: () => number;
  private readonly config: PeerLimitConfig;

  constructor(
    config: Partial<PeerLimitConfig> = {},
    now: () => number = Date.now,
  ) {
    this.config = { ...DEFAULT_PEER_LIMITS, ...config };
    this.now = now;
  }

  /**
   * Reserve a connection slot for `ip`. Returns `false` (deny, close the
   * connection) when the per-IP connection cap is already reached. Call
   * {@link releaseConnection} when the socket closes.
   */
  tryAcquireConnection(ip: string): boolean {
    const current = this.connections.get(ip) ?? 0;
    if (current >= this.config.maxConnectionsPerIp) {
      return false;
    }
    this.connections.set(ip, current + 1);
    return true;
  }

  releaseConnection(ip: string): void {
    const current = this.connections.get(ip) ?? 0;
    if (current <= 1) {
      this.connections.delete(ip);
      return;
    }
    this.connections.set(ip, current - 1);
  }

  /**
   * Reserve an in-flight task slot for `ip`. Returns `false` when the per-IP
   * concurrency cap is reached. Call {@link releaseTask} once the task has
   * settled (in a `finally`).
   */
  tryAcquireTask(ip: string): boolean {
    const current = this.tasks.get(ip) ?? 0;
    if (current >= this.config.maxConcurrentTasksPerIp) {
      return false;
    }
    this.tasks.set(ip, current + 1);
    return true;
  }

  releaseTask(ip: string): void {
    const current = this.tasks.get(ip) ?? 0;
    if (current <= 1) {
      this.tasks.delete(ip);
      return;
    }
    this.tasks.set(ip, current - 1);
  }

  /**
   * Fixed-window request budget check for `ip`. Counts every handshake and
   * task; returns `false` once the window budget is exhausted. A fresh window
   * opens when {@link requestWindowMs} has elapsed since the window started.
   */
  allowRequest(ip: string): boolean {
    const now = this.now();
    const state = this.windows.get(ip);
    if (!state || now - state.startedAt >= this.config.requestWindowMs) {
      this.windows.set(ip, { count: 1, startedAt: now });
      return true;
    }
    if (state.count >= this.config.maxRequestsPerWindowPerIp) {
      return false;
    }
    state.count += 1;
    return true;
  }

  /** Drop all state (used on `stop()`). */
  clear(): void {
    this.connections.clear();
    this.tasks.clear();
    this.windows.clear();
  }

  /** Per-IP state, for tests and inspector tooling. */
  snapshot(): PeerLimitSnapshot[] {
    const ips = new Set([
      ...this.connections.keys(),
      ...this.tasks.keys(),
      ...this.windows.keys(),
    ]);
    return [...ips].map((ip) => ({
      ip,
      connections: this.connections.get(ip) ?? 0,
      tasks: this.tasks.get(ip) ?? 0,
      requests: this.windows.get(ip)?.count ?? 0,
    }));
  }
}
