import * as http from "node:http";
import { contentTypeForPath } from "@p2p-hub/core";
import {
  MAX_PAYLOAD_BYTES,
  ObjectDepthExceededError,
  PayloadTooLargeError,
  validateJsonNestingDepth,
  validateObjectDepth,
  validatePayloadSize,
} from "@p2p-hub/sdk";
import { safeTokenEqual, tokenFromAuthorization, tokenFromQuery } from "../auth";

/** URL prefix under which the static site is served. */
export const SITE_PREFIX = "/site";

/** URL prefix under which plugin UI assets are served. */
export const UI_PREFIX = "/ui";

/**
 * URL prefix under which a *remote peer's* mirrored P2P website is served:
 * `/remote-site/<peerId>/*`.
 */
export const REMOTE_SITE_PREFIX = "/remote-site";

/** URL prefix under which the scoped PeerSite API is served. */
export const PEERSITE_PREFIX = "/peersite";

/** Safe identifier for a skill's `<serviceId>` / `<method>` segments. */
export const IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Safe identifier for a peer reference (per-boot instance id or persistent peerId). */
export const PEER_ID_RE = /^[a-zA-Z0-9-]{1,128}$/;

/** Safe identifier for a plugin id (matches the manifest `id` rule). */
export const PLUGIN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Max characters accepted in a `/peersite/message` body. */
export const PEERSITE_MESSAGE_MAX_LENGTH = 10_000;

/** Per-source-IP message rate limit (fixed window). */
export const MESSAGE_RATE_LIMIT = 30;
export const MESSAGE_RATE_WINDOW_MS = 60_000;

/**
 * Per-minute cap on the number of *cache-miss* outbound peer fetches that
 * `/remote-site/*` may trigger. A miss is an authenticated fetch the node
 * performs on behalf of whoever requested the URL — an action, not just a
 * read — so even a legitimate-but-abused caller must not be able to use the
 * node's trusted peer relationships as an unbounded proxy. Mirrored assets are
 * served from disk after the first fetch, so normal browsing is unaffected.
 */
export const REMOTE_SITE_FETCH_RATE_LIMIT = 30;
export const REMOTE_SITE_FETCH_RATE_WINDOW_MS = 60_000;

/** Security headers applied to every served static asset. */
export const SITE_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;",
};

/**
 * Security headers applied to every `/ui/<pluginId>` response. Stricter than
 * the site headers: the plugin UI runs in a sandboxed iframe and must make no
 * network calls of its own — every capability goes through the shell bridge
 * (postMessage, which CSP does not govern) — so `connect-src 'none'` blocks
 * fetch/XHR/WebSocket outright. `'self'` here means the core-server origin,
 * which is what the iframe document is served from.
 */
export const UI_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; worker-src 'self'; connect-src 'none'; " +
    "base-uri 'none'; form-action 'none'; object-src 'none'",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

/**
 * Hook events bridged to the WebSocket activity bus by default. The Slice 2
 * additions drive the desktop shell's OS notifications: task delegations and
 * incoming chat (`tasks:taskUpdated`, `chat:messageReceived` — sanitized by the
 * shell before anything reaches the OS) and the vault/network lifecycle
 * (`vault:unlocked`, `vault:locked`, `network:paused`, `network:resumed`).
 */
export const DEFAULT_BRIDGED_EVENTS = [
  "core:ready",
  "calendar:eventAdded",
  "vault:unlocked",
  "vault:locked",
  "network:paused",
  "network:resumed",
  "tasks:taskUpdated",
  "chat:messageReceived",
];

/** Write a JSON response. */
export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Send an empty response with the given headers. */
export function sendEmpty(
  res: http.ServerResponse,
  status: number,
  headers: http.OutgoingHttpHeaders,
): void {
  res.writeHead(status, headers);
  res.end();
}

/** Send a file body (or HEAD-only headers) with the given base headers. */
export function sendFile(
  res: http.ServerResponse,
  headOnly: boolean,
  contents: Buffer,
  filePath: string,
  headers: Record<string, string>,
): void {
  const contentType = contentTypeForPath(filePath);
  res.writeHead(200, {
    ...headers,
    "Content-Type": contentType,
    "Content-Length": contents.length,
  });
  res.end(headOnly ? undefined : contents);
}

/**
 * Read and parse a JSON request body. Throws {@link PayloadTooLargeError}
 * (→ 413), or `SyntaxError`/{@link ObjectDepthExceededError} (→ 400); the
 * dispatcher maps those to typed responses. An empty body parses as `{}`.
 */
export async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buf.length;
    if (received > MAX_PAYLOAD_BYTES) {
      throw new PayloadTooLargeError(received, MAX_PAYLOAD_BYTES);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  validatePayloadSize(raw, MAX_PAYLOAD_BYTES);
  validateJsonNestingDepth(raw);
  const parsed: unknown = JSON.parse(raw);
  validateObjectDepth(parsed);
  return parsed;
}

/** Authorize via the `Authorization: Bearer` header only. */
export function bearerMatches(
  req: http.IncomingMessage,
  token: string,
): boolean {
  return safeTokenEqual(tokenFromAuthorization(req.headers.authorization), token);
}

/** Authorize via the header OR the `?token=` query string (WebSocket only). */
export function bearerOrQueryMatches(
  req: http.IncomingMessage,
  token: string,
): boolean {
  return (
    safeTokenEqual(tokenFromAuthorization(req.headers.authorization), token) ||
    safeTokenEqual(tokenFromQuery(req), token)
  );
}
