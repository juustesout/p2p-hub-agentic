import * as crypto from "node:crypto";
import type { TaskRequest, TaskResult } from "@p2p-hub/sdk";
import { MAX_PAYLOAD_BYTES } from "@p2p-hub/sdk";

/**
 * p2p-hub network wire protocol — the explicit contract (Fase 1A).
 *
 * Every message exchanged over a network-light TLS connection is a framed JSON
 * envelope. This module is the reference implementation of that contract; the
 * contract itself is spelled out below in prose so a second, *independent*
 * implementation can interoperate without sharing this code (no shared TS
 * constructor dependency — the byte/field contract is the source of truth).
 *
 * ## Frame
 *
 * `[ 4-byte big-endian payload length ][ UTF-8 JSON envelope ]`
 *
 * A frame whose payload length exceeds `MAX_PAYLOAD_BYTES` is rejected and the
 * connection is closed. The envelope is parsed with nesting-depth protection;
 * a frame that is not valid JSON, or whose envelope fails validation, closes
 * the connection (default-deny on malformed input).
 *
 * ## Envelope
 *
 * Canonical field order (this order is part of the contract):
 *
 * ```
 * { "protocol": "p2p-hub:network", "version": 1, "type": <type>, "body": <body> }
 * ```
 *
 * A peer MUST reject (close, never execute) any envelope whose `protocol` is
 * not `p2p-hub:network` or whose `version` is not a version it supports —
 * unknown protocols and versions default to deny.
 *
 * ## Message types and canonical body field order
 *
 * ```
 * hello      client → server
 *   body: { "versions": number[], "capabilities": string[], "nonce": string }
 *   `versions` = the protocol versions the client supports. `capabilities` =
 *   the skills the client offers for remote invocation. `nonce` = a
 *   client-chosen hex nonce (16 bytes) that anchors the identity binding
 *   (Fase 1B). `hello` MUST be the first message on a connection, and it MUST
 *   carry a nonce — there is no anonymous mode.
 *
 * hello_ack  server → client
 *   body: { "version": number, "capabilities": string[], "limits"?:
 *   { "maxPayloadBytes": number }, "nonce": string, "identity":
 *   { "peerId": string, "certFingerprint": string, "signature": string } }
 *   The server accepts the connection only when the client's `versions`
 *   include an *exact* supported version — there is no "highest shared"
 *   negotiation and no downgrade path; no intersection ⇒ close. `capabilities`
 *   = the skills the server offers. `limits.maxPayloadBytes` bounds the
 *   serialized envelope length (frame body) the server will accept — a
 *   compliant client refuses to send a larger task without putting it on the
 *   wire. `nonce` = a server-chosen hex nonce (16 bytes). `identity` proves
 *   the server holds the Ed25519 private key behind the claimed `peerId` AND
 *   that this claim is bound to the TLS transport: `signature` is an Ed25519
 *   signature over `IDENTITY_BINDING_CONTEXT || clientNonce || ":" ||
 *   serverNonce || ":" || certFingerprint`, where `certFingerprint` is the
 *   SHA-256 fingerprint of the certificate actually presented on this
 *   connection. Both the `nonce` and the `identity` are MANDATORY — there is
 *   no anonymous server. A client MUST close the connection when the identity
 *   fails verification (peerId format, fingerprint mismatch, bad signature).
 *
 * auth       client → server
 *   body: { "peerId": string, "certFingerprint": string, "signature": string }
 *   Mandatory proof-of-possession, the mirror image of `hello_ack.identity`:
 *   sent after `hello_ack` and before any `task`, to bind the client's claimed
 *   `peerId` to the certificate it presented on this connection. The server
 *   verifies it exactly like a client verifies `hello_ack.identity`, with the
 *   `clientNonce`/`serverNonce` exchanged in this connection's handshake. A
 *   client that fails verification is closed (default-deny); a `task` without
 *   a preceding successful `auth` is refused (default-deny). There is no
 *   anonymous client.
 *
 * task       client → server
 *   body: { "id": string, "skill": string, "payload": unknown }
 *
 * result     server → client
 *   body: { "taskId": string, "status": "ok" | "error", "result"?: unknown, "error"?: string }
 *   `result` and `error` are optional; when both are present `result` precedes
 *   `error`.
 * ```
 *
 * ## Identity binding (Fase 1B)
 *
 * The `identity`/`auth` fields make the chain "claimed peerId ↔ Ed25519
 * identity ↔ transport certificate" verifiable in one step. Because the
 * signed bytes include BOTH nonces AND the certificate fingerprint actually
 * presented on the wire, a signature recorded on one connection can never be
 * replayed on another (different cert/nonce), and a peer that claims an id it
 * does not hold cannot produce a valid signature at all. mDNS remains
 * bootstrap-only: the `peerId` and `certFingerprint` announced there are
 * *claims* — this handshake is where they get proven.
 *
 * ## Default-deny rules
 *
 * - Envelope with unknown protocol / unsupported version → close.
 * - `hello` without a `nonce`, or `hello_ack` without `nonce` + `identity` →
 *   close (no anonymous peers).
 * - `task` before `hello`, or `task` before a verified `auth` → close.
 * - Message type that does not fit the current phase (e.g. `result` sent to a
 *   server, `hello_ack` after the handshake) → close.
 * - `auth` or `hello_ack.identity` that fails verification → close.
 * - Any message whose body fails structural validation → close.
 */

