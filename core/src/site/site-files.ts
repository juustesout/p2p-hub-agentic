import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Shared site-file resolution and containment for PeerSite. Both the local
 * HTTP handler (`apps/core-server`) and the P2P `peersite.fetchAsset` skill use
 * these two functions, so "which files are accepted/rejected" is decided in
 * exactly one place — the two surfaces cannot drift apart.
 *
 * Security model (see CLAUDE.md principles #2 and #3):
 *   - the site root is always canonicalized to a `realpath` before it is used;
 *   - every requested path is resolved to a `realpath` and must stay inside the
 *     canonical root (a trailing `path.sep` anchors the prefix check, so
 *     `/data/site` does not match `/data/site-evil`);
 *   - dot-segments and dotfiles (anything starting with `.`), backslashes and
 *     NUL bytes are default-denied before they ever touch the filesystem.
 */

/** Extension-only MIME table; the type is never taken from the client. */
const SITE_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const SITE_DEFAULT_MIME = "application/octet-stream";

/** Extension-only content type; never trusts a user-provided type. */
export function contentTypeForPath(filePath: string): string {
  const lower = path.extname(filePath).toLowerCase();
  return SITE_MIME_TYPES[lower] ?? SITE_DEFAULT_MIME;
}

/**
 * Validate a configured site root at configuration time and return its
 * canonical realpath. This is the *loud* boundary: a bad root (missing,
 * unresolvable, or equal to / inside the agent data directory) throws, because
 * the caller explicitly asked for a specific directory and should hear about
 * it immediately rather than silently serving nothing.
 */
export function validateSiteRoot(siteRoot: string, dataDir: string): string {
  if (typeof siteRoot !== "string" || siteRoot.length === 0) {
    throw new Error("PeerSite siteRoot must be a non-empty string");
  }

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(path.resolve(siteRoot));
  } catch {
    throw new Error(
      `PeerSite siteRoot "${siteRoot}" does not exist or cannot be resolved`,
    );
  }

  // The data directory may not exist yet (fresh install); fall back to a
  // lexical resolve so the containment check still holds structurally.
  let dataReal: string;
  try {
    dataReal = fs.realpathSync(dataDir);
  } catch {
    dataReal = path.resolve(dataDir);
  }

  if (rootReal === dataReal || rootReal.startsWith(dataReal + path.sep)) {
    throw new Error(
      "PeerSite siteRoot must not be the agent data directory or a path inside it",
    );
  }

  return rootReal;
}

/**
 * Resolve a decoded sub-path against a validated site root and return the
 * canonical absolute path of the file to serve, or `null` when the request is
 * denied. This is the *quiet* per-request boundary: every rejection is `null`
 * (which callers map to 404), never an error that leaks directory structure.
 *
 * `requestedPath` is the *already percent-decoded* sub-path, e.g. `"index.html"`
 * or `"a/b/c.css"`. Directory requests resolve to their `index.html`.
 */
export function resolveAndContainFile(
  siteRoot: string,
  requestedPath: string,
): string | null {
  if (typeof requestedPath !== "string") {
    return null;
  }

  let root: string;
  try {
    root = fs.realpathSync(siteRoot);
  } catch {
    return null;
  }

  const segments = requestedPath.split("/").filter((s) => s.length > 0);
  for (const segment of segments) {
    // Dot-segments (`.`, `..`) and dotfiles (`.env`, `.git`) all begin with a
    // dot and are default-denied. Backslashes and NUL bytes are never valid in
    // a served path.
    if (
      segment.startsWith(".") ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      return null;
    }
  }

  let candidate: string;
  try {
    candidate = fs.realpathSync(path.join(root, ...segments));
  } catch {
    return null;
  }
  // Anchor the containment check on the trailing separator (CLAUDE.md #2).
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    return null;
  }

  if (stat.isDirectory()) {
    let index: string;
    try {
      index = fs.realpathSync(path.join(candidate, "index.html"));
    } catch {
      return null;
    }
    if (index !== root && !index.startsWith(root + path.sep)) {
      return null;
    }
    return index;
  }

  return candidate;
}
