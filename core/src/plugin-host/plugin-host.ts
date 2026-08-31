import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import type {
  NetworkPeer,
  NetworkProvider,
  PeerIdentity,
  PluginManifest,
} from "@p2p-hub/sdk";
import { asContactLookup } from "@p2p-hub/sdk";
import { StorageManager } from "../storage/storage-manager";
import { HookRegistry } from "../hooks/hook-registry";
import { TaskBroker } from "../task-broker/task-broker";
import type {
  AgentGate,
  TaskApprovalGate,
} from "../task-broker/remote-access";
import type { PeerAccessContext } from "../security/peer-access-gate";
import { AccessPassManager } from "../task-broker/access-pass-manager";
import { VaultManager } from "../storage/vault-manager";
import { IdentityManager } from "../identity/identity-manager";
import { NetworkRegistry } from "../network-registry";
import { DisposerBag } from "../disposable";
import { NetworkLightProvider } from "@p2p-hub/network-light";
import { loadManifest, loadPlugin } from "../plugin-loader/plugin-loader";
import { wireNetworkToBroker } from "../task-broker/wire-network";
import {
  CertificationError,
  CertificationService,
} from "../certification/certification-service";
import { SubscriptionHub } from "../events/subscription-hub";
import { RemoteEventAdapter } from "../events/remote-event-adapter";
import {
  resolveEventNetwork,
  type EventNetwork,
} from "../events/event-network";
import type { EventMessageHandler } from "../events/types";
import type { AIBudgetGate } from "../ai/ai-budget";

/** Strict ceiling for a single plugin's `activate()` during boot. */
export const DEFAULT_ACTIVATION_TIMEOUT_MS = 5000;

/** Lifecycle state of a plugin, tracked through {@link PluginHost.boot}. */
export type PluginState =
  | "ACTIVE"
  | "FAILED_ACTIVATION"
  | "FAILED_ACTIVATION_TIMEOUT";

/** Thrown when a plugin's `activate()` exceeds the boot timeout. */
export class PluginActivationTimeoutError extends Error {
  readonly pluginId: string;
  readonly timeoutMs: number;

  constructor(pluginId: string, timeoutMs: number) {
    super(`plugin "${pluginId}" failed to activate within ${timeoutMs}ms`);
    this.name = "PluginActivationTimeoutError";
    this.pluginId = pluginId;
    this.timeoutMs = timeoutMs;
  }
}

