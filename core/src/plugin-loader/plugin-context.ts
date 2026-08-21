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
 */
export interface IdentityCapability {
  /** Sign arbitrary bytes with the local persistent identity key. */
  sign(data: Buffer): Promise<Buffer>;
  /** Verify a signature against a peer's public key. Never throws. */
  verify(publicKeyHex: string, data: Buffer, signature: Buffer): boolean;
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
   * Absolute path of the host data directory. Read-only; exposed so a plugin
   * can validate a user-supplied path against it (e.g. the PeerSite site root
   * must not live inside the agent data directory). Never a secret.
   */
  dataDir: string;
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
