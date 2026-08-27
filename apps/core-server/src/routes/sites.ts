import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import {
  TrustConfirmationDeniedError,
  mirrorDestination,
  mirrorFetchAndStore,
  resolveAndContainFile,
} from "@p2p-hub/core";
import {
  buildWebsiteRequest,
  parseWebsiteResponse,
  sanitizeText,
  validateTextLength,
} from "@p2p-hub/sdk";
import type { TaskResult, WebsiteErrorCode } from "@p2p-hub/sdk";
import {
  IDENTIFIER_RE,
  PEER_ID_RE,
  PEERSITE_MESSAGE_MAX_LENGTH,
  PEERSITE_PREFIX,
  REMOTE_SITE_PREFIX,
  SITE_PREFIX,
  SITE_SECURITY_HEADERS,
  UI_SECURITY_HEADERS,
  readJsonBody,
  sendEmpty,
  sendFile,
  sendJson,
} from "./helpers";

/** Everything the `/site`, `/remote-site` and `/peersite` routes need. */
export interface SitesContext {
  lanSiteAllowed(): boolean;
  dataDir: string;
  peerId(): string;
  listPlugins(): Array<unknown>;
  effectiveSiteRoot(): Promise<string | null>;
  siteAuthorized(req: http.IncomingMessage): boolean;
  allowMessage(remoteAddress: string): boolean;
  broadcast(event: string, payload: unknown): void;
  executeRemote(
    peerId: string,
    skill: string,
    id: string,
    args: unknown,
  ): Promise<TaskResult>;
  invokeSkill(input: {
    id: string;
    skill: string;
    payload: unknown;
  }): Promise<TaskResult>;
  authorizeTier2(summary: string): Promise<void>;
}

/**
 * Attempt to serve a request from the configured site root. Returns `true`
 * (and writes a response) when the request targeted the `/site` prefix;
 * returns `false` so the caller can continue routing when it did not.
 *
 * Hardening: raw `..`/`%2e`/`%00` segments are rejected before decoding, the
 * decoded sub-path is re-checked segment-by-segment (dot-segments, dotfiles,
 * backslashes, null bytes), and the final file is resolved with `realpath`
 * and required to stay under the real site root (blocks symlink escapes).
 * Every reject is a 404 — never 403 — to avoid leaking directory structure.
 */
export async function serveSite(
  ctx: SitesContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const root = await ctx.effectiveSiteRoot();
  if (!root) {
    return false;
  }
  if (pathname !== SITE_PREFIX && !pathname.startsWith(SITE_PREFIX + "/")) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendEmpty(res, 405, {});
    return true;
  }

  const rawSubpath = pathname.slice(SITE_PREFIX.length);
  if (
    /%2e/i.test(rawSubpath) ||
    /%00/i.test(rawSubpath) ||
    rawSubpath.includes("..") ||
    rawSubpath.includes("\0")
  ) {
    sendEmpty(res, 404, {});
    return true;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSubpath);
  } catch {
    sendEmpty(res, 404, {});
    return true;
  }

  // Containment (dot-segments, dotfiles, symlinks, data-dir escapes) is
  // decided once, in the shared helper — identical to the P2P fetchAsset path.
  const resolved = resolveAndContainFile(root, decoded);
  if (!resolved) {
    sendEmpty(res, 404, {});
    return true;
  }

  let contents: Buffer;
  try {
    contents = await fsp.readFile(resolved);
  } catch {
    sendEmpty(res, 404, {});
    return true;
  }

  sendFile(res, req.method === "HEAD", contents, resolved, SITE_SECURITY_HEADERS);
  return true;
}

/**
 * Attempt to handle a scoped PeerSite API request. Returns `true` when the
 * request targeted `/peersite` and was answered; `false` otherwise. The API
 * is only active when the site is enabled (the peersite plugin has a
 * configured root). The scoped site credential is the *only* thing that can
 * authenticate `/peersite/*` — the boot token never applies here, and the
 * site credential never applies to `/api/*` or `/ws`.
 */
