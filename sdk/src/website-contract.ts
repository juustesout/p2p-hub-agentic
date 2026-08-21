/**
 * Versioned P2P website capability wire contract — `p2p-hub:website:v1`.
 *
 * The static-website flow is a *capability* offered by a peer, not a public
 * HTTP server (plan.md "P2P Static Websites"). Peer A publishes a configured
 * local directory; peer B requests individual assets over the P2P transport.
 * This module is the explicit, versioned contract both sides share so an
 * independent implementation can interoperate without sharing TypeScript:
 *
 *   - the wire object has a fixed field set and a canonical serialization
 *     (fixed key order — the bytes are the contract, not a shared constructor);
 *   - unknown protocols / versions and malformed envelopes default to deny;
 *   - the envelope never carries an identity or token: authorization is decided
 *     by the platform on the transport-verified caller identity (Fase 2A), so
 *     there is nothing here to spoof.
 *
 * Layering (Fase 1A + the capability protocol): the network-light transport
 * already negotiates its own wire version (`p2p-hub:network` v1) and exchanges
 * capability names in the handshake. This module is the *second*, capability
 * level: the payload carried inside a `task` whose skill is
 * `peersite.fetchAsset`. A capability is a discrete, request/response action —
 * not a high-frequency telemetry stream — so the current guard model
 * (payload-size + object-depth + per-asset byte cap) applies; a future
 * streaming/telemetry capability needs its own frequency-cap guard, per the
 * recorded architecture note in plan.md ("Peer Runtime-richtlijn").
 */

import {
  MAX_OBJECT_DEPTH,
  isPlainObject,
  validateObjectDepth,
} from "./boundary-guard";

/** Protocol id of the website capability. Never reuse for another capability. */
export const WEBSITE_PROTOCOL_ID = "p2p-hub:website";

/** Current wire version of the website capability. */
export const WEBSITE_PROTOCOL_VERSION = 1;

/** Upper bound on a requested sub-path (defense before any path handling). */
export const MAX_WEBSITE_PATH_LENGTH = 256;

/**
 * Upper bound on one served asset. Assets are base64-encoded on the wire, so a
 * hard per-asset cap keeps a response deterministic and transport-independent
 * (a 128 KiB asset is ~171 KiB base64 — comfortably inside the 256 KiB frame
 * limit). Oversized assets are rejected with a typed error, never truncated.
 */
export const MAX_WEBSITE_ASSET_BYTES = 128 * 1024;

/** Canonical request: `{ protocol, version, path }`. */
export interface WebsiteRequest {
  protocol: typeof WEBSITE_PROTOCOL_ID;
  version: typeof WEBSITE_PROTOCOL_VERSION;
  path: string;
}

/** Error codes a peer must be able to distinguish. */
export type WebsiteErrorCode =
  | "unsupported-version"
  | "malformed"
  | "unauthorized"
  | "site-not-configured"
  | "not-found"
  | "payload-too-large";

/** Canonical success response: `{ protocol, version, status, contentType, data, name }`. */
export interface WebsiteSuccessResponse {
  protocol: typeof WEBSITE_PROTOCOL_ID;
  version: typeof WEBSITE_PROTOCOL_VERSION;
  status: "ok";
  /** Extension-derived content type, decided by the serving peer. */
  contentType: string;
  /** Base64-encoded file contents. */
  data: string;
  name: string;
}

/** Canonical error response: `{ protocol, version, status, code }`. */
export interface WebsiteErrorResponse {
  protocol: typeof WEBSITE_PROTOCOL_ID;
  version: typeof WEBSITE_PROTOCOL_VERSION;
  status: "error";
  code: WebsiteErrorCode;
}

export type WebsiteResponse = WebsiteSuccessResponse | WebsiteErrorResponse;

const REQUEST_KEYS = ["path", "protocol", "version"];
const OK_KEYS = ["contentType", "data", "name", "protocol", "status", "version"];
const ERROR_KEYS = ["code", "protocol", "status", "version"];

/** Build a canonical version-1 request for a sub-path. */
export function buildWebsiteRequest(path: string): WebsiteRequest {
  return { protocol: WEBSITE_PROTOCOL_ID, version: WEBSITE_PROTOCOL_VERSION, path };
}

/**
 * Parse and validate a website request envelope (a decoded JSON payload from
 * the transport). Default-deny: an unknown protocol or version is
 * `unsupported-version`, any other shape mismatch (missing/extra fields, bad
 * `path` type, empty or over-long path) is `malformed`. The requested `path`
 * itself is deliberately NOT resolved here — containment is the serving peer's
 * job (shared `resolveAndContainFile`), and this function never touches the
 * filesystem.
 */
