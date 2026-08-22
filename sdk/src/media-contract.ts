/**
 * Versioned P2P media capability wire contract — `p2p-hub:media:v1`.
 *
 * Requesting live camera/microphone access from a *remote peer* is a Tier-2
 * native-confirm action (plan.md decision, design doc "Decision 2"): the
 * browser's own `getUserMedia` permission UI is deliberately not part of this
 * path. This module is the explicit, versioned wire contract the requesting
 * peer and the confirming shell share, so an independent implementation can
 * interoperate without sharing TypeScript:
 *
 *   - the wire object has a fixed field set and a canonical serialization
 *     (fixed key order — the bytes are the contract, not a shared constructor);
 *   - unknown protocols / versions, malformed envelopes, and any shape
 *     mismatch default to deny;
 *   - the envelope never carries an identity or token: authorization is decided
 *     by the platform on the transport-verified caller identity (Fase 2A /
 *     Fase 1B identity binding), so there is nothing here to spoof.
 *
 * Layering: the network-light transport negotiates its own wire version
 * (`p2p-hub:network` v1) and capability names in the handshake; this module is
 * the capability-level payload carried inside a `task` whose skill is
 * `core.media.request`. The response is the *verdict* (granted/denied) — the
 * actual stream transport is out of scope for this slice and would consume a
 * grant only after the native confirmation produced it.
 */

import {
  MAX_OBJECT_DEPTH,
  isPlainObject,
  validateObjectDepth,
} from "./boundary-guard";

/** Protocol id of the media capability. Never reuse for another capability. */
export const MEDIA_PROTOCOL_ID = "p2p-hub:media";

/** Current wire version of the media capability. */
export const MEDIA_PROTOCOL_VERSION = 1;

/** The two device classes the capability can request. */
export type MediaKind = "camera" | "microphone";

/** Lower bound on a requested width/height, in pixels. */
export const MIN_MEDIA_RESOLUTION = 16;

/** Upper bound on a requested width/height, in pixels. */
export const MAX_MEDIA_RESOLUTION = 8192;

/** Lower bound on a requested frame rate, in frames per second. */
export const MIN_MEDIA_FRAME_RATE = 1;

/** Upper bound on a requested frame rate, in frames per second. */
export const MAX_MEDIA_FRAME_RATE = 240;

/**
 * Requested stream parameters. Every field is optional — a bare kind is a
 * valid request that asks for the peer's default — and every field is bounded
 * so an oversized number can never reach the native confirm layer.
 */
export interface MediaStreamParams {
  /** Requested width in pixels. Bounded to [16, 8192]. */
  width?: number;
  /** Requested height in pixels. Bounded to [16, 8192]. */
  height?: number;
  /** Requested frame rate in frames per second. Bounded to [1, 240]. */
  frameRate?: number;
}

/** Canonical request: `{ protocol, version, kind, requested? }`. */
export interface MediaRequest {
  protocol: typeof MEDIA_PROTOCOL_ID;
  version: typeof MEDIA_PROTOCOL_VERSION;
  kind: MediaKind;
  requested?: MediaStreamParams;
}

/** Error codes a peer must be able to distinguish. */
export type MediaErrorCode =
  | "unsupported-version"
  | "malformed"
  | "unauthorized"
  | "denied"
  | "rate-limited";

/** Canonical grant response: `{ protocol, version, status, expiresInMs }`. */
export interface MediaGrantResponse {
  protocol: typeof MEDIA_PROTOCOL_ID;
  version: typeof MEDIA_PROTOCOL_VERSION;
  status: "granted";
  /** Grant lifetime in ms, decided by the confirming shell. */
  expiresInMs: number;
}

/** Canonical error response: `{ protocol, version, status, code }`. */
export interface MediaErrorResponse {
  protocol: typeof MEDIA_PROTOCOL_ID;
  version: typeof MEDIA_PROTOCOL_VERSION;
  status: "error";
  code: MediaErrorCode;
}

export type MediaResponse = MediaGrantResponse | MediaErrorResponse;

const REQUEST_REQUIRED_KEYS = ["kind", "protocol", "version"];
const REQUEST_KEYS = ["kind", "protocol", "version", "requested"];
const GRANT_KEYS = ["expiresInMs", "protocol", "status", "version"];
const ERROR_KEYS = ["code", "protocol", "status", "version"];
const PARAMS_KEYS = ["frameRate", "height", "width"];