export async function servePeersite(
  ctx: SitesContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!(await ctx.effectiveSiteRoot())) {
    return false;
  }
  if (
    pathname !== PEERSITE_PREFIX &&
    !pathname.startsWith(PEERSITE_PREFIX + "/")
  ) {
    return false;
  }

  if (req.method === "GET" && pathname === "/peersite/status") {
    sendJson(res, 200, {
      online: true,
      peerName: ctx.peerId(),
      activePluginsCount: ctx.listPlugins().length,
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/peersite/message") {
    if (!ctx.siteAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const remote = req.socket.remoteAddress ?? "unknown";
    if (!ctx.allowMessage(remote)) {
      sendJson(res, 429, { error: "rate limit exceeded" });
      return true;
    }
    const body = (await readJsonBody(req)) as { message?: unknown };
    if (typeof body.message !== "string") {
      sendJson(res, 400, {
        ok: false,
        error: "message expects { message: string }",
      });
      return true;
    }
    validateTextLength(body.message, PEERSITE_MESSAGE_MAX_LENGTH);
    const clean = sanitizeText(body.message);
    ctx.broadcast("peersite:message", { message: clean, ts: Date.now() });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && pathname === "/peersite/execute-skill") {
    if (!ctx.siteAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const body = (await readJsonBody(req)) as {
      serviceId?: unknown;
      method?: unknown;
      arguments?: unknown;
    };
    const { serviceId, method } = body;
    if (
      typeof serviceId !== "string" ||
      typeof method !== "string" ||
      !IDENTIFIER_RE.test(serviceId) ||
      !IDENTIFIER_RE.test(method)
    ) {
      sendJson(res, 400, {
        ok: false,
        error: "execute-skill expects safe serviceId and method identifiers",
      });
      return true;
    }
    try {
      await ctx.authorizeTier2(`Execute skill ${serviceId}.${method} from PeerSite`);
    } catch (err) {
      if (err instanceof TrustConfirmationDeniedError) {
        sendJson(res, 403, {
          ok: false,
          error: "confirmation required",
          requiredTier: err.requiredTier,
        });
        return true;
      }
      throw err;
    }
    const id = randomUUID();
    const result = await ctx.invokeSkill({
      id,
      skill: `${serviceId}.${method}`,
      payload: body.arguments,
    });
    sendJson(res, 200, result);
    return true;
  }

  return false;
}

/**
 * Attempt to serve a mirrored remote P2P site. Returns `true` (and writes a
 * response) when the request targeted the `/remote-site` prefix.
 *
 * This is the render side of the Fase-2 end criterion: peer B renders peer
 * A's `p2p-hub:website:v1` capability inside the same sandboxed-iframe model
 * as `/ui`. A never runs a public HTTP server — B fetches assets over the
 * P2P protocol on request and stores them in `<dataDir>/sites/<peerId>`.
 *
 * Hardening mirrors `/ui` (CLAUDE.md principle #10): served WITHOUT the boot
 * token (the iframe is untrusted remote content and must never hold a token
 * in its URL), loopback-gated, GET/HEAD-only, strict per-request containment
 * (shared {@link mirrorDestination} on the write side, {@link resolveAndContainFile}
 * semantics on the serve side), and the hardened UI CSP with `connect-src
 * 'none'`. The peerId is validated as hex before it ever builds a path, so
 * the mirror root is contained by construction. Every failure is a quiet 404.
 */
export async function serveRemoteSite(
  ctx: SitesContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!ctx.lanSiteAllowed()) {
    return false;
  }
  if (
    pathname !== REMOTE_SITE_PREFIX &&
    !pathname.startsWith(REMOTE_SITE_PREFIX + "/")
  ) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendEmpty(res, 405, {});
    return true;
  }

  const rest = pathname.slice(REMOTE_SITE_PREFIX.length);
  if (!rest.startsWith("/")) {
    sendEmpty(res, 404, {});
    return true;
  }
  const rawSegments = rest.slice(1).split("/");
  const peerId = rawSegments[0];
  // The peerId is a directory name AND the remote task target. It must be a
  // valid 64-hex identity before it is used for either.
  if (typeof peerId !== "string" || !PEER_ID_RE.test(peerId)) {
    sendEmpty(res, 404, {});
    return true;
  }

  let rawSubpath = rawSegments.slice(1).join("/");
  if (rawSubpath.length === 0) {
    rawSubpath = "index.html";
  }

  if (
    /%2e/i.test(rawSubpath) ||
    /%00/i.test(rawSubpath) ||
    rawSubpath.includes("..") ||
    rawSubpath.includes("\0")
  ) {
    sendEmpty(res, 404, {});
    return true;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSubpath);
  } catch {
    sendEmpty(res, 404, {});
    return true;
  }
  // A directory URL (`/remote-site/<peerId>/sub/`) maps to its index, exactly
  // as the origin peer's `resolveAndContainFile` would resolve it.
  if (decoded.endsWith("/")) {
    decoded += "index.html";
  }

  const mirrorRoot = path.join(ctx.dataDir, "sites", peerId);
  const destination = mirrorDestination(mirrorRoot, decoded);
  if (!destination) {
    sendEmpty(res, 404, {});
    return true;
  }

  let contents: Buffer;
  try {
    contents = await fsp.readFile(destination);
  } catch {
    // Miss: fetch the asset from the remote peer over P2P, then serve it.
    const stored = await mirrorFetchAndStore({
      fetcher: (pid, p) => fetchRemoteSiteAsset(ctx, pid, p),
      mirrorRoot,
      peerId,
      path: decoded,
    });
    if (!stored) {
      sendEmpty(res, 404, {});
      return true;
    }
    try {
      contents = await fsp.readFile(stored);
    } catch {
      sendEmpty(res, 404, {});
      return true;
    }
  }

  sendFile(res, req.method === "HEAD", contents, destination, UI_SECURITY_HEADERS);
  return true;
}

/**
 * Outbound `p2p-hub:website:v1` asset request to a remote peer, wired to the
 * platform's own network transport. Authorization is entirely the remote
 * peer's platform decision (its broker gate on the transport-verified caller
 * identity) — this side only formats the versioned envelope and validates the
 * response. Every failure is mapped to a typed error code, never leaked.
 */
async function fetchRemoteSiteAsset(
  ctx: SitesContext,
  peerId: string,
  assetPath: string,
): Promise<
  | { ok: true; contentType: string; data: string; name: string }
  | { ok: false; code: WebsiteErrorCode }
> {
  const result = await ctx.executeRemote(
    peerId,
    "peersite.fetchAsset",
    randomUUID(),
    buildWebsiteRequest(assetPath),
  );
  if (result.status !== "ok" || !result.result) {
    return { ok: false, code: "not-found" };
  }
  const parsed = parseWebsiteResponse(result.result);
  if (!parsed) {
    return { ok: false, code: "malformed" };
  }
  if (parsed.status === "error") {
    return { ok: false, code: parsed.code };
  }
  return {
    ok: true,
    contentType: parsed.contentType,
    data: parsed.data,
    name: parsed.name,
  };
}
