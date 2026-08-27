import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import { resolveAndContainFile } from "@p2p-hub/core";
import {
  PLUGIN_ID_RE,
  UI_PREFIX,
  UI_SECURITY_HEADERS,
  sendEmpty,
  sendFile,
} from "./helpers";

/** Everything the `/ui` routes need from the CoreServer. */
export interface UiContext {
  lanSiteAllowed(): boolean;
  pluginUiRoot(pluginId: string): Promise<string | null>;
  listPlugins(): Array<{ id: string; ui?: { entry?: string } | null }>;
}

/**
 * Attempt to serve a plugin's bundled UI document and assets. Returns `true`
 * (and writes a response) when the request targeted the `/ui` prefix;
 * returns `false` so the caller can continue routing when it did not.
 *
 * Deliberate deviation from the earlier plan note ("boot-token"): `/ui/*` is
 * served WITHOUT the boot token, exactly like `/site/*`. The boot token must
 * never appear in the sandboxed iframe's URL, because the plugin's own UI
 * code can read `location.search` — giving a sandboxed plugin the full
 * `/api/*` token would let it invoke *any* skill directly, defeating the
 * shell bridge's allowlist entirely. `/ui` instead relies on the same
 * controls as `/site`: loopback-only default bind, strict per-request
 * containment, and a hardened CSP. It serves only the plugin's own public
 * UI assets (already on the user's disk), and every capability request must
 * still present the boot token elsewhere.
 */
export async function serveUi(
  ctx: UiContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!ctx.lanSiteAllowed()) {
    return false;
  }
  if (pathname !== UI_PREFIX && !pathname.startsWith(UI_PREFIX + "/")) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendEmpty(res, 405, {});
    return true;
  }

  // `/ui/<pluginId>/<subpath>` — the plugin id is the first segment after
  // the prefix. It is only ever used as a Map key (never joined into a
  // path), and it must still match the manifest id rule so an encoded or
  // traversing segment is refused up front.
  const rest = pathname.slice(UI_PREFIX.length);
  if (!rest.startsWith("/")) {
    sendEmpty(res, 404, {});
    return true;
  }
  const rawSegments = rest.slice(1).split("/");
  const pluginId = rawSegments[0];
  if (typeof pluginId !== "string" || !PLUGIN_ID_RE.test(pluginId)) {
    sendEmpty(res, 404, {});
    return true;
  }

  const uiRoot = await ctx.pluginUiRoot(pluginId);
  if (!uiRoot) {
    sendEmpty(res, 404, {});
    return true;
  }

  let rawSubpath = rawSegments.slice(1).join("/");
  if (rawSubpath.length === 0) {
    // Bare `/ui/<pluginId>/` serves the manifest entry document.
    const manifest = ctx.listPlugins().find((p) => p.id === pluginId);
    const entry = manifest?.ui?.entry;
    if (typeof entry !== "string") {
      sendEmpty(res, 404, {});
      return true;
    }
    rawSubpath = path.basename(entry);
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

  // Containment (dot-segments, dotfiles, symlinks, escapes) is decided once,
  // in the shared helper — identical to the P2P fetchAsset and /site paths.
  const resolved = resolveAndContainFile(uiRoot, decoded);
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

  sendFile(res, req.method === "HEAD", contents, resolved, UI_SECURITY_HEADERS);
  return true;
}
