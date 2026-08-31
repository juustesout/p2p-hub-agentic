import type { AIContext } from "@p2p-hub/sdk";
import type {
  ContactLookup,
  NetworkPeer,
  TaskRequest,
  TaskResult,
} from "@p2p-hub/sdk";
import type { ActionHandler, FilterFn } from "../hooks/hook-registry";
import type { Disposable } from "../disposable";
import type {
  SkillHandler,
  SkillRegistrationOptions,
} from "../task-broker/task-broker";
import type { RemoteEvent } from "../events/remote-event-adapter";
import type { SubscriptionGuard } from "../events/subscription-hub";

/**
 * Namespace-aware view over the shared {@link HookRegistry}. `emit` and
 * `applyFilters` are restricted to the plugin's own namespace, and
 * cross-namespace `registerFilter` requires a permission. Both `on` and
 * `registerFilter` return a {@link Disposable} that the loader tracks so a
 * plugin's listeners are all released on deactivation.
 */
export interface HookContext {
  on(event: string, handler: ActionHandler, priority?: number): Disposable;
  emit(event: string, payload: unknown): Promise<void>;
  registerFilter(event: string, fn: FilterFn, priority?: number): Disposable;
  applyFilters(event: string, value: unknown): Promise<unknown>;
}

/**
 * Skill registration for a plugin. The plugin supplies only the local name;
 * the loader prefixes it with `${pluginId}.`, so a plugin cannot register
 * outside its own namespace by construction.
 */
export interface SkillContext {
  register(
    skillName: string,
    handler: SkillHandler,
    options?: SkillRegistrationOptions,
  ): void;
  unregister(skillName: string): void;
}

/**
 * Restricted vault surface exposed to plugins. There is deliberately no
 * `getSecret` here — plugins can set, list and delete secrets, but can never
 * read a raw secret value. Only the core AI provider reads raw keys.
 *
 * The reserved key namespaces (e.g. `ai.`, configurable via
 * `VaultManagerOptions.reservedPrefixes`) are blocked here: `setSecret` and
 * `deleteSecret` reject them, and `listSecretKeys` filters them out, so no
 * plugin can rewrite the AI key or endpoint that core will later send prompts
 * to. The reserved prefixes live on `VaultManager` and are enforced at this
 * plugin-facing boundary only — core still reads/writes them directly.
 */
export interface VaultContext {
  setSecret(key: string, value: string): Promise<void>;
  listSecretKeys(): Promise<string[]>;
  deleteSecret(key: string): Promise<boolean>;
}

/**
 * Capability-scoped identity surface for plugins. Deliberately NOT the
 * {@link IdentityManager} instance: a plugin can ask the local node to sign
 * bytes with its persistent identity key and can verify a peer's signature,
 * but can never read or extract the private key. This mirrors `ctx.ai` (a
 * capability over `CoreAIProvider`) and `ctx.vault` (no `getSecret`).
 *
 * Fase 2B: domain separation is *structural*, not a convention. Both `sign`
 * and `verify` take a mandatory `domain` string that the core prepends to
 * `data` before signing/verifying — a plugin can never produce (or accept) a
 * signature over raw caller-chosen bytes without a domain context. A signature
 * minted in one domain (e.g. `p2p-hub:chat:message:v1:`) is structurally
 * meaningless in every other domain. Callers pick a distinctive domain
 * constant per protocol and never reuse another protocol's constant.
 */
export interface IdentityCapability {
  /** Sign `domain || data` with the local persistent identity key. */
  sign(domain: string, data: Buffer): Promise<Buffer>;
  /** Verify a signature over `domain || data` against a peer's public key. Never throws. */
  verify(
    publicKeyHex: string,
    domain: string,
    data: Buffer,
    signature: Buffer,
  ): boolean;
  /**
   * The local node's persistent `peerId` (hex Ed25519 public key). The
   * narrowest possible "who am I" accessor — deliberately not `getIdentity()`,
   * so a plugin cannot read anything beyond the id it needs to address itself.
   * Same value as `publicKeyHex` today; if `peerId` later gains a
   * `did:key:`-style encoding, a separate `publicKeyHex()` accessor will be
   * added at that point, not now.
   */
  peerId(): Promise<string>;
}

/**
 * Capability-scoped network surface for plugins. Not the raw provider: a
 * plugin can discover peers and send a task to a peer *by persistent peerId*,
 * but cannot start/stop the transport or reach outside the task abstraction.
 * Each method resolves the currently-active provider at call time, so the
 * result reflects live state rather than a boot-time snapshot.
 */