export interface PluginHostOptions {
  pluginsDir: string;
  dataDir: string;
  /** Master passphrase for the encrypted vault. Falls back to env/DEV. */
  masterKey?: string;
  /**
   * Start the network-light transport during {@link PluginHost.boot}. Defaults
   * to `false` (deny-by-default): a host that only runs local plugins must
   * never broadcast presence or expose network skills unless it opts in.
   */
  enableNetworking?: boolean;
  /** Port for the network-light transport. Defaults to 0 (ephemeral). */
  networkPort?: number;
  /**
   * Maximum time to wait for a plugin's `activate()` before marking it
   * `FAILED_ACTIVATION_TIMEOUT` and continuing. Defaults to
   * {@link DEFAULT_ACTIVATION_TIMEOUT_MS}.
   */
  activationTimeoutMs?: number;
  /**
   * Fase 2C distribution gate. When true, any plugin whose manifest lacks an
   * Ed25519 `signature` (and matching content hashes) is refused at boot —
   * unsigned third-party plugins can never load. Defaults to `false` so local
   * development keeps working; every boot still logs which plugins are
   * unsigned and therefore untrusted.
   */
  requireSignedPlugins?: boolean;
  /**
   * Fase 3 Stap 3 certification gate. When true, any plugin whose
   * `certification.json` is missing, invalid, expired, content-mismatched or
   * revoked is refused at boot with a typed {@link CertificationError} — only
   * human-reviewed, certifiably-intact plugins can load. Defaults to `false`
   * so local development keeps working; every boot still reports which plugins
   * are uncertified. Independent of {@link requireSignedPlugins}: a plugin can
   * be signed but uncertified and vice versa.
   */
  requireCertifiedPlugins?: boolean;
  /**
   * Known reviewer/operator public keys (64-hex, peerId format) that may have
   * issued certificates. A certificate whose Ed25519 signature verifies under
   * none of these keys is treated as invalid. Empty ⇒ nothing is ever
   * certified (fail-closed).
   */
  reviewerPublicKeys?: string[];
  /**
   * Path of the revocation register JSON file. Defaults to
   * `<dataDir>/certifications/revocations.json`.
   */
  certificationRevocationListPath?: string;
  /**
   * Test-only seam: constructs the network transport instead of the default
   * `NetworkLightProvider`. Tests inject a provider whose `start()` rejects so
   * they can verify a network failure never blocks plugin boot, without
   * depending on OS-specific port-collision behaviour.
   */
  networkProviderFactory?: NetworkProviderFactory;
  /**
   * A1/Slice 2: per-invocation human approval for agent-initiated tasks that
   * need Tier-2 step-up. Wired into the host's {@link TaskBroker}; the desktop
   * shell injects the native confirmation here. Absent ⇒ agent tasks that need
   * approval are denied (fail-closed).
   */
  taskApprovalGate?: TaskApprovalGate;
  /**
   * Stap 6 — options for the lazily-built event layer (`SubscriptionHub`).
   * `peerRateLimit` resolves a per-peer override of the outbound emit-gate
   * budget at emit time; the governance subsystem (core-server) provides it
   * from the persisted permission matrix. Absent ⇒ every peer keeps the
   * default budget.
   */
  eventsOptions?: {
    peerRateLimit?: (peerId: string) => number | undefined;
  };
  /**
   * Brief 6 — the host-wired local domain event publisher exposed to plugins as
   * `ctx.localEvents`. The core-server wires this to its `CoreEventBus` so
   * plugins (e.g. SmartBase) can emit `namespace:event` mutation events that
   * the PAL engine consumes. A bare host (no bus) leaves this absent and every
   * plugin publish fails closed, even when a plugin declares the
   * `events:publish` manifest permission.
   */
  localEvents?: { publish(topic: string, payload: unknown): Promise<void> };
  /**
   * Anti-financial-DoS quota gate forwarded to every plugin's `ctx.ai`. The
   * gate (an `AIBudgetManager` wired by core-server) guards all in-process AI
   * calls so a plugin skill that spends LLM tokens is still bounded by the
   * node's budget. Absent ⇒ plugin AI calls are unbudgeted (bare-host default).
   */
  aiBudgetGate?: AIBudgetGate;
}

/** Input handed to a {@link NetworkProviderFactory}. */
export interface NetworkProviderFactoryInput {
  port: number;
  skills: string[];
  identity: PeerIdentity;
  onPeerDisconnected: (peer: NetworkPeer) => void;
  /**
   * Fase 1B identity binding: signs bytes with the Ed25519 private key behind
   * `identity`. The key stays with the host; the provider only gets signed
   * bytes back.
   */
  identitySigner: (data: Buffer) => Promise<Buffer>;
}

export type NetworkProviderFactory = (
  input: NetworkProviderFactoryInput,
) => NetworkProvider;

/**
 * Orchestrates every installed plugin: scans `pluginsDir`, loads each
 * subdirectory containing a `manifest.json` through `loadPlugin`, sharing a
 * single {@link StorageManager} and {@link HookRegistry} across the whole
 * host.
 *
 * Load order is simply the (alphabetically sorted) subdirectory order. There
 * is no dependency resolution between plugins in this stage — a later plugin
 * that needs an earlier one must rely on the `core:ready` action, which is
 * emitted after every plugin has been activated.
 */
