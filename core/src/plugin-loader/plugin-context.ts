import type { AIContext } from "@p2p-hub/sdk";
import type {
  NetworkPeer,
  TaskRequest,
  TaskResult,
} from "@p2p-hub/sdk";
import type { ActionHandler, FilterFn } from "../hooks/hook-registry";
import type {
  SkillHandler,
  SkillRegistrationOptions,
} from "../task-broker/task-broker";

/**
 * Namespace-aware view over the shared {@link HookRegistry}. `emit` and
 * `applyFilters` are restricted to the plugin's own namespace, and
 * cross-namespace `registerFilter` requires a permission.
 */
export interface HookContext {
  on(event: string, handler: ActionHandler, priority?: number): void;
  emit(event: string, payload: unknown): Promise<void>;
  registerFilter(event: string, fn: FilterFn, priority?: number): void;
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
}