export interface NetworkCapability {
  /** Peers that claim `skill`, including their persistent `peerId` when known. */
  discover(skill: string): Promise<NetworkPeer[]>;
  /**
   * Send `task` to the peer whose persistent `peerId` matches. Resolves to an
   * error {@link TaskResult} (never throws) when no active provider exists or
   * the peer is not currently reachable.
   */
  sendTask(peerId: string, task: TaskRequest): Promise<TaskResult>;
}

/**
 * Handle to a live remote subscription (Stap 5). `unsubscribe()` tears the
 * subscription down: it cancels the heartbeat refresh, removes the local state
 * and sends a best-effort `unsubscribe` over the wire.
 */
export interface RemoteSubscriptionHandle {
  readonly subscriptionId: string;
  readonly peerId: string;
  readonly topic: string;
  unsubscribe(): Promise<void>;
}

/**
 * Capability-scoped local event emitter (Brief 6). Where {@link EventsCapability}
 * publishes to *remote* subscribers and is namespace-bound to the plugin's own
 * `<pluginId>:` prefix, this surface is the single, deliberate exception: it
 * publishes onto the host's **local** domain event bus (the bus the PAL engine
 * consumes), where topics are `namespace:event` (e.g. `invoice:created`) and the
 * namespace is a *domain* name — the PAL trigger type — never the plugin id. A
 * storage plugin therefore emits `<tableName>:<event>` mutation events, exactly
 * what a local PAL rule can subscribe to.
 *
 * Deny-by-default (CLAUDE.md principle #1): the capability exists on the
 * context but is a fail-closed stub until BOTH hold — the plugin's manifest
 * lists the explicit `events:publish` permission, and the host wired a local
 * event publisher (a bare {@link PluginHost} wires none). Anything else throws
 * a typed error at publish time and reaches no consumer. Payload/topic hygiene
 * (depth-bounded, acyclic, JSON-serializable, valid `:`-delimiter topic) is
 * enforced by the wired bus itself; the capability only gates *who* may publish
 * and *that* a bus exists.
 */
export interface LocalEventsCapability {
  /**
   * Publish a local domain event on `topic`. Rejects (typed error, never a
   * throw of transport internals) when the plugin lacks the `events:publish`
   * manifest permission, when no local event bus is wired, or when the bus
   * rejects the topic/payload. The host decides what the payload may contain;
   * a plugin must not assume a payload it did not build is delivered.
   */
  publish(topic: string, payload: unknown): Promise<void>;
}

/**
 * Capability-scoped event surface for plugins (Stap 5). `publishRemote` is the
 * only local-event emitter and is namespace-bound (same rule as `hooks.emit`):
 * a plugin can only publish on its own `<pluginId>:` topics. `subscribeRemote`
 * is outbound — the *remote* peer's hub is what authorizes it — so it carries
 * no namespace restriction. Both fail closed (typed errors) rather than
 * throwing transport internals; when the host has no event-capable network the
 * whole surface is a fail-closed stub.
 */
export interface EventsCapability {
  /**
   * Emit `payload` on `topic` locally and fan it out to every remote
   * subscriber. The topic must be in the plugin's own `<pluginId>:` namespace
   * and must be exposed (`manifest.exposedEvents`); anything else throws
   * `TopicNotExposedError` and reaches no subscriber.
   */
  publishRemote(topic: string, payload: unknown): Promise<void>;
  /**
   * Subscribe to `topic` on the peer with persistent `peerId`. Resolves with a
   * {@link RemoteSubscriptionHandle} once the remote hub acks; rejects with
   * `SubscriptionRejectedError` when the peer is unreachable, has no verified
   * identity, or its hub denies the subscription.
   */
  subscribeRemote(
    peerId: string,
    topic: string,
    handler: (event: RemoteEvent) => void,
  ): Promise<RemoteSubscriptionHandle>;
  /**
   * Tear down a remote subscription by id (also cancels its heartbeat
   * refresh). Resolves `false` when no such subscription existed.
   */
  unsubscribeRemote(subscriptionId: string): Promise<boolean>;
  /**
   * Register a per-peer authorization guard for `namespace` (which must end
   * with `:` — the match is delimiter-anchored). The guard is consulted by the
   * remote hub IN ADDITION to the static `exposedEvents` gate, at subscribe
   * time and again right before each event is dispatched to a specific
   * subscriber (so a peer removed from the guard immediately stops receiving).
   * A registered guard is the plugin's own per-project membership gate (e.g.
   * `tasks:project:`); it never replaces the manifest exposure gate. No-op
   * when the host has no event-capable network — the guard simply never runs.
   */
  registerSubscriptionGuard(
    namespace: string,
    guard: SubscriptionGuard,
  ): void;
}

