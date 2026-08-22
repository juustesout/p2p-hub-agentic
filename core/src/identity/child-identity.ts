import * as crypto from "node:crypto";
import { canonicalizeJson } from "@p2p-hub/sdk";
import type { ChildCertificate, PeerIdentity } from "@p2p-hub/sdk";

/**
 * Agent child-identity derivation — the pure primitives behind "an agent gets
 * its own derived PeerID" (`docs/agent-identity-streaming-design.md`,
 * `plan.md` "Toekomstige Capabilities", decision 1).
 *
 * A child keypair is derived *deterministically* from the operator's keypair
 * seed + a label, so:
 *   - an agent's `peerId` is stable across restarts and fresh
 *     {@link IdentityManager} instances on the same vault (no registry);
 *   - the operator can prove a child belongs to them by recomputing the
 *     derivation from their seed (the seed never leaves `IdentityManager`);
 *   - the linkage is additionally *publicly* verifiable via a parent-signed
 *     certificate, so any peer holding the operator's public key can confirm
 *     "this agent identity was created by operator X".
 *
 * Ed25519 keys cannot be built from a seed via `generateKeyPairSync` or a JWK
 * `d`-only import (`x` is required). Instead we wrap the 32-byte seed in a
 * PKCS8 DER blob and let `node:crypto` derive the public key internally — no
 * hand-rolled curve arithmetic. Verified against the JWK `d`+`x` path.
 */

/** Domain-separation context for child-identity certificates. Never reuse. */
export const CHILD_CERT_CONTEXT = "p2p-hub:agent-identity:cert:v1";

/** HKDF info prefix. Never reuse for another derivation purpose. */
export const CHILD_DERIVATION_INFO = "p2p-hub:agent-identity:v1:";

/** Agent label rule: alphanumeric start, up to 64 chars, `._-` allowed. */
export const CHILD_LABEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** A label becomes part of a vault key and HKDF info — validate before use. */
export function isValidChildLabel(label: string): boolean {
  return typeof label === "string" && CHILD_LABEL_RE.test(label);
}

/**
 * Deterministically derive the 32-byte child seed from the parent seed and a
 * label. Same (parentSeed, label) pair always yields the same child key.
 */
export function deriveChildSeed(parentSeed: Buffer, label: string): Buffer {
  if (!isValidChildLabel(label)) {
    throw new Error(
      `invalid agent label "${label}" (expected ${CHILD_LABEL_RE})`,
    );
  }
  if (parentSeed.length !== 32) {
    throw new Error("parent seed must be exactly 32 bytes");
  }
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      parentSeed,
      Buffer.alloc(0),
      CHILD_DERIVATION_INFO + label,
      32,
    ),
  );
}

/**
 * Build an Ed25519 {@link crypto.KeyObject} from a raw 32-byte seed by wrapping
 * it in a PKCS8 DER structure. `node:crypto` computes the public key from the
 * seed internally; no private key ever leaves this module's return value.
 */
export function privateKeyFromSeed(seed: Buffer): crypto.KeyObject {
  if (seed.length !== 32) {
    throw new Error("Ed25519 seed must be exactly 32 bytes");
  }
  // SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING {
  //   OCTET STRING { seed } } }  —  id-Ed25519 PKCS8, as produced by
  // `openssl genpkey -algorithm ed25519`.
  const oid = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]);
  const algSeq = Buffer.concat([Buffer.from([0x30, oid.length]), oid]);
  const seedOctet = Buffer.concat([Buffer.from([0x04, 0x20]), seed]);
  const inner = Buffer.concat([Buffer.from([0x04, seedOctet.length]), seedOctet]);
  const int0 = Buffer.from([0x02, 0x01, 0x00]);
  const content = Buffer.concat([int0, algSeq, inner]);
  const der = Buffer.concat([Buffer.from([0x30, content.length]), content]);
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** Hex of the raw 32-byte Ed25519 public key for a private {@link KeyObject}. */
export function publicKeyHexFromPrivateKey(privateKey: crypto.KeyObject): string {
  const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" }) as {
    x: string;
  };
  return Buffer.from(jwk.x, "base64url").toString("hex");
}

/** The exact bytes the parent signs: the canonical cert payload (includes the
 *  `context` field, so the domain is part of the signed bytes — a certificate
 *  signature can never be replayed as a manifest or peersite signature). */
export function canonicalizeCertificate(
  payload: Omit<ChildCertificate, "signature">,
): Buffer {
  return Buffer.from(canonicalizeJson(payload), "utf8");
}

/**
 * Parent signs a certificate binding `childPeerId` to itself under `label`.
 * `sign` is the parent's raw Ed25519 signer (in production:
 * {@link IdentityManager} `sign`, which signs with the operator key).
 */
export async function buildChildCertificate(
  parent: PeerIdentity,
  childPeerId: string,
  label: string,
  sign: (data: Buffer) => Promise<Buffer>,
  issuedAt = Date.now(),
): Promise<ChildCertificate> {
  if (!isValidChildLabel(label)) {
    throw new Error(`invalid agent label "${label}" (expected ${CHILD_LABEL_RE})`);
  }
  const payload = {
    context: CHILD_CERT_CONTEXT,
    parent: parent.peerId,
    child: childPeerId,
    label,
    issuedAt,
  };
  const signature = await sign(canonicalizeCertificate(payload));
  return { ...payload, signature: signature.toString("hex") };
}

/**
 * Verify a child certificate against the operator's *public* key. Stateless,
 * no instance required. Returns `false` (never throws) for a malformed cert,
 * a tampered field, or a signature not produced by `parentPublicKeyHex`.
 */
export function verifyChildCertificate(
  parentPublicKeyHex: string,
  cert: unknown,
): boolean {
  if (typeof cert !== "object" || cert === null) {
    return false;
  }
  const c = cert as Record<string, unknown>;
  if (
    typeof c.context !== "string" ||
    c.context !== CHILD_CERT_CONTEXT ||
    typeof c.parent !== "string" ||
    typeof c.child !== "string" ||
    typeof c.label !== "string" ||
    typeof c.issuedAt !== "number" ||
    typeof c.signature !== "string"
  ) {
    return false;
  }
  const signature = Buffer.from(c.signature, "hex");
  if (signature.length !== 64) {
    return false;
  }
  try {
    const raw = Buffer.from(parentPublicKeyHex, "hex");
    const publicKey = crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    });
    return crypto.verify(
      null,
      canonicalizeCertificate({
        context: c.context,
        parent: c.parent,
        child: c.child,
        label: c.label,
        issuedAt: c.issuedAt,
      }),
      publicKey,
      signature,
    );
  } catch {
    return false;
  }
}
