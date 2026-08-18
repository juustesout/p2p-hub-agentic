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