export class PluginHost {
  private readonly storages: StorageManager;
  private readonly hooks: HookRegistry;
  private readonly broker: TaskBroker;
  private readonly access: AccessPassManager;
  private readonly vault: VaultManager;
  private readonly identity: IdentityManager;
  private readonly networks: NetworkRegistry;
  private provider: NetworkProvider | null = null;
  private readonly activated = new Map<string, unknown>();
  private readonly disposers = new Map<string, DisposerBag>();
  private readonly plugins: PluginManifest[] = [];
  private readonly pluginDirs = new Map<string, string>();
  private readonly states = new Map<string, PluginState>();
  private readonly signatures = new Map<string, "signed" | "unsigned">();
  private readonly certificationStatus = new Map<
    string,
    "certified" | "uncertified"
  >();
  private readonly certification: CertificationService;
  private readonly activationTimeoutMs: number;
  /**
   * Union of every active plugin's `manifest.exposedEvents` — the topics this
   * host publishes remotely. Grows as plugins load; applied to the
   * {@link SubscriptionHub} after each load so plugins activated earlier see
   * later plugins' exposure the moment it is published.
   */
  private readonly exposedEvents = new Set<string>();
  /**
   * Stap 5 event layer (SubscriptionHub + RemoteEventAdapter), memoized. Built
   * lazily on first `ctx.events` use or first inbound event-transport frame, so
   * a host that never touches events creates nothing. Both resolve the active
   * provider via the registry at *call* time (see {@link lazyEventNetwork}),
   * so a provider started after the layer was built is still picked up.
   */
  private eventLayerPromise: Promise<{
    hub: SubscriptionHub;
    adapter: RemoteEventAdapter;
  }> | null = null;

  constructor(private readonly options: PluginHostOptions) {
    const hooks = new HookRegistry();
    this.hooks = hooks;
    this.storages = new StorageManager(options.dataDir);
    this.certification = new CertificationService({
      revocationListPath:
        options.certificationRevocationListPath ??
        CertificationService.defaultRevocationListPath(options.dataDir),
      reviewerPublicKeys: options.reviewerPublicKeys ?? [],
    });
    // Fase 2A: one shared access-pass store backs both `ctx.access` (plugins)
    // and the broker's `access-pass` remote gate. A1/Slice 2: the broker's
    // agent gate resolves declared agent identities from this host's own
    // child-identity registry, and the operator's approval gate is passed
    // through for Tier-2 step-up.
    this.access = new AccessPassManager();
    this.broker = new TaskBroker({
      peerAccessContext: buildPeerAccessContext(this),
      agentGate: buildAgentGate(this),
      taskApprovalGate: options.taskApprovalGate,
    });
    this.vault = new VaultManager({
      dataDir: options.dataDir,
      masterKey: options.masterKey,
    });
    this.identity = new IdentityManager({ vault: this.vault });
    this.networks = new NetworkRegistry();
    this.activationTimeoutMs =
      options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
  }