/**
 * Capability-scoped access-pass surface for plugins (Fase 2A). Backed by the
 * core {@link AccessPassManager}, the same store the broker's `access-pass`
 * remote gate consults. Passes are ephemeral (never persisted), never bearer
 * tokens (the peer must still prove possession over the transport on every
 * call), scoped, and expiring. Scope strings are shared global strings — use a
 * distinctive value (e.g. `"site-read-only"`).
 */
export interface AccessContext {
  /**
   * Mint an ephemeral access pass for `peerId` over `scope`. Overwrites an
   * existing pass for the same `(peerId, scope)` pair. Resolves to `{ ok: true }`
   * or `{ ok: false, error }` — never throws.
   */
  issue(peerId: string, scope: string, ttlMs?: number): Promise<
    { ok: true } | { ok: false; error: string }
  >;
  /** Revoke a pass; resolves to true when one existed for `(peerId, scope)`. */
  revoke(peerId: string, scope: string): Promise<boolean>;
  /** True when `peerId` holds a valid, unexpired pass for `scope`. */
  hasPass(peerId: string, scope: string): Promise<boolean>;
}

/**
 * The object handed to a plugin at activation time. This is the enforcement
 * point for permissions: a plugin can only touch its own storage directly,
 * and can only reach another plugin's storage via {@link readStorageOf}, which
 * checks the manifest permissions.
 */
export interface PluginContext {
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };
  /**
   * Read-only access to another plugin's storage. Returns `null` (not an
   * exception) when the current plugin's manifest lacks the
   * `storage:read:<otherPluginId>` permission.
   */
  readStorageOf(otherPluginId: string): {
    get(key: string): Promise<unknown>;
    list(prefix?: string): Promise<string[]>;
  } | null;
  /**
   * Absolute path of this plugin's own data subfolder
   * (`<dataDir>/plugins/<pluginId>`). Created on load. A plugin may read and
   * write files here freely, but it can never reach the host data directory,
   * other plugins' folders, the vault or the boot-token through this path.
   */
  dataDir: string;
  /**
   * True when `candidatePath` resolves to the *host* data directory itself or
   * a path inside it. The containment basis is the real agent data directory,
   * NOT the plugin's own scoped {@link dataDir} subfolder — so a plugin can
   * validate a user-supplied path (e.g. the PeerSite site root must not live
   * inside the vault) without ever being handed the host data dir's path.
   */
  isPathInsideDataDir(candidatePath: string): boolean;
  hooks: HookContext;
  skills: SkillContext;
  ai: AIContext;
  vault: VaultContext;
  /** Persistent identity capability (sign + verify). Never the raw key. */
  identity: IdentityCapability;
  /**
   * Network capability, or `null` when this host was booted without a network
   * registry (networking unavailable). Callers must handle `null` gracefully —
   * it is not a thrown error.
   */
  network: NetworkCapability | null;
  /**
   * Stap 5 event capability: publish local events to remote subscribers and
   * subscribe to remote topics. Never null — when the host has no event-capable
   * network the surface is a fail-closed stub (publish throws
   * `TopicNotExposedError`, subscribe throws `SubscriptionRejectedError`).
   */
  events: EventsCapability;
  /**
   * Local domain event emitter (Brief 6). See {@link LocalEventsCapability} —
   * a fail-closed stub unless the plugin declares `events:publish` AND the host
   * wired a local event bus.
   */
  localEvents: LocalEventsCapability;
  /**
   * Fase 2A access-pass capability. Never null: it is backed by the core
   * {@link AccessPassManager} even when networking is off (issuing a pass is
   * harmless without a network to spend it on).
   */
  access: AccessContext;
  /**
   * In-process trust lookup, or `null` when no lookup was wired (e.g. a bare
   * {@link loadPlugin} call outside a {@link PluginHost}). When present, it is
   * late-bound: `getContact` resolves the contacts plugin at *call* time, so a
   * plugin that activates before contacts is loaded still sees the up-to-date
   * trust state once contacts is active. Absent/unloaded contacts always
   * resolve to `null` (fail-closed), never a thrown error.
   */
  trust: ContactLookup | null;
  /**
   * Plugin-scoped timers. The returned handles are tracked by the host and
   * cleared automatically when the plugin is deactivated, so a plugin that
   * schedules periodic work never leaks an interval after unload.
   */
  timers: {
    setTimeout(handler: () => void, ms: number): Disposable;
    setInterval(handler: () => void, ms: number): Disposable;
  };
  /**
   * Register an arbitrary cleanup callback that the host runs when this plugin
   * is deactivated. Use it for resources the framework cannot track for you.
   */
  onDispose(disposer: () => void): void;
}
