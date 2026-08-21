/**
 * Fase 2A — platform-enforced remote access policy.
 *
 * Before 2A, "who may invoke this skill over the network" was a convention:
 * every network-exposed skill (`localOnly: false`) either trusted every peer
 * or performed its own gate checks inside the plugin. That put the trust
 * boundary inside each plugin author's hands, and a sloppy/malicious
 * third-party plugin could simply forget to check.
 *
 * 2A moves the decision into the {@link TaskBroker}: a skill declares a
 * `remote` policy at registration, and `handleRemote` evaluates that policy
 * *before* dispatch — the handler never runs when the gate is closed. The
 * broker is the single enforcement point; the plugin only declares intent.
 *
 * Fail-closed invariants (independently enforced in `TaskBroker.execute`):
 *   - A network-exposed skill WITHOUT a `remote` policy is denied. Opting a
 *     skill into the network (`localOnly: false`) alone no longer authorizes
 *     anything — the policy is the authorization.
 *   - `access-pass` requires a `scope`; a policy without one is rejected at
 *     registration time.
 *   - A remote peer with no transport-verified `peerId` (anonymous) can never
 *     satisfy `verified-contact` or `access-pass` — it is denied even when the
 *     policy names those gates.
 *   - `verified-contact` / `access-pass` without an injected {@link RemoteGate}
 *     are denied: an absent gate cannot prove anything.
 *   - `any` is the only gate that needs no proof. It is therefore gated twice:
 *     at registration (the plugin must hold an explicit `network:public:*`
 *     manifest permission, enforced by the plugin loader) and at runtime (the
 *     broker still requires the policy object).
 */
export type RemoteGateKind = "verified-contact" | "access-pass" | "any";

/** A single gate kind, or a list evaluated as OR. An empty list denies. */
export type RemoteGateSpec = RemoteGateKind | RemoteGateKind[];

export interface RemoteAccessPolicy {
  /**
   * Gate(s) a remote caller must pass to invoke the skill, evaluated as OR
   * when an array is given. `"any"` means explicitly public — it requires the
   * manifest permission `network:public:<pluginId>.<skill>` on top of the
   * regular `network:skill:<pluginId>.<skill>` permission.
   */
  gate: RemoteGateSpec;
  /**
   * Required when `gate` includes `"access-pass"`: the pass scope a caller
   * must hold (e.g. `"site-read-only"`). Passes are scoped so one pass cannot
   * lift the gate on unrelated capabilities.
   */
  scope?: string;
}

/**
 * Capability the {@link TaskBroker} consults to evaluate a {@link RemoteAccessPolicy}.
 * Deliberately injected (never constructed by the broker): the broker must not
 * know *how* contacts or access passes are stored — the host wires concrete
 * implementations. An absent gate makes the non-`any` gates fail closed.
 */
export interface RemoteGate {
  /** True when `peerId` is a verified contact. Never throws. */
  isVerifiedContact(peerId: string): Promise<boolean>;
  /** True when `peerId` holds a valid, unexpired pass for `scope`. Never throws. */
  hasValidAccessPass(peerId: string, scope: string): Promise<boolean>;
}

/** Normalize a {@link RemoteGateSpec} to a canonical array (OR semantics). */
export function normalizeRemoteGates(spec: RemoteGateSpec | undefined): RemoteGateKind[] {
  if (spec === undefined) {
    return [];
  }
  return Array.isArray(spec) ? spec : [spec];
}
