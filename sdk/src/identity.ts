/**
 * Persistent peer identity — the stable "who am I" that exists *alongside* the
 * per-boot TLS session identity that `network-light` derives from its
 * self-signed certificate. The certificate fingerprint answers "is this the
 * same peer as ten seconds ago within this mDNS session"; a {@link PeerIdentity}
 * answers "is this the same person/machine as yesterday".
 *
 * This type is deliberately tiny: it is a data contract, not an implementation.
 * The actual key management lives in `core/src/identity/identity-manager.ts`.
 */
export interface PeerIdentity {
  /** Hex-encoded Ed25519 public key. Safe to share/broadcast. */
  peerId: string;
  /** Same value as `peerId` today; kept distinct in the type in case `peerId`
   *  gets a `did:key:`-style prefix later — don't conflate the two even though
   *  they're currently identical. */
  publicKeyHex: string;
}

/**
 * Parent-signed certificate binding a child (agent) identity to its operator
 * (`parent`) — the auditability artifact of the agent-identity design
 * (`docs/agent-identity-streaming-design.md`). Canonical serialization over
 * the payload fields (context/parent/child/label/issuedAt) is signed with the
 * parent's Ed25519 private key; anyone holding the parent's *public* key can
 * verify the linkage without ever seeing the derivation secret.
 */
export interface ChildCertificate {
  /** Domain-separation context, e.g. `p2p-hub:agent-identity:cert:v1`. */
  context: string;
  /** Parent (operator) peerId — the verification key for `signature`. */
  parent: string;
  /** Child (agent) peerId this certificate binds to the parent. */
  child: string;
  /** Human-readable agent label. */
  label: string;
  /** Unix epoch milliseconds of issuance. */
  issuedAt: number;
  /** Hex of the 64-byte Ed25519 signature over the canonical payload. */
  signature: string;
}

/**
 * A derived agent identity: an independent Ed25519 keypair whose seed is
 * deterministically derived from the operator's keypair seed, plus the
 * operator-signed certificate proving the parent-child linkage.
 */
export interface ChildIdentity {
  /** Hex-encoded Ed25519 public key (64 hex chars). Safe to share/broadcast. */
  peerId: string;
  /** Identical to `peerId` today; kept distinct in the type (see PeerIdentity). */
  publicKeyHex: string;
  /** Agent label this identity was derived for. */
  label: string;
  /** Parent-signed certificate linking this identity to its operator. */
  certificate: ChildCertificate;
}
