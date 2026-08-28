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
 *   body: { "versions": number[], "capabilities": string[], "nonce": string,
 *           "instanceId"?: string, "listenPort"?: number }
 *   `versions` = the protocol versions the client supports. `capabilities` =
 *   the skills the client offers for remote invocation. `nonce` = a
 *   client-chosen hex nonce (16 bytes) that anchors the identity binding
 *   (Fase 1B). `hello` MUST be the first message on a connection, and it MUST
 *   carry a nonce — there is no anonymous mode.
 *
 *   `instanceId` and `listenPort` are optional *reverse-registration hints*
 *   (proactive-peer-handshake): they tell the server where to reach the
 *   client back (its mDNS instance id and its listening port). The server uses
 *   them ONLY to build a discoverable route for a peer that connects without
 *   first being seen via mDNS (e.g. when the client's outbound multicast is
 *   blocked). They are informational — the server registers the route only
 *   after the client's identity has been *verified* via `auth`, and it never
 *   trusts the hints for anything security-relevant: the registered peerId
 *   comes from the verified `auth` and the registered certificate fingerprint
 *   from the certificate actually presented on the wire.
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
 *
 * sub_req    subscriber → publisher (client → server)
 *   body: { "subscriptionId": string, "topic": string,
 *           "action": "subscribe" | "unsubscribe", "ttlMs"?: number }
 *   Stap 5 (distributed subscriptions): a peer requests a subscription to (or
 *   an unsubscribe from) a remote topic. `subscriptionId` is chosen by the
 *   subscriber and is idempotent — re-sending a `subscribe` with the same id
 *   refreshes the subscription (heartbeat), `unsubscribe` with the same id
 *   tears it down. `topic` follows the hook-event naming convention
 *   (`<ns>:<name>`, e.g. `calendar:eventAdded`); a trailing `:*` wildcard
 *   (`calendar:*`) is allowed and matches every topic under that namespace —
 *   wildcard subscriptions are re-authorized per topic at emit time by the
 *   hub, never at subscribe time alone. `ttlMs` is a *requested* lifetime; the
 *   publisher may grant less. `sub_req` MUST follow a verified `auth`, like
 *   `task`.
 *
 * sub_ack    publisher → subscriber (server → client)
 *   body: { "subscriptionId": string, "topic": string, "accepted": boolean,
 *           "reason"?: string, "ttlMs"?: number }
 *   The reply to a `sub_req`. `accepted: true` means the subscription is now
 *   registered (or, for `unsubscribe`, was removed); `ttlMs` is the effective
 *   lifetime the publisher granted. `accepted: false` carries a bounded
 *   `reason` (e.g. `topic-not-exposed`, `peer-not-authorized`,
 *   `subscription-cap`) — the peer learns whether its request was granted,
 *   never *why* a security decision was made beyond the fail-closed reason.
 *
 * event_emit publisher → subscriber (client → server)
 *   body: { "subscriptionId": string, "topic": string,
 *           "publisherPeerId": string, "timestamp": number,
 *           "sequenceNumber": number, "payload": unknown }
 *   A published event delivered to a subscribed peer. `publisherPeerId` is
 *   NEVER a trusted caller-supplied identity: the receiver MUST compare it to
 *   the Fase 1B authenticated peerId of the connection and drop (or close) on
 *   mismatch — a relayed frame can carry a false publisher. `timestamp` is the
 *   publisher's event time in epoch ms; `sequenceNumber` is a per-subscription
 *   monotonic counter so the subscriber can detect loss/reordering.
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
 * - `sub_req`/`event_emit` before a verified `auth` → close (same phase
 *   discipline as `task` — there is no anonymous event traffic).
 * - Message type that does not fit the current phase (e.g. `result` sent to a
 *   server, `hello_ack` after the handshake) → close.
 * - `auth` or `hello_ack.identity` that fails verification → close.
 * - Any message whose body fails structural validation → close.
 * - `event_emit` whose `publisherPeerId` does not equal the authenticated
 *   peerId of the connection → close (publisher identity is never caller-
 *   supplied).
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
/** Upper bound on a `sub_req`/`sub_ack` subscription id length. */
export const MAX_SUBSCRIPTION_ID_LENGTH = 128;
/** Upper bound on a wire `topic` string length. */
export const MAX_TOPIC_LENGTH = 256;
/** Upper bound on a `sub_ack` deny `reason` length. */
export const MAX_ACK_REASON_LENGTH = 128;