export const NETWORK_PROTOCOL_ID = "p2p-hub:network";
export const NETWORK_PROTOCOL_VERSION = 1;
/** mDNS TXT form of the protocol version ("1"). */
export const mDNS_PROTOCOL_VERSION = String(NETWORK_PROTOCOL_VERSION);

/**
 * The protocol versions this transport accepts. Default-deny and *non-
 * negotiable*: a connection is only accepted when the client offers an exact
 * supported version. There is no "pick the highest shared version" and no
 * downgrade path — a MITM must never be able to steer both sides toward a
 * weaker common version.
 */
export const SUPPORTED_VERSIONS: readonly number[] = [NETWORK_PROTOCOL_VERSION];

/** Time a server waits for `hello` before closing a connection. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Upper bound on the number of versions a client may claim in `hello`. */
export const MAX_VERSIONS = 16;
/** Upper bound on the number of capabilities in `hello`/`hello_ack`. */
export const MAX_CAPABILITIES = 256;

/**
 * Domain-separation context for the Fase 1B identity binding. Signatures over
 * `CONTEXT || clientNonce || ":" || serverNonce || ":" || certFingerprint` can
 * never be replayed as signatures in any other domain (contacts, peersite,
 * chat, …). Deliberately distinct from every other context in the repo; never
 * reuse.
 */
export const IDENTITY_BINDING_CONTEXT = "p2p-hub:network:identity-binding:v1:";

/** A handshake nonce is 16 random bytes, hex-encoded (32 hex chars). */
export const NONCE_BYTES = 16;

/** A peerId is a 64-char hex Ed25519 public key — same rule contacts enforces. */
export const PEER_ID_RE = /^[0-9a-f]{64}$/;
/** A normalized SHA-256 certificate fingerprint is 64 hex chars. */
export const CERT_FINGERPRINT_RE = /^[0-9a-f]{64}$/;
/** An Ed25519 signature is 64 bytes, hex-encoded (128 hex chars). */
export const SIGNATURE_RE = /^[0-9a-f]{128}$/;

export type WireMessageType = "hello" | "hello_ack" | "task" | "result" | "auth";

/**
 * Proof that the holder of the Ed25519 private key behind `peerId` also owns
 * the transport certificate with fingerprint `certFingerprint` on this
 * connection. `signature` verifies under `peerId` over
 * {@link buildIdentityBindingMessage}.
 */
export interface IdentityBinding {
  peerId: string;
  certFingerprint: string;
  signature: string;
}

export interface HelloBody {
  versions: number[];
  capabilities: string[];
  /** Client-chosen hex nonce anchoring the identity binding (mandatory). */
  nonce: string;
}

export interface HelloAckBody {
  version: number;
  capabilities: string[];
  limits?: { maxPayloadBytes?: number };
  /** Server-chosen hex nonce anchoring the identity binding (mandatory). */
  nonce: string;
  /** Server identity proof (mandatory — no anonymous servers). */
  identity: IdentityBinding;
}

export interface TaskBody {
  id: string;
  skill: string;
  payload: unknown;
}

export interface ResultBody {
  taskId: string;
  status: "ok" | "error";
  result?: unknown;
  error?: string;
}

export interface WireEnvelope {
  protocol: string;
  version: number;
  type: WireMessageType;
  body: HelloBody | HelloAckBody | TaskBody | ResultBody | IdentityBinding;
}

function isPositiveInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isIntArray(value: unknown, maxLen: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= maxLen &&
    value.every((n) => Number.isInteger(n) && (n as number) > 0)
  );
}

function isStringArray(value: unknown, maxLen: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxLen &&
    value.every((s) => typeof s === "string")
  );
}

/** A handshake nonce: hex, 1..32 bytes (2..64 hex chars). */
const NONCE_RE = /^[0-9a-f]{2,64}$/;

function isNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_RE.test(value);
}

