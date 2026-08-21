import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MAX_WEBSITE_ASSET_BYTES } from "@p2p-hub/sdk";
import type { WebsiteErrorCode } from "@p2p-hub/sdk";
import { atomicWriteFile } from "../storage/atomic-write";

/**
 * The consuming side of the `p2p-hub:website:v1` capability: peer B mirrors
 * asset bytes it fetched over P2P from peer A into a local directory, so the
 * site can be rendered in the existing sandboxed iframe without A ever running
 * a public HTTP server.
 *
 * Security model (CLAUDE.md principles #2, #3, #9):
 *   - the mirror root is `<dataDir>/sites/<peerId>` — `peerId` is validated as
 *     hex before the route ever builds a path, so the root is contained by
 *     construction and is B's own data, never A's;
 *   - the *requested* sub-path (the only thing that builds a destination) is
 *     re-validated segment-by-segment (dot-segments, dotfiles, backslashes,
 *     NUL) and anchored inside the mirror root — the remote peer never controls
 *     a filename (its `name` field is ignored; B keeps its own requested path);
 *   - decoded bytes are capped at {@link MAX_WEBSITE_ASSET_BYTES} on the
 *     consuming side too, so a peer cannot write an oversized file;
 *   - writes go through the shared atomic write (temp → fsync → rename), never
 *     a bare `fs.writeFile` over the target (principle #9).
 *
 * This module is deliberately HTTP-free: the core-server route and the testlab
 * both drive it with a fetcher callback, so the containment + atomicity rules
 * are exercised exactly once for every surface.
 */

/** Result of an outbound `p2p-hub:website:v1` asset request. */
export type SiteAssetFetcher = (
  peerId: string,
  path: string,
) => Promise<
  | { ok: true; contentType: string; data: string; name: string }
  | { ok: false; code: WebsiteErrorCode }
>;

/**
 * Resolve a decoded sub-path to the absolute file it will occupy inside the
 * mirror root, or `null` when the request must be denied. This is the *write
 * side* of the containment: it applies the same segment rules as the shared
 * serve-side `resolveAndContainFile` (dot-segments/dotfiles/backslashes/NUL
 * default-denied, trailing-separator-anchored containment) but does not
 * require the file to exist yet.
 */
export function mirrorDestination(
  mirrorRoot: string,
  requestedPath: string,
): string | null {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    return null;
  }
  const segments = requestedPath.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    return null;
  }
  for (const segment of segments) {
    if (
      segment.startsWith(".") ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      return null;
    }
  }

  const root = path.resolve(mirrorRoot);
  const candidate = path.resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    return null;
  }
  return candidate;
}

/**
 * Fetch one asset over P2P and store it in the mirror. Returns the stored
 * absolute path, or `null` when the request was denied (bad path, fetch error,
 * non-compliant response, or an oversized payload). The destination is derived
 * only from the requested path — the peer's `name`/`contentType` fields never
 * influence B's filenames.
 */
export async function mirrorFetchAndStore(opts: {
  fetcher: SiteAssetFetcher;
  mirrorRoot: string;
  peerId: string;
  path: string;
  maxAssetBytes?: number;
}): Promise<string | null> {
  const { fetcher, mirrorRoot, peerId, path: requestedPath } = opts;
  const maxBytes = opts.maxAssetBytes ?? MAX_WEBSITE_ASSET_BYTES;

  const dest = mirrorDestination(mirrorRoot, requestedPath);
  if (!dest) {
    return null;
  }

  const result = await fetcher(peerId, requestedPath);
  if (!result.ok) {
    return null;
  }

  const bytes = Buffer.from(result.data, "base64");
  if (bytes.length > maxBytes) {
    return null;
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  await atomicWriteFile(dest, bytes);
  return dest;
}