/**
 * A wire `topic`: `[A-Za-z0-9_][A-Za-z0-9_.-]*` with zero to three
 * namespace segments (`:name`) and an optional trailing `:*` wildcard. Follows
 * the hook-event naming convention (`calendar:eventAdded`), so a peer cannot
 * smuggle path-like or control characters into a topic; the `:`-delimiter is
 * what namespace checks anchor on (CLAUDE.md principle #2). The segment count
 * is bounded (mirrors `MAX_TOPIC_SEGMENTS` in core's `EVENT_TOPIC_RE`) so a
 * peer cannot construct unbounded nesting on the wire; a `:` is never allowed
 * *inside* a segment value, so `:` stays the one unambiguous delimiter.
 * Wildcards are only the terminal `:*` form — never a bare `*` or a
 * mid-string star.
 */
const TOPIC_RE =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*){0,3}(?::\*)?$/;

/** A subscription id is bounded and dot/underscore/dash safe (map keys). */
const SUBSCRIPTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

export type WireMessageType =
  | "hello"
  | "hello_ack"
  | "task"
  | "result"
  | "auth"
  | "sub_req"
  | "sub_ack"
  | "event_emit";

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
  /**
   * Reverse-registration hint: the sender's mDNS instance id. Optional; used
   * by the server to key a discovered route for a peer that connects without
   * being seen via mDNS. Informational — identity is still proven via `auth`.
   */
  instanceId?: string;
  /**
   * Reverse-registration hint: the sender's listening port. Optional; used by
   * the server to reach the client back. Informational only.
   */
  listenPort?: number;
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

/** `subscribe` | `unsubscribe` — the only two subscription actions. */
export type SubscriptionAction = "subscribe" | "unsubscribe";

/** `sub_req` body (subscriber → publisher). */
export interface SubReqBody {
  subscriptionId: string;
  topic: string;
  action: SubscriptionAction;
  /** Requested subscription lifetime in ms; the publisher may grant less. */
  ttlMs?: number;
}

/** `sub_ack` body (publisher → subscriber). */
export interface SubAckBody {
  subscriptionId: string;
  topic: string;
  accepted: boolean;
  /** Fail-closed deny reason (bounded) when `accepted` is false. */
  reason?: string;
  /** Effective granted lifetime in ms (present on `subscribe` accepts). */
  ttlMs?: number;
}

/** `event_emit` body (publisher → subscriber). */
export interface EventEmitBody {
  subscriptionId: string;
  topic: string;
  /**
   * The publisher's persistent peerId. NEVER caller-trusted: the receiver
   * verifies it equals the Fase 1B authenticated connection peerId.
   */
  publisherPeerId: string;
  /** Publisher's event time in epoch ms. */
  timestamp: number;
  /** Per-subscription monotonic counter (loss/reorder detection). */
  sequenceNumber: number;
  payload: unknown;
}

export interface WireEnvelope {
  protocol: string;
  version: number;
  type: WireMessageType;
  body:
    | HelloBody
    | HelloAckBody
    | TaskBody
    | ResultBody
    | IdentityBinding
    | SubReqBody
    | SubAckBody
    | EventEmitBody;
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

function isSubscriptionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SUBSCRIPTION_ID_LENGTH &&
    SUBSCRIPTION_ID_RE.test(value)
  );
}

function isTopic(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOPIC_LENGTH &&
    TOPIC_RE.test(value)
  );
}

function isSubscriptionAction(value: unknown): value is SubscriptionAction {
  return value === "subscribe" || value === "unsubscribe";
}

/**
 * A reverse-registration instance id: 1..64 chars of `[A-Za-z0-9-]`. It is
 * used only as a discovered-map key, but it MUST be strictly bounded anyway —
 * never trust a peer-supplied identifier for anything, even a map key.
 */
const INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

function isInstanceId(value: unknown): value is string {
  return typeof value === "string" && INSTANCE_ID_RE.test(value);
}