/**
 * Strictly validate an identity binding. Returns `null` on any violation so
 * the caller can default-deny (close) instead of trusting a malformed claim.
 */
export function parseIdentityBinding(value: unknown): IdentityBinding | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const b = value as Record<string, unknown>;
  if (
    !isHexString(b.peerId, PEER_ID_RE) ||
    !isHexString(b.certFingerprint, CERT_FINGERPRINT_RE) ||
    !isHexString(b.signature, SIGNATURE_RE)
  ) {
    return null;
  }
  return {
    peerId: b.peerId as string,
    certFingerprint: b.certFingerprint as string,
    signature: b.signature as string,
  };
}

function isHexString(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

/**
 * Strict protocol-version gate: accept the connection only when the client's
 * advertised versions include an *exact* supported version. There is no
 * negotiation ("highest shared") and no downgrade path — the server never
 * agrees to a version it does not itself support. Returns `null` (default
 * deny) on any other input. Kept pure so the strictness is a testable rule.
 */
export function supportedVersion(clientVersions: unknown): number | null {
  if (!Array.isArray(clientVersions)) {
    return null;
  }
  return SUPPORTED_VERSIONS.find((version) => clientVersions.includes(version)) ?? null;
}

/** Strictly validate a decoded envelope. Returns `null` on any violation. */
export function parseEnvelope(value: unknown): WireEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.protocol !== NETWORK_PROTOCOL_ID) {
    return null;
  }
  if (envelope.version !== NETWORK_PROTOCOL_VERSION) {
    return null;
  }
  const type = envelope.type;
  if (
    type !== "hello" &&
    type !== "hello_ack" &&
    type !== "task" &&
    type !== "result" &&
    type !== "auth"
  ) {
    return null;
  }
  const body = envelope.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const b = body as Record<string, unknown>;

  switch (type) {
    case "hello": {
      if (!isIntArray(b.versions, MAX_VERSIONS)) {
        return null;
      }
      if (!isStringArray(b.capabilities, MAX_CAPABILITIES)) {
        return null;
      }
      if (!isNonce(b.nonce)) {
        return null;
      }
      return {
        protocol: NETWORK_PROTOCOL_ID,
        version: NETWORK_PROTOCOL_VERSION,
        type,
        body: {
          versions: b.versions,
          capabilities: b.capabilities,
          nonce: b.nonce,
        },
      };
    }
    case "hello_ack": {
      if (!isPositiveInt(b.version)) {
        return null;
      }
      if (!isStringArray(b.capabilities, MAX_CAPABILITIES)) {
        return null;
      }
      if (!isNonce(b.nonce)) {
        return null;
      }
      let limits: { maxPayloadBytes?: number } | undefined;
      if (b.limits !== undefined) {
        if (
          typeof b.limits !== "object" ||
          b.limits === null ||
          Array.isArray(b.limits)
        ) {
          return null;
        }
        const l = b.limits as Record<string, unknown>;
        if (
          l.maxPayloadBytes !== undefined &&
          !isPositiveInt(l.maxPayloadBytes)
        ) {
          return null;
        }
        limits = {
          ...(l.maxPayloadBytes !== undefined
            ? { maxPayloadBytes: l.maxPayloadBytes }
            : {}),
        };
      }
      const identity = parseIdentityBinding(b.identity);
      if (!identity) {
        return null;
      }
      return {
        protocol: NETWORK_PROTOCOL_ID,
        version: NETWORK_PROTOCOL_VERSION,
        type,
        body: {
          version: b.version,
          capabilities: b.capabilities,
          limits,
          nonce: b.nonce,
          identity,
        },
      };
    }
    case "task": {
      if (typeof b.id !== "string" || b.id.length === 0) {
        return null;
      }
      if (typeof b.skill !== "string" || b.skill.length === 0) {
        return null;
      }
      if (!("payload" in b)) {
        return null;
      }
      return {
        protocol: NETWORK_PROTOCOL_ID,
        version: NETWORK_PROTOCOL_VERSION,
        type,
        body: { id: b.id, skill: b.skill, payload: b.payload },
      };
    }
    case "auth": {
      const identity = parseIdentityBinding(body);
      if (!identity) {
        return null;
      }
      return {
        protocol: NETWORK_PROTOCOL_ID,
        version: NETWORK_PROTOCOL_VERSION,
        type,
        body: identity,
      };
    }
    case "result": {
      if (typeof b.taskId !== "string") {
        return null;
      }
      if (b.status !== "ok" && b.status !== "error") {
        return null;
      }
      if (b.error !== undefined && typeof b.error !== "string") {
        return null;
      }
      return {
        protocol: NETWORK_PROTOCOL_ID,
        version: NETWORK_PROTOCOL_VERSION,
        type,
        body: {
          taskId: b.taskId,
          status: b.status,
          result: b.result,
          error: b.error,
        },
      };
    }
  }
}