  /**
   * Load all plugins sequentially. A plugin directory without a valid
   * manifest (or one whose entry/activation fails) is logged and skipped; it
   * never blocks the rest of the boot. After the loop, `core:ready` is
   * emitted so plugins can run post-boot work without guessing load order.
   */
  async boot(): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.options.pluginsDir, {
        withFileTypes: true,
      });
    } catch (err) {
      throw new Error(
        `[plugin-host] cannot read plugins dir "${this.options.pluginsDir}": ` +
          `${(err as Error).message}`,
      );
    }

    const subdirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    // Load the revocation register before any plugin is evaluated: a corrupt
    // register is a loud infrastructure failure (CLAUDE.md principle #9) — it
    // must stop boot, never silently let a revoked plugin through.
    await this.certification.load();

    const unsignedIds: string[] = [];
    const uncertifiedIds: string[] = [];

    for (const name of subdirs) {
      const pluginDir = path.join(this.options.pluginsDir, name);

      let manifest: PluginManifest;
      try {
        manifest = await loadManifest(pluginDir);
      } catch (err) {
        console.error(`[plugin-host] skipping "${name}": ${(err as Error).message}`);
        continue;
      }

      const signed = manifest.signature !== undefined;
      if (!signed) {
        if (this.options.requireSignedPlugins) {
          // Fase 2C hard gate: unsigned third-party plugins are refused.
          console.error(
            `[plugin-host] skipping "${manifest.id}": unsigned manifest ` +
              `(requireSignedPlugins is enabled)`,
          );
          continue;
        }
        unsignedIds.push(manifest.id);
      }

      // Fase 3 Stap 3: the certification gate — a human-reviewed certificate
      // whose content hash matches the plugin on disk and that is neither
      // expired nor revoked. Always evaluated (for status reporting); only
      // enforced when requireCertifiedPlugins is set.
      const certCheck = await this.certification.verifyPluginCertification(
        pluginDir,
        manifest,
      );
      this.certificationStatus.set(
        manifest.id,
        certCheck.certified ? "certified" : "uncertified",
      );
      if (this.options.requireCertifiedPlugins && !certCheck.certified) {
        const certError = new CertificationError(
          manifest.id,
          certCheck.reason,
        );
        this.states.set(manifest.id, "FAILED_ACTIVATION");
        console.error(
          `[plugin-host] skipping "${manifest.id}": ${certError.message}`,
        );
        continue;
      }
      if (!certCheck.certified) {
        uncertifiedIds.push(manifest.id);
      }

      const disposers = new DisposerBag();
      try {
        const instance = await withTimeout(
          loadPlugin(
            pluginDir,
            this.storages,
            this.hooks,
            this.broker,
            this.vault,
            this.identity,
            this.networks,
            disposers,
            () => asContactLookup(this.getActivated("contacts")),
            this.access,
            () => this.ensureEventLayer(),
            this.options.aiBudgetGate ?? null,
            this.options.localEvents ?? null,
          ),
          this.activationTimeoutMs,
          () =>
            new PluginActivationTimeoutError(
              manifest.id,
              this.activationTimeoutMs,
            ),
        );
        this.activated.set(manifest.id, instance);
        this.disposers.set(manifest.id, disposers);
        this.plugins.push(manifest);
        this.pluginDirs.set(manifest.id, path.resolve(pluginDir));
        this.states.set(manifest.id, "ACTIVE");
        this.signatures.set(manifest.id, signed ? "signed" : "unsigned");
        // Stap 5: fold this plugin's exposed events into the union and refresh
        // the hub so an already-created layer serves the latest exposure.
        for (const event of manifest.exposedEvents ?? []) {
          this.exposedEvents.add(event);
        }
        this.syncExposedEvents();
      } catch (err) {
        // Release anything the plugin registered before it failed, so a broken
        // activation never leaves dangling listeners or timers behind.
        disposers.dispose();
        this.states.set(
          manifest.id,
          err instanceof PluginActivationTimeoutError
            ? "FAILED_ACTIVATION_TIMEOUT"
            : "FAILED_ACTIVATION",
        );
        console.error(
          `[plugin-host] failed to activate "${manifest.id}": ${(err as Error).message}`,
        );
      }
    }

    // Fase 2C: an unsigned plugin has no provenance — be loud about it, once,
    // so a silently-untrusted plugin can never slip through unnoticed.
    if (unsignedIds.length > 0) {
      console.warn(
        `[plugin-host] ${unsignedIds.length} plugin(s) are unsigned and ` +
          `treated as untrusted: ${unsignedIds.join(", ")}`,
      );
    }

    // Fase 3 Stap 3: an uncertified plugin has no human review — same
    // discipline, loud once. A certificate missing here is not an error (dev
    // default), it is a trust state the operator must be able to see.
    if (uncertifiedIds.length > 0) {
      console.warn(
        `[plugin-host] ${uncertifiedIds.length} plugin(s) are uncertified ` +
          `(no valid human-reviewed certificate): ${uncertifiedIds.join(", ")}`,
      );
    }

    if (this.options.enableNetworking) {
      await this.startNetworking();
    }

    await this.hooks.emit("core:ready", null);
  }

  /**
   * Build, start, wire and register the network-light transport with this
   * host's identity and the currently network-exposed skills. Any failure is
   * logged and swallowed: networking is an opt-in enhancement, never a reason
   * for boot to crash — plugins that do not need the network keep working and
   * `ctx.network` retains its graceful "no active provider" behaviour.
   */
  private async startNetworking(): Promise<void> {
    try {
      const identity = await this.identity.getOrCreateIdentity();
      const remoteSkills = this.broker
        .listSkills()
        .filter((skill) => !skill.localOnly)
        .map((skill) => skill.skill);

      const factory =
        this.options.networkProviderFactory ?? defaultNetworkProviderFactory;
      const provider = factory({
        port: this.options.networkPort ?? 0,
        skills: remoteSkills,
        identity,
        identitySigner: (data) => this.identity.sign(data),
        onPeerDisconnected: (peer) => {
          this.hooks.emit("peer:disconnected", peer);
        },
      });
      wireNetworkToBroker(provider, this.broker);
      await provider.start();
      this.networks.register(provider);
      this.networks.selectActive();
      this.provider = provider;
      // Stap 5: route inbound event-transport frames (sub_req → hub,
      // event_emit → adapter) for the now-running provider.
      this.wireEventsToProvider(provider);
    } catch (err) {
      console.error(
        `[plugin-host] networking failed to start: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Stap 5: attach the inbound event-transport routing to a running provider.
   * Also called by the core-server for the provider it owns (registered into
   * this host's registry). The handler is lazy: it builds the event layer on
   * the first inbound frame, so wiring before any `ctx.events` use is safe.
   */
  wireEventsToProvider(provider: NetworkProvider): void {
    const candidate = provider as unknown as {
      onEventMessage?: (handler: EventMessageHandler) => void;
    };
    if (typeof candidate.onEventMessage !== "function") {
      return;
    }
    candidate.onEventMessage(async (msg) => {
      const layer = await this.ensureEventLayer();
      if (!layer) {
        return null;
      }
      if (msg.type === "sub_req") {
        return layer.hub.handleSubReq(msg);
      }
      layer.adapter.handleInboundEvent(msg);
      return null;
    });
  }

  /**
   * The Stap 5 event layer, created once on first use. Building it needs the
   * host identity (`selfPeerId`), which is why it is async; callers that need
   * it only after identity exists share this memoized promise.
   */
  private ensureEventLayer(): Promise<{
    hub: SubscriptionHub;
    adapter: RemoteEventAdapter;
  }> {
    if (!this.eventLayerPromise) {
      this.eventLayerPromise = (async () => {
        const identity = await this.identity.getOrCreateIdentity();
        const network = this.lazyEventNetwork();
        const hub = new SubscriptionHub(network, {
          exposedEvents: this.exposedEvents,
          selfPeerId: identity.peerId,
          ...(this.options.eventsOptions?.peerRateLimit
            ? { peerRateLimit: this.options.eventsOptions.peerRateLimit }
            : {}),
        });
        const adapter = new RemoteEventAdapter(network, {
          onSubscriptionLost: (subscriptionId, reason) => {
            void this.hooks.emit("event:subscription-lost", {
              subscriptionId,
              reason,
            });
          },
        });
        return { hub, adapter };
      })();
    }
    return this.eventLayerPromise;
  }

  /**
   * Refresh an already-created hub with the latest exposed-event union (after a
   * later plugin activated). No-op when the layer was never built — the next
   * builder reads the live set at construction.
   */
  private syncExposedEvents(): void {
    if (!this.eventLayerPromise) {
      return;
    }
    void this.eventLayerPromise.then(
      (layer) => layer.hub.setExposedEvents(this.exposedEvents),
      () => {},
    );
  }

  /**
   * An {@link EventNetwork} that resolves the active provider from the registry
   * on every call, so a provider started (or swapped) after the layer was
   * built is picked up live. A missing or event-incapable provider fails
   * closed: sends return `null`/`false`, peer lookups return nothing.
   */
  private lazyEventNetwork(): EventNetwork {
    const resolve = (): EventNetwork | null => {
      const active = this.networks.selectActive();
      return active ? resolveEventNetwork(active) : null;
    };
    return {
      id: "host-events",
      isReady: () => resolve() !== null,
      listPeers: () => resolve()?.listPeers() ?? [],
      getPeer: (peerId) => resolve()?.getPeer(peerId),
      onEventMessage: (handler) => resolve()?.onEventMessage(handler),
      sendSubReq: async (peer, body) =>
        (await resolve())?.sendSubReq(peer, body) ?? null,
      sendEvent: async (peer, body) =>
        (await resolve())?.sendEvent(peer, body) ?? false,
    };
  }

  /** Stop the network transport if it was started, releasing its sockets. */
  async stop(): Promise<void> {
    if (this.provider) {
      this.networks.unregister(this.provider.id);
      await this.provider.stop();
      this.provider = null;
    }
    const layer = this.eventLayerPromise
      ? await this.eventLayerPromise.catch(() => null)
      : null;
    this.eventLayerPromise = null;
    if (layer) {
      layer.hub.close();
      layer.adapter.close();
    }
  }

  /**
   * Tear a plugin down: release every hook/filter subscription, timer and
   * disposer it registered, unregister its skills, and drop it from the
   * host's active set. After this returns, the plugin leaves no dangling
   * event listener in the shared {@link HookRegistry}.
   */
  async deactivate(pluginId: string): Promise<void> {
    const disposers = this.disposers.get(pluginId);
    if (disposers) {
      disposers.dispose();
      this.disposers.delete(pluginId);
    }
    this.activated.delete(pluginId);
    this.states.delete(pluginId);
    this.signatures.delete(pluginId);
    this.certificationStatus.delete(pluginId);
    this.pluginDirs.delete(pluginId);
    const idx = this.plugins.findIndex((p) => p.id === pluginId);
    if (idx !== -1) {
      this.plugins.splice(idx, 1);
    }
  }

  getActivated(pluginId: string): unknown {
    return this.activated.get(pluginId);
  }

  /** Lifecycle state of a plugin (`ACTIVE`, `FAILED_ACTIVATION`, or timeout). */
  pluginState(pluginId: string): PluginState | undefined {
    return this.states.get(pluginId);
  }

  /**
   * Fase 2C provenance: `"signed"` for a plugin whose Ed25519 signature and
   * content hashes verified at load, `"unsigned"` for one that loaded without
   * a signature (treated as untrusted), `undefined` when not active.
   */
  pluginSignature(pluginId: string): "signed" | "unsigned" | undefined {
    return this.signatures.get(pluginId);
  }

  /**
   * Fase 3 Stap 3 review status: `"certified"` when the plugin carries a valid
   * `certification.json` whose reviewer signature, content hash, expiry and
   * revocation state all verified at boot, `"uncertified"` otherwise,
   * `undefined` when not active.
   */
  pluginCertification(
    pluginId: string,
  ): "certified" | "uncertified" | undefined {
    return this.certificationStatus.get(pluginId);
  }

  /** The host's shared {@link CertificationService} (revocation register). */
  certificationService(): CertificationService {
    return this.certification;
  }

  hookRegistry(): HookRegistry {
    return this.hooks;
  }

  storageManager(): StorageManager {
    return this.storages;
  }

  taskBroker(): TaskBroker {
    return this.broker;
  }

  /**
   * Stap 6 — the event layer's active subscriptions *towards this node* (which
   * remote peers currently receive which of our topics), for the governance
   * topology view. Returns `[]` when the layer was never built (no plugin ever
   * used `ctx.events`) — the empty set is accurate, not an error.
   */
  async listEventSubscriptions(): Promise<
    Array<{ peerId: string; subscriptionId: string; topic: string; ttlMs: number }>
  > {
    if (!this.eventLayerPromise) {
      return [];
    }
    const layer = await this.eventLayerPromise.catch(() => null);
    if (!layer) {
      return [];
    }
    return layer.hub
      .listSubscriptions()
      .map((s) => ({
        peerId: s.peerId,
        subscriptionId: s.subscriptionId,
        topic: s.topic,
        ttlMs: s.ttlMs,
      }));
  }

  /**
   * Stap 6 — the union of every active plugin's `manifest.exposedEvents`
   * (topics this node publishes remotely). This is the event-side catalog the
   * governance permission matrix validates topics against, so a matrix entry
   * can never name a topic no plugin exposes. Always accurate even when the
   * event layer was never built, because the set is filled at plugin
   * activation time.
   */
  exposedEventTopics(): string[] {
    return [...this.exposedEvents];
  }

  /**
   * The shared Fase 2A access-pass store backing `ctx.access` and the broker's
   * `access-pass` remote gate.
   */
  accessPassManager(): AccessPassManager {
    return this.access;
  }

  vaultManager(): VaultManager {
    return this.vault;
  }

  /** Shared persistent {@link IdentityManager} (backed by the host vault). */
  identityManager(): IdentityManager {
    return this.identity;
  }

  /** Registry of network providers; register providers here to wire `ctx.network`. */
  networkRegistry(): NetworkRegistry {
    return this.networks;
  }

  /** Metadata for every successfully activated plugin. */
  listPlugins(): PluginManifest[] {
    return [...this.plugins];
  }

  /**
   * Fase 2B: canonical root directory from which the plugin's UI assets are
   * served (`/ui/<pluginId>/` in the core-server). This is the *directory
   * containing* `ui.entry`, resolved to its realpath, or `null` when the
   * plugin has no UI, its entry does not exist on disk, or the entry escaped
   * the plugin directory (already rejected by the loader). `null` is the
   * quiet, deny-by-default answer — callers map it to 404.
   */
  async pluginUiRoot(pluginId: string): Promise<string | null> {
    const dir = this.pluginDirs.get(pluginId);
    if (!dir) {
      return null;
    }
    const manifest = this.plugins.find((p) => p.id === pluginId);
    const entry = manifest?.ui?.entry;
    if (typeof entry !== "string") {
      return null;
    }
    const uiRoot = path.dirname(path.resolve(dir, entry));
    try {
      return await fs.realpath(uiRoot);
    } catch {
      return null;
    }
  }
}

/** Default transport factory: build a {@link NetworkLightProvider}. */
const defaultNetworkProviderFactory: NetworkProviderFactory = (input) =>
  new NetworkLightProvider({
    port: input.port,
    skills: input.skills,
    identity: input.identity,
    identitySigner: input.identitySigner,
    onPeerDisconnected: input.onPeerDisconnected,
  });

/**
 * The peer-access context the host injects into its {@link TaskBroker} and
 * hands to `checkPeerAccess` (core/src/security) — the same context shape the
 * peersite plugin builds for its in-process `fetchAsset` gate, so the broker
 * and the plugin surface evaluate with one implementation. Contacts are looked
 * up late-bound (mirroring the loader's `trust` seam), so a plugin that
 * activates before the contacts plugin is loaded still resolves the up-to-date
 * trust state at call time; absent contacts fail closed. Access passes come
 * from the host's single {@link AccessPassManager} (backing `ctx.access`).
 */
function buildPeerAccessContext(host: PluginHost): PeerAccessContext {
  return {
    contacts: {
      isVerifiedContact: async (peerId) => {
        const lookup = asContactLookup(host.getActivated("contacts"));
        if (!lookup) {
          return false;
        }
        const contact = await lookup.getContact(peerId);
        return contact?.trustState === "verified";
      },
    },
    accessPasses: {
      hasValidPass: (peerId, scope) =>
        host.accessPassManager().hasValidPass(peerId, scope),
      inspectPass: (peerId, scope) =>
        host.accessPassManager().inspectPass(peerId, scope),
    },
  };
}

/**
 * A1/Slice 2: the {@link AgentGate} the host injects into its
 * {@link TaskBroker}. It resolves declared agent identities from the host's own
 * child-identity registry (`IdentityManager.listChildIdentities`), so only the
 * operator's own derived agents are ever recognised — a random remote peerId is
 * never treated as an agent. Cross-node agent recognition (certificate import)
 * is a later slice. The registry is read live, so deleting an agent identity
 * takes effect on the very next remote call.
 */
function buildAgentGate(host: PluginHost): AgentGate {
  return {
    resolveAgentLabel: async (peerId) => {
      const children = await host.identityManager().listChildIdentities();
      return children.find((child) => child.peerId === peerId)?.label ?? null;
    },
  };
}

/**
 * Resolve with `promise`'s result, or reject with `makeError()` if it has not
 * settled within `timeoutMs`. The timer is always cleared on settlement, so a
 * fast plugin leaves no dangling handle behind.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  makeError: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
