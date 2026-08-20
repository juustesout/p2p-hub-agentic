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
 *   body: { "versions": number[], "capabilities": string[] }
 *   `versions` = the client's supported protocol versions, descending
 *   preference. `capabilities` = the skills the client offers for remote
 *   invocation. `hello` MUST be the first message on a connection.
 *
 * hello_ack  server → client
 *   body: { "version": number, "capabilities": string[], "limits"?: { "maxPayloadBytes": number } }
 *   The server picks the highest version from the client's `versions` that it
 *   also supports; no intersection ⇒ close the connection. `capabilities` =
 *   the skills the server offers. `limits.maxPayloadBytes` bounds the
 *   serialized envelope length (frame body) the server will accept — a
 *   compliant client refuses to send a larger task without putting it on the
 *   wire.
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
 * ## Default-deny rules
 *
 * - Envelope with unknown protocol / unsupported version → close.
 * - `task` before `hello` → close.
 * - Message type that does not fit the current phase (e.g. `result` sent to a
 *   server, `hello_ack` after the handshake) → close.
 * - Any message whose body fails structural validation → close.
 */

export const NETWORK_PROTOCOL_ID = "p2p-hub:network";
export const NETWORK_PROTOCOL_VERSION = 1;
/** mDNS TXT form of the protocol version ("1"). */
export const mDNS_PROTOCOL_VERSION = String(NETWORK_PROTOCOL_VERSION);

/** Time a server waits for `hello` before closing a connection. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Upper bound on the number of versions a client may claim in `hello`. */
export const MAX_VERSIONS = 16;
/** Upper bound on the number of capabilities in `hello`/`hello_ack`. */
export const MAX_CAPABILITIES = 256;

export type WireMessageType = "hello" | "hello_ack" | "task" | "result";

export interface HelloBody {
  versions: number[];
  capabilities: string[];
}

export interface HelloAckBody {
  version: number;
  capabilities: string[];
  limits?: { maxPayloadBytes?: number };
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
  body: HelloBody | HelloAckBody | TaskBody | ResultBody;
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

/**
 * Pick the highest protocol version both sides support, or `null` when there
 * is no intersection (default-deny). Only {@link NETWORK_PROTOCOL_VERSION} is
 * supported today, so negotiation is trivial but stays a pure, testable rule.
 */
export function negotiateVersion(clientVersions: unknown): number | null {
  if (!Array.isArray(clientVersions)) {
    return null;
  }
  return clientVersions.includes(NETWORK_PROTOCOL_VERSION)
    ? NETWORK_PROTOCOL_VERSION
    : null;
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
    type !== "result"
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
      return {
        protocol: NETWORK_PROTOCOL_ID,
        version: NETWORK_PROTOCOL_VERSION,
        type,
        body: { versions: b.versions, capabilities: b.capabilities },
      };
    }
    case "hello_ack": {
      if (!isPositiveInt(b.version)) {
        return null;
      }
      if (!isStringArray(b.capabilities, MAX_CAPABILITIES)) {
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
      return {
        protocol: NETWORK_PROTOCOL_ID,
        version: NETWORK_PROTOCOL_VERSION,
        type,
        body: {
          version: b.version,
          capabilities: b.capabilities,
          limits,
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
): string {
  return JSON.stringify({
    protocol: NETWORK_PROTOCOL_ID,
    version: NETWORK_PROTOCOL_VERSION,
    type: "hello",
    body: { versions, capabilities },
  });
}

export function encodeHelloAck(
  version: number,
  capabilities: string[],
  limits?: { maxPayloadBytes?: number },
): string {
  const body: Record<string, unknown> = { version, capabilities };
  if (limits !== undefined && limits.maxPayloadBytes !== undefined) {
    body.limits = { maxPayloadBytes: limits.maxPayloadBytes };
  }
  return JSON.stringify({
    protocol: NETWORK_PROTOCOL_ID,
    version: NETWORK_PROTOCOL_VERSION,
    type: "hello_ack",
    body,
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

export { MAX_PAYLOAD_BYTES };