/** A valid TCP port a peer may claim to listen on. */
function isListenPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
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
    type !== "auth" &&
    type !== "sub_req" &&
    type !== "sub_ack" &&
    type !== "event_emit"
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
      // Reverse-registration hints are optional but strictly validated when
      // present (default-deny on a malformed hint).
      if (b.instanceId !== undefined && !isInstanceId(b.instanceId)) {
        return null;
      }
      if (b.listenPort !== undefined && !isListenPort(b.listenPort)) {
        return null;
      }
      const body: HelloBody = {
        versions: b.versions,
        capabilities: b.capabilities,
        nonce: b.nonce,
      };
      if (b.instanceId !== undefined) {
        body.instanceId = b.instanceId as string;
      }
      if (b.listenPort !== undefined) {
        body.listenPort = b.listenPort as number;
      }
      return {
        protocol: NETWORK_PROTOCOL_ID,
        version: NETWORK_PROTOCOL_VERSION,
        type,
        body,
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
    case "sub_req": {
      if (!isSubscriptionId(b.subscriptionId) || !isTopic(b.topic)) {
        return null;
      }
      if (!isSubscriptionAction(b.action)) {
        return null;
      }
      if (b.ttlMs !== undefined && !isPositiveInt(b.ttlMs)) {
        return null;
      }
      const body: SubReqBody = {
        subscriptionId: b.subscriptionId,
        topic: b.topic,
        action: b.action,
      };
      if (b.ttlMs !== undefined) {
        body.ttlMs = b.ttlMs as number;
      }
      return {
        protocol: NETWORK_PROTOCOL_ID,
        version: NETWORK_PROTOCOL_VERSION,
        type,
        body,
      };
    }
    case "sub_ack": {
      if (!isSubscriptionId(b.subscriptionId) || !isTopic(b.topic)) {
        return null;
      }
      if (typeof b.accepted !== "boolean") {
        return null;
      }
      if (
        b.reason !== undefined &&
        (typeof b.reason !== "string" ||
          b.reason.length === 0 ||
          b.reason.length > MAX_ACK_REASON_LENGTH)
      ) {
        return null;
      }
      if (b.ttlMs !== undefined && !isPositiveInt(b.ttlMs)) {
        return null;
      }
      const body: SubAckBody = {
        subscriptionId: b.subscriptionId,
        topic: b.topic,
        accepted: b.accepted,
      };
      if (b.reason !== undefined) {
        body.reason = b.reason as string;
      }
      if (b.ttlMs !== undefined) {
        body.ttlMs = b.ttlMs as number;
      }
      return {
        protocol: NETWORK_PROTOCOL_ID,
        version: NETWORK_PROTOCOL_VERSION,
        type,
        body,
      };
    }
    case "event_emit": {
      if (!isSubscriptionId(b.subscriptionId) || !isTopic(b.topic)) {
        return null;
      }
      if (!isHexString(b.publisherPeerId, PEER_ID_RE)) {
        return null;
      }
      if (!Number.isInteger(b.timestamp) || (b.timestamp as number) <= 0) {
        return null;
      }
      if (
        !Number.isInteger(b.sequenceNumber) ||
        (b.sequenceNumber as number) < 0
      ) {
        return null;
      }
      if (!("payload" in b) || b.payload === undefined) {
        return null;
      }
      return {
        protocol: NETWORK_PROTOCOL_ID,
        version: NETWORK_PROTOCOL_VERSION,
        type,
        body: {
          subscriptionId: b.subscriptionId,
          topic: b.topic,
          publisherPeerId: b.publisherPeerId,
          timestamp: b.timestamp as number,
          sequenceNumber: b.sequenceNumber as number,
          payload: b.payload,
        },
      };
    }
  }
}

// --- Canonical encoders -------------------------------------------------------
// Each encoder builds the envelope with fields in the exact contract order, so
// the serialized bytes are deterministic and reimplementable from the spec.

export interface HelloHints {
  /** The sender's mDNS instance id (reverse-registration key). */
  instanceId: string;
  /** The sender's listening port (reverse-registration connect-back). */
  listenPort: number;
}

export function encodeHello(
  versions: number[],
  capabilities: string[],
  nonce: string,
  hints?: HelloHints,
): string {
  const body: Record<string, unknown> = { versions, capabilities, nonce };
  if (hints) {
    body.instanceId = hints.instanceId;
    body.listenPort = hints.listenPort;
  }
  return JSON.stringify({
    protocol: NETWORK_PROTOCOL_ID,
    version: NETWORK_PROTOCOL_VERSION,
    type: "hello",
    body,
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

export function encodeSubReq(body: SubReqBody): string {
  const b: Record<string, unknown> = {
    subscriptionId: body.subscriptionId,
    topic: body.topic,
    action: body.action,
  };
  if (body.ttlMs !== undefined) {
    b.ttlMs = body.ttlMs;
  }
  return JSON.stringify({
    protocol: NETWORK_PROTOCOL_ID,
    version: NETWORK_PROTOCOL_VERSION,
    type: "sub_req",
    body: b,
  });
}

export function encodeSubAck(body: SubAckBody): string {
  const b: Record<string, unknown> = {
    subscriptionId: body.subscriptionId,
    topic: body.topic,
    accepted: body.accepted,
  };
  if (body.reason !== undefined) {
    b.reason = body.reason;
  }
  if (body.ttlMs !== undefined) {
    b.ttlMs = body.ttlMs;
  }
  return JSON.stringify({
    protocol: NETWORK_PROTOCOL_ID,
    version: NETWORK_PROTOCOL_VERSION,
    type: "sub_ack",
    body: b,
  });
}

export function encodeEventEmit(body: EventEmitBody): string {
  return JSON.stringify({
    protocol: NETWORK_PROTOCOL_ID,
    version: NETWORK_PROTOCOL_VERSION,
    type: "event_emit",
    body: {
      subscriptionId: body.subscriptionId,
      topic: body.topic,
      publisherPeerId: body.publisherPeerId,
      timestamp: body.timestamp,
      sequenceNumber: body.sequenceNumber,
      payload: body.payload,
    },
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
