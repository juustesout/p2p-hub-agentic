import type { ServerResponse } from "node:http";
import type { PeerMatrixEntry } from "./matrix";

export const GOVERNANCE_STREAM_DEFAULT_HEARTBEAT_MS = 15_000;

/** One connected SSE client (a subscribed operator UI). */
export interface GovernanceStreamClient {
  id: string;
  /** Send one SSE frame. Never throws into the HTTP layer — write failures
   * surface as a close. */
  send(event: string, data: unknown): void;
  close(): void;
}

export interface GovernanceStreamOptions {
  /** Heartbeat interval. Default {@link GOVERNANCE_STREAM_DEFAULT_HEARTBEAT_MS}. */
  heartbeatMs?: number;
  /** Inject a clock for deterministic tests. */
  now?: () => number;
  onSubscribe?: (client: GovernanceStreamClient) => void;
  onUnsubscribe?: (client: GovernanceStreamClient) => void;
}

/**
 * Server-sent-events fan-out for governance. The HTTP layer owns
 * authentication (the stream is mounted under `/api/` so the boot-token check
 * applies before we ever see the request); this module only manages the live
 * response bodies.
 *
 * Delivery model: the matrix snapshot is *replayed* from the persisted store on
 * every heartbeat tick (diffed by signature, so an unchanged matrix stays
 * quiet), and a fresh client gets the current snapshot immediately on
 * subscribe. This gives any-tier SSE consumer the operator's permission writes
 * without any secret-bearing side channel.
 */
export class GovernanceStream {
  private readonly clients = new Map<string, GovernanceStreamClient>();
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private snapshot: PeerMatrixEntry[] = [];
  private snapshotSignature = "";
  private snapshotProvider: (() => PeerMatrixEntry[]) | null = null;
  private nextId = 0;

  constructor(private readonly opts: GovernanceStreamOptions = {}) {
    this.heartbeatMs = opts.heartbeatMs ?? GOVERNANCE_STREAM_DEFAULT_HEARTBEAT_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Accept a new SSE connection. Caller has already sent `200` headers. */
  subscribe(res: ServerResponse): GovernanceStreamClient {
    const id = `stream-${++this.nextId}`;
    const client: GovernanceStreamClient = {
      id,
      send: (event, data) => {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      close: () => this.unsubscribe(client),
    };
    this.clients.set(id, client);
    // Replay the current matrix snapshot immediately so a fresh client starts
    // with the persisted truth, not just the next tick's delta.
    if (this.snapshot.length > 0) {
      client.send("matrix:update", { entries: this.snapshot });
    }
    this.opts.onSubscribe?.(client);
    res.on("close", () => this.unsubscribe(client));
    return client;
  }

  unsubscribe(client: GovernanceStreamClient): void {
    if (this.clients.delete(client.id)) {
      this.opts.onUnsubscribe?.(client);
    }
  }

  broadcast(event: string, data: unknown): void {
    for (const client of this.clients.values()) {
      client.send(event, data);
    }
  }

  /**
   * Start the heartbeat loop. No-op when already running. `snapshotProvider`
   * is consulted on every tick for the current persisted matrix (live, never a
   * stale snapshot); when absent the last passed snapshot is reused.
   */
  start(snapshotProvider?: () => PeerMatrixEntry[]): void {
    this.snapshotProvider = snapshotProvider ?? null;
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.tick(), this.heartbeatMs);
    // Do not keep the process alive just for the heartbeat.
    this.timer.unref?.();
  }

  /**
   * One heartbeat tick: diff the persisted matrix against what was last
   * replayed; on change, broadcast the new snapshot. Always emits a heartbeat
   * keepalive.
   */
  tick(snapshot: PeerMatrixEntry[] = this.snapshot): void {
    const current = this.snapshotProvider ? this.snapshotProvider() : snapshot;
    this.snapshot = current;
    const signature = current
      .map(
        (e) =>
          `${e.peerId}:${e.updatedAt}:${e.skills.join(",")}:${e.topics.join(",")}:${e.customRateLimit ?? ""}`,
      )
      .join("|");
    if (signature !== this.snapshotSignature) {
      this.snapshotSignature = signature;
      this.broadcast("matrix:update", { entries: current });
    }
    this.broadcast("heartbeat", { t: this.now() });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const client of [...this.clients.values()]) {
      client.close();
    }
    this.clients.clear();
  }
}
