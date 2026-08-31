/**
 * CORS for the loopback bridge.
 *
 * The Tauri webview origin (e.g. `http://tauri.localhost` on Windows,
 * `tauri://localhost` on Linux/macOS) is *cross-origin* to the core-server's
 * loopback address (`http://127.0.0.1:<port>`), so `/api/*` fetches from the
 * desktop shell would be blocked by the browser's same-origin policy unless
 * the server explicitly grants them. Plain-browser dev never needed this —
 * the Vite proxy made every request same-origin.
 *
 * This grant is deliberately narrow:
 *
 * - Only `/api/*` is covered (wired in `handleHttp`), never the tokenless
 *   `/site`, `/ui`, `/remote-site` or `/peersite` surfaces. Those are loaded
 *   as iframes (no CORS involved) and must not gain a fetch-read surface for
 *   arbitrary websites.
 * - The `Origin` header is echoed back only when its host is a known shell
 *   origin (loopback, `localhost`, `tauri.localhost` or the `tauri:` scheme).
 *   Any other origin gets no CORS headers at all, so a hostile page can never
 *   read bridge responses — it cannot set the `Authorization` header either
 *   (the preflight for it would be refused), so the boot token stays the
 *   binding control on `/api/*`.
 * - Preflights (OPTIONS) carry no token, so they must be answered before the
 *   token gate runs — see the ordering note in `handleHttp`.
 */

/** Parse the `Origin` header value and re-allow it, or `null` (deny). */
export function corsAllowOrigin(origin: string | undefined): string | null {
  if (!origin) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  const host = url.hostname.toLowerCase();
  // `tauri://localhost` (Linux/macOS custom-protocol origin).
  if (scheme === "tauri" && host === "localhost") {
    return origin;
  }
  if (scheme !== "http" && scheme !== "https") {
    return null;
  }
  if (host === "tauri.localhost" || host === "localhost") {
    return origin;
  }
  if (host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return origin;
  }
  return null;
}

/** CORS headers for a successful preflight, if the origin is allowed. */
export function corsPreflightHeaders(
  origin: string | undefined,
): Record<string, string> | null {
  const allowed = corsAllowOrigin(origin);
  if (!allowed) {
    return null;
  }
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "3600",
    Vary: "Origin",
  };
}

/** The per-response CORS header for an actual (non-preflight) request. */
export function corsResponseHeaders(
  origin: string | undefined,
): Record<string, string> | null {
  const allowed = corsAllowOrigin(origin);
  if (!allowed) {
    return null;
  }
  return { "Access-Control-Allow-Origin": allowed, Vary: "Origin" };
}
