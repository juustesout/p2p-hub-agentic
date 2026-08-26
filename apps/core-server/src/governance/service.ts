import type { PeerSkillGate } from "@p2p-hub/core";
import type { PluginHost } from "@p2p-hub/core";
import type { NetworkPeer } from "@p2p-hub/sdk";
import type { PeerMatrixEntry, PeerMatrixStore } from "./matrix";

/**
 * Structural view of a discovered peer for topology. The base `NetworkPeer`
 * contract carries no transport-specific provenance fields, so the ones the
 * governance topology needs (`peerIdVerified`, `lastSeen`) are read
 * defensively: a transport that does not set them yields `false`/`undefined`,
 * never an error.
 */
type TopologyPeer = NetworkPeer & {
  peerIdVerified?: boolean;
  lastSeen?: number;
};

/**
 * In-process, duck-typed view of the activated `contacts` plugin that the
 * governance service needs. Core-server does not depend on `@p2p-hub/contacts`,
 * so the shape is declared here and guarded at runtime — the same pattern as
 * `asContactLookup` in the SDK, but for the write path (`verifyPeer`) as well
 * as the read path (`listContacts`).
 *
 * This is deliberately NOT a network/HTTP path: `contacts.verifyPeer` stays off
 * the HTTP bridge (`network:http:contacts.verifyPeer` exists, but the skill is
 * not `httpExposed`), and the governance service reaches it in-process via
 * `host.getActivated("contacts")`.
 */
export interface ContactsApi {
  listContacts(): Promise<Array<{
    peerId: string;
    displayName: string;
    trustState: "pending" | "verified" | "blocked";
    lastVerifiedAt?: string;
  }>>;
  verifyPeer(input: { peerId: string }): Promise<{
    verified: boolean;
    error?: string;
  }>;
}

export function asContactsApi(value: unknown): ContactsApi | null {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { listContacts?: unknown }).listContacts === "function" &&
    typeof (value as { verifyPeer?: unknown }).verifyPeer === "function"
  ) {
    return value as ContactsApi;
  }
  return null;
}

/** Functional-only snapshot of one peer for the governance topology view. */
export interface GovernanceTopologyEntry {
  instanceId: string;
  /** Persistent transport-verified identity, or null when the peer has none. */
  peerId: string | null;
  displayName: string | null;
  trustState: "none" | "discovered" | "pending" | "verified" | "blocked";
  /** True only when `peerId` was cryptographically verified over the transport. */
  peerIdVerified: boolean;
  lastSeen: number | null;
  /** Active event subscriptions *towards this node* for this peer. */
  activeSubscriptions: number;
  /** The peer's permission-matrix entry, or null when none is set. */
  matrix: PeerMatrixEntry | null;
}

export interface GovernanceCatalog {
  /** Skills reachable over the P2P network (manifest-exposed + remote policy). */
  skills: Array<{ skill: string; capabilityType: string }>;
  /** Event topics this node publishes remotely (`manifest.exposedEvents`). */
  topics: string[];
}

export interface GovernanceServiceOptions {
  host: PluginHost;
  matrix: PeerMatrixStore;
  /**
   * Tier-2 step-up for every write (verify a peer, change permissions).
   * Implemented by core-server via `TrustTierGate.authorize(..., {authenticated:
   * true})`; throws {@link TrustConfirmationDeniedError} on denial. A service
   * constructed without a gate (tests) still enforces the write path: without
   * this closure the write methods throw.
   */
  authorizeTier2?: (summary: string) => Promise<void>;
}

/**
 * The governance service: the single owner of "who may invoke what over the
 * network". It implements {@link PeerSkillGate} so it can be injected into the
 * TaskBroker, where the intersection
 * `EffectiveAccess = ManifestExposed ∩ PeerMatrixAllowed ∩ VerifiedStatus` is
 * enforced per network task (a matrix entry can never widen the manifest —
 * the broker's own exposure checks keep running independently).
 */
export class GovernanceService implements PeerSkillGate {
  constructor(private readonly opts: GovernanceServiceOptions) {}

  /** PeerSkillGate: fail-closed, never throws (matrix store owns persistence). */
  async isAllowed(peerId: string, skill: string): Promise<boolean> {
    return this.opts.matrix.isAllowed(peerId, skill);
  }