export function parseWebsiteRequest(
  payload: unknown,
): { ok: true; path: string } | { ok: false; code: WebsiteErrorCode } {
  if (!isPlainObject(payload)) {
    return { ok: false, code: "malformed" };
  }
  const keys = Object.keys(payload);
  if (keys.length !== REQUEST_KEYS.length || !keys.every((k) => REQUEST_KEYS.includes(k))) {
    return { ok: false, code: "malformed" };
  }
  if (payload.protocol !== WEBSITE_PROTOCOL_ID) {
    return { ok: false, code: "unsupported-version" };
  }
  if (payload.version !== WEBSITE_PROTOCOL_VERSION) {
    return { ok: false, code: "unsupported-version" };
  }
  const { path } = payload;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > MAX_WEBSITE_PATH_LENGTH
  ) {
    return { ok: false, code: "malformed" };
  }
  return { ok: true, path };
}

/** Build a canonical success response envelope. */
export function encodeWebsiteSuccess(input: {
  contentType: string;
  data: string;
  name: string;
}): WebsiteSuccessResponse {
  return {
    protocol: WEBSITE_PROTOCOL_ID,
    version: WEBSITE_PROTOCOL_VERSION,
    status: "ok",
    contentType: input.contentType,
    data: input.data,
    name: input.name,
  };
}

/** Build a canonical error response envelope. */
export function encodeWebsiteError(code: WebsiteErrorCode): WebsiteErrorResponse {
  return {
    protocol: WEBSITE_PROTOCOL_ID,
    version: WEBSITE_PROTOCOL_VERSION,
    status: "error",
    code,
  };
}

const ERROR_CODES: ReadonlySet<string> = new Set<WebsiteErrorCode>([
  "unsupported-version",
  "malformed",
  "unauthorized",
  "site-not-configured",
  "not-found",
  "payload-too-large",
]);

/**
 * Parse and validate a website response envelope (decoded by the consuming
 * peer from the remote task result). Returns `null` for any shape mismatch —
 * a non-compliant peer is denied by default. The base64 `data` is returned
 * verbatim; decoding to bytes is the consumer's job.
 */
export function parseWebsiteResponse(payload: unknown): WebsiteResponse | null {
  if (!isPlainObject(payload)) {
    return null;
  }
  const keys = Object.keys(payload);
  if (payload.protocol !== WEBSITE_PROTOCOL_ID) {
    return null;
  }
  if (payload.version !== WEBSITE_PROTOCOL_VERSION) {
    return null;
  }
  if (payload.status === "ok") {
    if (
      keys.length !== OK_KEYS.length ||
      !keys.every((k) => OK_KEYS.includes(k)) ||
      typeof payload.contentType !== "string" ||
      typeof payload.data !== "string" ||
      typeof payload.name !== "string"
    ) {
      return null;
    }
    return {
      protocol: payload.protocol,
      version: payload.version,
      status: "ok",
      contentType: payload.contentType,
      data: payload.data,
      name: payload.name,
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
      code: payload.code as WebsiteErrorCode,
    };
  }
  return null;
}

const REQUEST_KEY_ORDER = ["protocol", "version", "path"];
const OK_KEY_ORDER = ["protocol", "version", "status", "contentType", "data", "name"];
const ERROR_KEY_ORDER = ["protocol", "version", "status", "code"];

/**
 * The canonical byte form of an envelope — the only place a website envelope
 * is serialized to the wire. Fixed key order, and it runs
 * {@link validateObjectDepth} before `JSON.stringify` so a hostile graph can
 * never reach a recursive stringify (CLAUDE.md JSON-depth invariant). Pinned
 * bytes are asserted in tests.
 */
export function serializeWebsiteEnvelope(
  envelope: WebsiteRequest | WebsiteResponse,
): string {
  validateObjectDepth(envelope, MAX_OBJECT_DEPTH);
  const record = envelope as unknown as Record<string, unknown>;
  const order =
    record.status === undefined
      ? REQUEST_KEY_ORDER
      : record.status === "ok"
        ? OK_KEY_ORDER
        : ERROR_KEY_ORDER;
  const canonical: Record<string, unknown> = {};
  for (const key of order) {
    canonical[key] = record[key];
  }
  return JSON.stringify(canonical);
}
