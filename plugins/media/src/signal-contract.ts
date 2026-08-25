import {
  MAX_OBJECT_DEPTH,
  isPlainObject,
  validateObjectDepth,
  validatePayloadSize,
} from "@p2p-hub/sdk";
import type { MediaKind } from "@p2p-hub/sdk";

/**
 * Wire contract for the media signaling capability (`plugins/media`).
 *
 * This is the SDP/ICE exchange envelope between two peers. It deliberately
 * carries NO identity/token fields: authorization comes exclusively from the
 * transport-verified `invocation.peerId` (Fase 1B), never from a caller-
 * supplied payload field. Unknown keys are rejected (not ignored) so a
 * smuggled `peerId` can never ride along unnoticed — the same discipline as
 * the `p2p-hub:website:v1` and `p2p-hub:media:v1` contracts.
 *
 * Parsing is fail-closed: any shape mismatch (missing/extra keys, wrong
 * types, out-of-range values) yields `null`, and every handler treats `null`
 * as a malformed-message denial. Payloads are additionally checked with the
 * SDK boundary-guard (`validateObjectDepth` + `validatePayloadSize`) at the
 * handler boundary, defence-in-depth on top of the transport's own checks.
 */

export const SIGNAL_PROTOCOL = "p2p-hub:media-signaling";
export const SIGNAL_VERSION = 1;

/** Access-pass scope that lifts the verified-contact gate on signaling. */
export const MEDIA_SIGNAL_SCOPE = "media-signal";

/** Upper bound on an SDP session description body. */
export const MAX_SDP_LENGTH = 128 * 1024;
/** Upper bound on a single ICE candidate string. */
export const MAX_CANDIDATE_LENGTH = 8 * 1024;
/** Upper bound on a callId. */
export const MAX_CALL_ID_LENGTH = 64;
/** Upper bound on the number of calls tracked in one plugin instance. */
export const MAX_CALLS = 32;
/** Upper bound on buffered remote ICE candidates per call (drop-oldest). */
export const MAX_CANDIDATES_PER_CALL = 256;

export type SignalMessageKind = "offer" | "answer" | "candidate";

/** A single ICE candidate, as carried by `media.iceCandidate`. */
export interface IceCandidate {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}

export interface SignalOffer {
  kind: "offer";
  callId: string;
  mediaKind: MediaKind;
  sdp: string;
}

export interface SignalAnswer {
  kind: "answer";
  callId: string;
  sdp: string;
}

export interface SignalCandidate {
  kind: "candidate";
  callId: string;
  candidate: IceCandidate;
}

export type SignalMessage = SignalOffer | SignalAnswer | SignalCandidate;

const OFFER_KEYS = ["callId", "kind", "protocol", "sdp", "version"];
const ANSWER_KEYS = ["callId", "protocol", "sdp", "version"];
const CANDIDATE_KEYS = ["callId", "candidate", "protocol", "version"];
const CANDIDATE_OBJECT_KEYS = ["candidate", "sdpMid", "sdpMLineIndex"];

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function parseIceCandidate(value: unknown): IceCandidate | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  for (const key of keys) {
    if (!CANDIDATE_OBJECT_KEYS.includes(key)) {
      return null;
    }
  }
  if (!isBoundedString(obj.candidate, MAX_CANDIDATE_LENGTH)) {
    return null;
  }
  const out: IceCandidate = { candidate: obj.candidate };
  if (obj.sdpMid !== undefined) {
    if (!isBoundedString(obj.sdpMid, 256)) {
      return null;
    }
    out.sdpMid = obj.sdpMid;
  }
  if (obj.sdpMLineIndex !== undefined) {
    if (
      typeof obj.sdpMLineIndex !== "number" ||
      !Number.isInteger(obj.sdpMLineIndex) ||
      obj.sdpMLineIndex < 0
    ) {
      return null;
    }
    out.sdpMLineIndex = obj.sdpMLineIndex;
  }
  return out;
}

function isCallId(value: unknown): value is string {
  return isBoundedString(value, MAX_CALL_ID_LENGTH);
}

/**
 * Parse a signaling envelope for the given message kind. Returns `null` on any
 * shape mismatch — never throws. Extra keys (e.g. a caller-supplied `peerId`)
 * are rejected, not silently ignored.
 */
export function parseSignalMessage<K extends SignalMessageKind>(
  payload: unknown,
  kind: K,
): Extract<SignalMessage, { kind: K }> | null {
  if (!isPlainObject(payload)) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const keys = kind === "offer" ? OFFER_KEYS : kind === "answer" ? ANSWER_KEYS : CANDIDATE_KEYS;
  if (!hasExactKeys(obj, keys)) {
    return null;
  }
  if (obj.protocol !== SIGNAL_PROTOCOL || obj.version !== SIGNAL_VERSION) {
    return null;
  }
  if (!isCallId(obj.callId)) {
    return null;
  }
  if (kind === "offer") {
    if (obj.kind !== "camera" && obj.kind !== "microphone") {
      return null;
    }
    if (!isBoundedString(obj.sdp, MAX_SDP_LENGTH)) {
      return null;
    }
    return {
      kind: "offer",
      callId: obj.callId,
      mediaKind: obj.kind,
      sdp: obj.sdp,
    } as Extract<SignalMessage, { kind: K }>;
  }
  if (kind === "answer") {
    if (!isBoundedString(obj.sdp, MAX_SDP_LENGTH)) {
      return null;
    }
    return {
      kind: "answer",
      callId: obj.callId,
      sdp: obj.sdp,
    } as Extract<SignalMessage, { kind: K }>;
  }
  const candidate = parseIceCandidate(obj.candidate);
  if (!candidate) {
    return null;
  }
  return {
    kind: "candidate",
    callId: obj.callId,
    candidate,
  } as Extract<SignalMessage, { kind: K }>;
}

/** Guard an inbound signaling payload with the SDK boundary-guard. Throws typed errors. */
export function guardSignalPayload(payload: unknown): void {
  validateObjectDepth(payload, MAX_OBJECT_DEPTH);
  validatePayloadSize(JSON.stringify(payload ?? null) ?? "null");
}

/**
 * Serialize a signaling message to its wire form (canonical key order). Callers
 * may pass externally-derived data into `candidate`, so the object is depth-
 * validated before stringification per the CLAUDE.md JSON-depth invariant.
 */
export function encodeSignalMessage(msg: SignalMessage): Record<string, unknown> {
  const base: Record<string, unknown> = {
    protocol: SIGNAL_PROTOCOL,
    version: SIGNAL_VERSION,
    callId: msg.callId,
  };
  if (msg.kind === "offer") {
    validateObjectDepth(msg, MAX_OBJECT_DEPTH);
    return { ...base, kind: msg.mediaKind, sdp: msg.sdp };
  }
  if (msg.kind === "answer") {
    validateObjectDepth(msg, MAX_OBJECT_DEPTH);
    return { ...base, sdp: msg.sdp };
  }
  validateObjectDepth(msg, MAX_OBJECT_DEPTH);
  return { ...base, candidate: { ...msg.candidate } };
}