function isBoundedResolution(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_MEDIA_RESOLUTION &&
    value <= MAX_MEDIA_RESOLUTION
  );
}

function isBoundedFrameRate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_MEDIA_FRAME_RATE &&
    value <= MAX_MEDIA_FRAME_RATE
  );
}

function parseRequested(value: unknown): { ok: false } | { ok: true; requested?: MediaStreamParams } {
  if (value === undefined) {
    return { ok: true };
  }
  if (!isPlainObject(value)) {
    return { ok: false };
  }
  const keys = Object.keys(value);
  if (!keys.every((k) => PARAMS_KEYS.includes(k))) {
    return { ok: false };
  }
  const params: MediaStreamParams = {};
  if (value.width !== undefined) {
    if (!isBoundedResolution(value.width)) {
      return { ok: false };
    }
    params.width = value.width;
  }
  if (value.height !== undefined) {
    if (!isBoundedResolution(value.height)) {
      return { ok: false };
    }
    params.height = value.height;
  }
  if (value.frameRate !== undefined) {
    if (!isBoundedFrameRate(value.frameRate)) {
      return { ok: false };
    }
    params.frameRate = value.frameRate;
  }
  return { ok: true, requested: params };
}

/**
 * Parse and validate a media request envelope (a decoded JSON payload from the
 * transport). Default-deny: an unknown protocol or version is
 * `unsupported-version`, any other shape mismatch (missing/extra fields, bad
 * `kind`, unbounded stream params, a smuggled `peerId`) is `malformed`. The
 * envelope is deliberately never resolved here — authorization is the
 * platform's job on the transport-verified caller identity.
 */
export function parseMediaRequest(
  payload: unknown,
): { ok: true; request: MediaRequest } | { ok: false; code: MediaErrorCode } {
  if (!isPlainObject(payload)) {
    return { ok: false, code: "malformed" };
  }
  const keys = Object.keys(payload);
  if (!keys.every((k) => REQUEST_KEYS.includes(k))) {
    return { ok: false, code: "malformed" };
  }
  for (const key of REQUEST_REQUIRED_KEYS) {
    if (payload[key] === undefined) {
      return { ok: false, code: "malformed" };
    }
  }
  if (payload.protocol !== MEDIA_PROTOCOL_ID) {
    return { ok: false, code: "unsupported-version" };
  }
  if (payload.version !== MEDIA_PROTOCOL_VERSION) {
    return { ok: false, code: "unsupported-version" };
  }
  if (payload.kind !== "camera" && payload.kind !== "microphone") {
    return { ok: false, code: "malformed" };
  }
  const requested = parseRequested(payload.requested);
  if (!requested.ok) {
    return { ok: false, code: "malformed" };
  }
  const request: MediaRequest = { protocol: MEDIA_PROTOCOL_ID, version: MEDIA_PROTOCOL_VERSION, kind: payload.kind };
  if (requested.requested !== undefined) {
    request.requested = requested.requested;
  }
  return { ok: true, request };
}

/** Build a canonical version-1 request for a device class. */
export function buildMediaRequest(
  kind: MediaKind,
  requested?: MediaStreamParams,
): MediaRequest {
  const request: MediaRequest = {
    protocol: MEDIA_PROTOCOL_ID,
    version: MEDIA_PROTOCOL_VERSION,
    kind,
  };
  if (requested !== undefined) {
    request.requested = requested;
  }
  return request;
}

/**
 * Human-readable summary of a parsed request, for the native confirm prompt.
 * Never includes the peerId — the shell already shows that as the caller — and
 * never echoes any caller-supplied free text (there is none in this contract).
 */
export function buildMediaRequestSummary(request: MediaRequest): string {
  const device = request.kind === "camera" ? "camera" : "microphone";
  const p = request.requested;
  if (!p) {
    return `${device} access with default settings`;
  }
  const parts: string[] = [];
  if (p.width !== undefined && p.height !== undefined) {
    parts.push(`${p.width}x${p.height}`);
  }
  if (p.frameRate !== undefined) {
    parts.push(`${p.frameRate} fps`);
  }
  return parts.length > 0 ? `${device} access (${parts.join(", ")})` : `${device} access with default settings`;
}