  /** The live manifest-exposed catalog the matrix validates against. */
  async catalog(): Promise<GovernanceCatalog> {
    const skills = this.opts.host
      .taskBroker()
      .listSkills()
      .filter((s) => !s.localOnly && !s.httpBridgeOnly && s.remote !== undefined)
      .map((s) => ({ skill: s.skill, capabilityType: s.capabilityType }));
    return { skills, topics: this.opts.host.exposedEventTopics() };
  }

  /**
   * Functional-only topology. Never exposes transport internals (RTT,
   * bandwidth, address) — a LAN peer with no identity still shows up, but only
   * with instanceId + functional state. `peerId` (and the matrix entry bound to
   * it) is shown only when the transport verified it.
   */
  async topology(): Promise<GovernanceTopologyEntry[]> {
    const contacts = asContactsApi(this.opts.host.getActivated("contacts"));
    const records = contacts
      ? await contacts.listContacts().catch(() => [])
      : [];
    const recordByPeerId = new Map(records.map((r) => [r.peerId, r]));

    const subscriptions = await this.opts.host.listEventSubscriptions();
    const subscriptionCount = new Map<string, number>();
    for (const sub of subscriptions) {
      subscriptionCount.set(
        sub.peerId,
        (subscriptionCount.get(sub.peerId) ?? 0) + 1,
      );
    }

    const seen = new Set<string>();
    const entries: GovernanceTopologyEntry[] = [];
    for (const provider of this.opts.host.networkRegistry().list()) {
      const peers = (provider.listPeers?.() ?? []) as TopologyPeer[];
      for (const peer of peers) {
        // A peer with a transport-verified identity is keyed by it (stable
        // across sessions); otherwise fall back to the per-session instance id.
        const key = peer.peerId && peer.peerIdVerified ? peer.peerId : peer.id;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        const record = peer.peerId ? recordByPeerId.get(peer.peerId) : undefined;
        const trustState =
          record?.trustState === "blocked"
            ? "blocked"
            : record?.trustState === "verified"
              ? "verified"
              : record?.trustState === "pending"
                ? "pending"
                : peer.peerIdVerified
                  ? "pending"
                  : peer.peerId
                    ? "discovered"
                    : "none";

        entries.push({
          instanceId: peer.id,
          peerId: peer.peerId && peer.peerIdVerified ? peer.peerId : null,
          displayName: peer.name ?? record?.displayName ?? null,
          trustState,
          peerIdVerified: Boolean(peer.peerIdVerified),
          lastSeen: peer.lastSeen ?? null,
          activeSubscriptions: peer.peerId
            ? subscriptionCount.get(peer.peerId) ?? 0
            : 0,
          matrix:
            peer.peerId && peer.peerIdVerified
              ? this.opts.matrix.entry(peer.peerId) ?? null
              : null,
        });
      }
    }
    return entries;
  }

  /**
   * Verify a peer's proof-of-possession in-process via the contacts plugin.
   * Tier-2 confirmed (the write path is never authorized by the boot token
   * alone). The contacts plugin never sees the HTTP bridge — this is the
   * in-process dispatch that keeps the sensitive skill off `/api/execute`.
   */
  async verifyPeer(peerId: string): Promise<{ verified: boolean; error?: string }> {
    await this.requireTier2(`Verify contact ${peerId}`);
    const contacts = asContactsApi(this.opts.host.getActivated("contacts"));
    if (!contacts) {
      throw new Error("contacts plugin is not available");
    }
    return contacts.verifyPeer({ peerId });
  }

  /** Set (or replace) a peer's matrix entry. Tier-2 confirmed. */
  async setPermissions(
    peerId: string,
    spec: { skills: string[]; topics: string[]; customRateLimit?: number },
  ): Promise<PeerMatrixEntry> {
    await this.requireTier2(`Update permission matrix for peer ${peerId}`);
    return this.opts.matrix.set(peerId, spec);
  }

  /** Remove a peer's matrix entry entirely. Tier-2 confirmed. */
  async removePermissions(peerId: string): Promise<boolean> {
    await this.requireTier2(`Remove permission matrix for peer ${peerId}`);
    return this.opts.matrix.remove(peerId);
  }

  /** All persisted matrix entries (no auth — the read surface is the API layer's call). */
  matrixList(): PeerMatrixEntry[] {
    return this.opts.matrix.list();
  }

  private async requireTier2(summary: string): Promise<void> {
    if (!this.opts.authorizeTier2) {
      throw new Error(
        "tier-2 confirmation is required for governance writes and no confirmer is configured",
      );
    }
    await this.opts.authorizeTier2(summary);
  }
}
