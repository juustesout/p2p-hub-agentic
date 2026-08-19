import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as http from "node:http";

/**
 * Boot-token authentication for the core-server's HTTP/WebSocket bridge.
 *
 * The bridge listens on 127.0.0.1, but that alone is not enough: a hostile
 * page in the user's browser can still reach it through DNS rebinding or a
 * same-origin `fetch`. Every `/api/*` request and every `/ws` upgrade must
 * present a per-boot token. The token is written to a `0600` file inside the
 * data directory so only the desktop shell (running as the same user) can read
 * it; the browser never receives the raw secret via any `/api` route.
 */

export const TOKEN_FILE_NAME = "boot-token";

export function bootTokenFile(dataDir: string): string {
  return path.join(dataDir, TOKEN_FILE_NAME);
}

/**
 * Persist the boot token to `<dataDir>/boot-token` with owner-only (0600)
 * permissions, so the desktop shell can read it out-of-band.
 *
 * The file is opened with `0o600` so a *new* file is created atomically with
 * the right permissions (no window where it is world-readable), and the open
 * descriptor is then `fchmod`'d to `0600` before any bytes are written — which
 * also normalises a file that survived from an earlier boot with looser
 * permissions. Either way, the secret never sits on disk readable by others.
 */
export function writeBootToken(dataDir: string, token: string): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = bootTokenFile(dataDir);
  const fd = fs.openSync(file, "w", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, `${token}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

/** Extract a bearer token from an `Authorization` header, if present. */
export function tokenFromAuthorization(header: string | undefined): string | null {
  if (typeof header !== "string") {
    return null;
  }
  if (!header.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/** Extract a token from the `?token=` query string (used by WebSocket). */
export function tokenFromQuery(req: { url?: string } | http.IncomingMessage): string | null {
  const query = (req.url ?? "").split("?")[1];
  if (!query) {
    return null;
  }
  return new URLSearchParams(query).get("token");
}

/**
 * Constant-time comparison against the expected token.
 *
 * Both inputs are first reduced to a fixed-size SHA-256 digest and the digests
 * compared with `crypto.timingSafeEqual`. This avoids the length short-circuit
 * a direct `timingSafeEqual` would require (it throws on unequal-length
 * buffers), so no branch reveals anything about the candidate's length or
 * content. The one unavoidable early return is a *type* check — a non-string
 * (null/undefined) can't be hashed and is never a valid credential.
 */
export function safeTokenEqual(candidate: string | null, expected: string): boolean {
  if (typeof candidate !== "string") {
    return false;
  }
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Generate a fresh random boot token. */
export function generateBootToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Generate a fresh, in-memory scoped site credential. Unlike the boot token it
 * is never written to disk, and it only ever authorizes `/peersite/*` routes —
 * it must never be accepted by the boot-token check that guards `/api/*` and
 * `/ws`. Keeping it in-memory means it dies with the process (per-boot).
 */
export function generateSiteToken(): string {
  return randomBytes(32).toString("hex");
}
