/**
 * A peer on the network that a provider has discovered.
 */
export interface NetworkPeer {
  /** Unique identifier of the peer instance. */
  id: string;
  /** "host:port" where the peer accepts encrypted task connections. */
  address: string;
  /** Skills the peer claims to serve. */
  skills: string[];
  /** Human-readable name (optional). */
  name?: string;
  /**
   * Persistent peer identity (hex Ed25519 public key) when the peer
   * advertises one. Optional: a transport may not carry identity, and a peer
   * may simply not have one. Do not confuse this with {@link NetworkPeer.id},
   * which is a per-session instance id.
   */
  peerId?: string;
}

/**
 * A task handed off from one peer to another.
 */
export interface TaskRequest {
  id: string;
  /** Skill that should handle this task. */
  skill: string;
  /** Arbitrary serialisable payload. */
  payload: unknown;
}

export type TaskStatus = "ok" | "error";

/**
 * Result of executing a task on a remote peer.
 */
export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  result?: unknown;
  error?: string;
}

/**
 * Handler invoked by {@link NetworkProvider.onTask} for each incoming task.
 */
export type TaskHandler = (task: TaskRequest) => Promise<TaskResult>;

/**
 * Contract every network transport provider must implement.
 *
 * A provider is responsible for discovering peers on the local network that
 * claim a given skill, and for exchanging tasks with those peers.
 */
export interface NetworkProvider {
  /** Stable, unique identifier of the provider. */
  readonly id: string;
  /** Higher priority wins when several providers are ready. */
  readonly priority: number;
  /**
   * Whether this provider can actually exchange tasks. Defaults to `true`.
   * A provider that only reports status (e.g. a daemon probe whose
   * `discover`/`sendTask`/`onTask` are not implemented yet) must set this to
   * `false` so {@link selectActive} never hands callers a transport that
   * throws on every request.
   */
  readonly canTransportTasks?: boolean;

  /** Bring up discovery and the listening socket. */
  start(): Promise<void>;
  /** Tear everything down. */
  stop(): Promise<void>;
  /** True once the listener is active and the provider can serve tasks. */
  isReady(): boolean;

  /** Return peers on the same network that claim the given skill. */
  discover(skill: string): Promise<NetworkPeer[]>;

  /**
   * Return every currently discovered peer, regardless of skill. Optional:
   * a transport that only answers targeted skill queries may omit this. When
   * present, peers should carry their persistent {@link NetworkPeer.peerId}
   * where known, so callers can address a peer by identity rather than by
   * session id.
   */
  listPeers?(): NetworkPeer[];

  /** Send a task to a peer and wait for its result. */
  sendTask(peer: NetworkPeer, task: TaskRequest): Promise<TaskResult>;

  /** Register the handler that executes incoming tasks. */
  onTask(handler: TaskHandler): void;
}
