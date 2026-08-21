import * as crypto from "node:crypto";
import type { ContactTrustState } from "@p2p-hub/sdk";

/**
 * PeerSite inbound peer authentication — challenge-response proof of
 * possession, triggered when a peer *claims* a `peerId` on an inbound P2P
 * request.
 *
 * A claimed `peerId` proves nothing by itself. This module closes that trivial
 * spoof the same way `contacts.verifyPeer` does, but for the inbound direction:
 * the local side first checks whether the claimed id is a *verified* contact
 * (via the `ctx.trust.getContact` seam), and only then issues a nonce challenge
 * that the peer must sign with the private key behind that id.
 *
 * The signature is domain-separated with {@link PEERSITE_AUTH_CONTEXT}, so a
 * signature produced here can never be replayed as a valid signature in another
 * context (contacts, chat, a future payment, …). This prefix is deliberately
 * distinct from `p2p-hub:contacts:challenge:v1:` and must never be reused.
 *
 * Everything is dependency-injected (getContact / requestSignature / verify) so
 * the primitive is unit-testable with two bare keypairs ("virtual identities")
 * and no live transport.
 */

/** Domain-separation context for PeerSite auth. Never reuse in another protocol. */
export const PEERSITE_AUTH_CONTEXT = "p2p-hub:peersite:auth:v1:";

/**
 * Domain-separation context for a PeerSite *access request* ("knock") proof.
 * Distinct from {@link PEERSITE_AUTH_CONTEXT} (the challenge-response path) and
 * from every other domain in the repo; never reuse in another protocol.
 */
export const PEERSITE_KNOCK_CONTEXT = "p2p-hub:peersite:knock:v1:";

/** A peerId is a 64-char hex Ed25519 public key — same rule contacts enforces. */
export const PEER_ID_RE = /^[0-9a-f]{64}$/;

/**
 * The exact bytes a peer must sign to prove possession: `CONTEXT || nonce`.
 * Kept as a wire-format builder for tests/raw-key signing; the plugin-facing
 * sign path applies the domain structurally via the identity capability.
 */
export function buildAuthMessage(nonce: Buffer): Buffer {
  return Buffer.concat([Buffer.from(PEERSITE_AUTH_CONTEXT, "utf8"), nonce]);
}

/**
 * The *data* portion of the knock message (the domain prefix is applied by the
 * identity capability): `peerId || ":" || claim || ":" || timestamp`. The
 * peerId is the claimed identity (and the verification key); the timestamp
 * bounds replay to a small window.
 */
export function buildKnockData(
  peerId: string,
  claim: string,
  timestamp: number,
): Buffer {
  return Buffer.from(`${peerId}:${claim}:${timestamp}`, "utf8");
}

/**
 * The exact bytes a peer signs to request site access in a single, standalone
 * round-trip: `PEERSITE_KNOCK_CONTEXT || buildKnockData(...)`. Kept as a
 * wire-format builder for tests/raw-key signing; the plugin-facing verify path
 * applies the domain structurally via the identity capability.
 */
export function buildKnockMessage(
  peerId: string,
  claim: string,
  timestamp: number,
): Buffer {
  return Buffer.concat([
    Buffer.from(PEERSITE_KNOCK_CONTEXT, "utf8"),
    buildKnockData(peerId, claim, timestamp),
  ]);
}

/**
 * The prover/signer side: sign a challenge nonce under the PeerSite auth
 * domain. This is what the peer being challenged runs (wired to a
 * `localOnly: false` skill in the PeerSite plugin). The signer is
 * domain-aware (it applies {@link PEERSITE_AUTH_CONTEXT} itself), so the
 * caller can never sign caller-chosen bytes without a domain context.
 */
export async function signAuthChallenge(
  sign: (domain: string, data: Buffer) => Promise<Buffer>,
  nonce: Buffer,
): Promise<Buffer> {
  return sign(PEERSITE_AUTH_CONTEXT, nonce);
}

/**
 * Fail reasons. These are for the *local* caller's log/decision only and carry
 * no secrets; they must never be echoed verbatim to the untrusted peer.
 */
export type PeerAuthFailureReason =
  | "invalid-peer-id"
  | "not-a-verified-contact"
  | "no-response"
  | "bad-signature";

export type PeerAuthResult =
  | { authenticated: true; peerId: string }
  | { authenticated: false; peerId: string; reason: PeerAuthFailureReason };

/** Injected dependencies, so the primitive has no transport/key-store coupling. */
export interface PeerAuthDeps {
  /**
   * The trust seam (`ctx.trust.getContact`). Returns the stored contact's trust
   * state, or `null` for an unknown peer. Fail-closed: `null` denies.
   */
  getContact(peerId: string): Promise<{ trustState: ContactTrustState } | null>;
  /**
   * Transport the challenge to the peer and return its signature, or `null` if
   * the peer did not respond. In a real wiring this is a `ctx.network.sendTask`
   * to the peer's auth-signing skill.
   */
  requestSignature(peerId: string, nonce: Buffer): Promise<Buffer | null>;
  /** Stateless domain-aware signature check (`ctx.identity.verify`). Never throws. */
  verify(
    publicKeyHex: string,
    domain: string,
    data: Buffer,
    signature: Buffer,
  ): boolean;
}

/**
 * Authenticate an inbound claim: is the peer that sent this request the holder
 * of `peerId`, *and* a verified contact? Deny-by-default at every step — an
 * unknown/unverified contact is rejected before any challenge is issued.
 */
export async function authenticateIncomingPeer(
  peerId: string,
  deps: PeerAuthDeps,
): Promise<PeerAuthResult> {
  if (typeof peerId !== "string" || !PEER_ID_RE.test(peerId)) {
    return { authenticated: false, peerId: String(peerId), reason: "invalid-peer-id" };
  }

  const contact = await deps.getContact(peerId);
  if (!contact || contact.trustState !== "verified") {
    return { authenticated: false, peerId, reason: "not-a-verified-contact" };
  }

  const nonce = crypto.randomBytes(32);
  const signature = await deps.requestSignature(peerId, nonce);
  if (!signature) {
    return { authenticated: false, peerId, reason: "no-response" };
  }

  // In the identity layer publicKeyHex === peerId (enforced by contacts on
  // add), so the claimed peerId IS the public key to verify against. The
  // domain is applied structurally by the capability (PEERSITE_AUTH_CONTEXT).
  const valid = deps.verify(peerId, PEERSITE_AUTH_CONTEXT, nonce, signature);
  if (!valid) {
    return { authenticated: false, peerId, reason: "bad-signature" };
  }

  return { authenticated: true, peerId };
}