// --- Canonical encoders -------------------------------------------------------
// Each encoder builds the envelope with fields in the exact contract order, so
// the serialized bytes are deterministic and reimplementable from the spec.

export function encodeHello(
  versions: number[],
  capabilities: string[],
  nonce: string,
): string {
  return JSON.stringify({
    protocol: NETWORK_PROTOCOL_ID,
    version: NETWORK_PROTOCOL_VERSION,
    type: "hello",
    body: { versions, capabilities, nonce },
  });
}

export function encodeHelloAck(
  version: number,
  capabilities: string[],
  limits: { maxPayloadBytes?: number } | undefined,
  nonce: string,
  identity: IdentityBinding,
): string {
  const body: Record<string, unknown> = { version, capabilities };
  if (limits !== undefined && limits.maxPayloadBytes !== undefined) {
    body.limits = { maxPayloadBytes: limits.maxPayloadBytes };
  }
  body.nonce = nonce;
  body.identity = identity;
  return JSON.stringify({
    protocol: NETWORK_PROTOCOL_ID,
    version: NETWORK_PROTOCOL_VERSION,
    type: "hello_ack",
    body,
  });
}

export function encodeAuth(identity: IdentityBinding): string {
  return JSON.stringify({
    protocol: NETWORK_PROTOCOL_ID,
    version: NETWORK_PROTOCOL_VERSION,
    type: "auth",
    body: identity,
  });
}

export function encodeTask(task: TaskRequest): string {
  return JSON.stringify({
    protocol: NETWORK_PROTOCOL_ID,
    version: NETWORK_PROTOCOL_VERSION,
    type: "task",
    body: { id: task.id, skill: task.skill, payload: task.payload },
  });
}

export function encodeResult(result: TaskResult): string {
  const body: Record<string, unknown> = {
    taskId: result.taskId,
    status: result.status,
  };
  if (result.result !== undefined) {
    body.result = result.result;
  }
  if (result.error !== undefined) {
    body.error = result.error;
  }
  return JSON.stringify({
    protocol: NETWORK_PROTOCOL_ID,
    version: NETWORK_PROTOCOL_VERSION,
    type: "result",
    body,
  });
}

// --- Identity binding (Fase 1B) ------------------------------------------------

/**
 * The exact bytes a peer signs to bind its claimed identity to this
 * connection: `CONTEXT || clientNonce || ":" || serverNonce || ":" ||
 * certFingerprint`. Both nonces are hex as exchanged in the handshake (both
 * are mandatory — there is no anonymous side); `certFingerprint` is the normalized (lowercase, colon-stripped) SHA-256 fingerprint of the
 * certificate the signing side actually presented on this connection. The
 * context prefix is required — never sign caller-chosen bytes verbatim.
 */
export function buildIdentityBindingMessage(
  clientNonce: string,
  serverNonce: string,
  certFingerprint: string,
): Buffer {
  return Buffer.from(
    `${IDENTITY_BINDING_CONTEXT}${clientNonce}:${serverNonce}:${certFingerprint}`,
    "utf8",
  );
}

/** Generate a fresh handshake nonce (hex-encoded {@link NONCE_BYTES}). */
export function randomNonce(): string {
  return crypto.randomBytes(NONCE_BYTES).toString("hex");
}

/**
 * Verify an identity binding: `signature` must be a valid Ed25519 signature
 * under the Ed25519 public key `peerId` over
 * {@link buildIdentityBindingMessage}. Shape is validated first (regexes), so
 * malformed claims fail fast without touching crypto. Returns `false` (never
 * throws) on any invalid input.
 */
export function verifyIdentityBinding(
  peerId: string,
  clientNonce: string,
  serverNonce: string,
  certFingerprint: string,
  signature: string,
): boolean {
  if (
    !isHexString(peerId, PEER_ID_RE) ||
    !isHexString(certFingerprint, CERT_FINGERPRINT_RE) ||
    !isHexString(signature, SIGNATURE_RE)
  ) {
    return false;
  }
  try {
    const raw = Buffer.from(peerId, "hex");
    const publicKey = crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    });
    return crypto.verify(
      null,
      buildIdentityBindingMessage(clientNonce, serverNonce, certFingerprint),
      publicKey,
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

/** Normalize a certificate fingerprint for comparison and signing. */
export function normalizeFingerprint(
  fingerprint: string | undefined | null,
): string {
  return (fingerprint ?? "").replace(/:/g, "").toLowerCase();
}

export { MAX_PAYLOAD_BYTES };
