import type { NetworkPeer } from "@p2p-hub/sdk";
import type { Disposable } from "../disposable";

/** Default time a peer may stay silent before it is considered gone. */
export const HEARTBEAT_TTL_MS = 30_000;

/** How often the sweeper runs to prune expired peers. */
export const SWEEP_INTERVAL_MS = 15_000;

/** Callback invoked for each peer pruned due to TTL expiration. */
export type PeerPrunedHandler = (peer: NetworkPeer) => void;

interface PeerRecord {
  peer: NetworkPeer;
  lastSeen: number;
}

/**
 * Time-bounded peer registry. Tracks the `lastSeen` timestamp of every peer
 * (refreshed on mDNS announcements / heartbeats) and provides a
 * {@link pruneStale} sweep that drops peers silent for longer than the
 * heartbeat TTL. A peer that leaves without an explicit goodbye is thus
 * purged deterministically rather than lingering forever.
 *
 * The clock is injectable (`now`) so tests can advance time deterministically.
 */
export class PeerRegistry {
  private readonly peers = new Map<string, PeerRecord>();
  private readonly onPrune: PeerPrunedHandler;

  constructor(onPrune: PeerPrunedHandler = () => undefined) {
    this.onPrune = onPrune;
  }

  /** Record (or refresh) a peer's presence at time `now`. */
  upsert(peer: NetworkPeer, now = Date.now()): void {
    this.peers.set(peer.id, { peer, lastSeen: now });
  }

  /** Refresh the last-seen timestamp of an existing peer. Returns success. */
  touch(id: string, now = Date.now()): boolean {
    const record = this.peers.get(id);
    if (!record) {
      return false;
    }
    record.lastSeen = now;
    return true;
  }

  remove(id: string): boolean {
    return this.peers.delete(id);
  }

  get(id: string): NetworkPeer | undefined {
    return this.peers.get(id)?.peer;
  }

  list(): NetworkPeer[] {
    return [...this.peers.values()].map((record) => record.peer);
  }

  size(): number {
    return this.peers.size;
  }

  /** Last-seen timestamp of a peer, or `undefined` when unknown. */
  lastSeen(id: string): number | undefined {
    return this.peers.get(id)?.lastSeen;
  }

  /**
   * Remove every peer silent for longer than `ttlMs`. Returns the pruned
   * peers and invokes the {@link PeerPrunedHandler} for each (a core host
   * wires this to emit `peer:disconnected`).
   */
  pruneStale(now = Date.now(), ttlMs = HEARTBEAT_TTL_MS): NetworkPeer[] {
    const pruned: NetworkPeer[] = [];
    for (const [id, record] of this.peers) {
      if (now - record.lastSeen > ttlMs) {
        this.peers.delete(id);
        pruned.push(record.peer);
      }
    }
    for (const peer of pruned) {
      this.onPrune(peer);
    }
    return pruned;
  }
}

/**
 * Start a periodic sweep over `registry`. Returns a {@link Disposable} whose
 * `dispose()` clears the timer, so a host that stops networking leaves no
 * dangling interval behind.
 */
export function startPeerSweeper(
  registry: PeerRegistry,
  intervalMs = SWEEP_INTERVAL_MS,
): Disposable {
  const timer = setInterval(() => {
    registry.pruneStale();
  }, intervalMs);
  return {
    dispose: () => clearInterval(timer),
  };
}