/** Build a canonical grant response envelope. */
export function encodeMediaGrant(expiresInMs: number): MediaGrantResponse {
  return {
    protocol: MEDIA_PROTOCOL_ID,
    version: MEDIA_PROTOCOL_VERSION,
    status: "granted",
    expiresInMs,
  };
}

/** Build a canonical error response envelope. */
export function encodeMediaError(code: MediaErrorCode): MediaErrorResponse {
  return {
    protocol: MEDIA_PROTOCOL_ID,
    version: MEDIA_PROTOCOL_VERSION,
    status: "error",
    code,
  };
}

const ERROR_CODES: ReadonlySet<string> = new Set<MediaErrorCode>([
  "unsupported-version",
  "malformed",
  "unauthorized",
  "denied",
  "rate-limited",
]);

/**
 * Parse and validate a media response envelope (decoded by the requesting peer
 * from the remote task result). Returns `null` for any shape mismatch — a
 * non-compliant peer is denied by default.
 */
export function parseMediaResponse(payload: unknown): MediaResponse | null {
  if (!isPlainObject(payload)) {
    return null;
  }
  const keys = Object.keys(payload);
  if (payload.protocol !== MEDIA_PROTOCOL_ID) {
    return null;
  }
  if (payload.version !== MEDIA_PROTOCOL_VERSION) {
    return null;
  }
  if (payload.status === "granted") {
    if (
      keys.length !== GRANT_KEYS.length ||
      !keys.every((k) => GRANT_KEYS.includes(k)) ||
      typeof payload.expiresInMs !== "number" ||
      !Number.isFinite(payload.expiresInMs) ||
      payload.expiresInMs <= 0
    ) {
      return null;
    }
    return {
      protocol: payload.protocol,
      version: payload.version,
      status: "granted",
      expiresInMs: payload.expiresInMs,
    };
  }
  if (payload.status === "error") {
    if (
      keys.length !== ERROR_KEYS.length ||
      !keys.every((k) => ERROR_KEYS.includes(k)) ||
      typeof payload.code !== "string" ||
      !ERROR_CODES.has(payload.code)
    ) {
      return null;
    }
    return {
      protocol: payload.protocol,
      version: payload.version,
      status: "error",
      code: payload.code as MediaErrorCode,
    };
  }
  return null;
}

const REQUEST_KEY_ORDER = ["protocol", "version", "kind", "requested"];
const PARAMS_KEY_ORDER = ["width", "height", "frameRate"];
const GRANT_KEY_ORDER = ["protocol", "version", "status", "expiresInMs"];
const ERROR_KEY_ORDER = ["protocol", "version", "status", "code"];

function canonicalizeParams(params: MediaStreamParams): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};
  for (const key of PARAMS_KEY_ORDER) {
    if (params[key as keyof MediaStreamParams] !== undefined) {
      canonical[key] = params[key as keyof MediaStreamParams];
    }
  }
  return canonical;
}

/**
 * The canonical byte form of an envelope — the only place a media envelope is
 * serialized to the wire. Fixed key order, and it runs
 * {@link validateObjectDepth} before `JSON.stringify` so a hostile graph can
 * never reach a recursive stringify (CLAUDE.md JSON-depth invariant). Pinned
 * bytes are asserted in tests.
 */
export function serializeMediaEnvelope(envelope: MediaRequest | MediaResponse): string {
  validateObjectDepth(envelope, MAX_OBJECT_DEPTH);
  const record = envelope as unknown as Record<string, unknown>;
  const status = record.status;
  const canonical: Record<string, unknown> = {};
  if (status === undefined) {
    for (const key of REQUEST_KEY_ORDER) {
      if (record[key] !== undefined) {
        canonical[key] =
          key === "requested" && record.requested !== undefined
            ? canonicalizeParams(record.requested as MediaStreamParams)
            : record[key];
      }
    }
  } else if (status === "granted") {
    for (const key of GRANT_KEY_ORDER) {
      canonical[key] = record[key];
    }
  } else {
    for (const key of ERROR_KEY_ORDER) {
      canonical[key] = record[key];
    }
  }
  return JSON.stringify(canonical);
}
