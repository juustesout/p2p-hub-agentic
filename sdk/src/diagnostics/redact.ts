/**
 * Display-time redaction filter for diagnostics output.
 *
 * Privacy-first invariant (CLAUDE.md / helpcenter-plan): in a P2P tool *who you
 * talk to* is already sensitive data, so redaction is mandatory **before**
 * display, not optional at send time. Every surface that shows, exports or
 * forwards logs must run its output through this filter — the viewer, the
 * export path and the webview feed use the *same* shared code so the masking
 * can never diverge between surfaces.
 *
 * The filter masks:
 * - 64-hex peerIds (also catches the 64-hex boot token, which shares the same
 *   shape — indistinguishable structurally, and both must disappear anyway);
 * - IPv4 / IPv6 / MAC-like addresses;
 * - well-known secret/token prefixes (sk-, glpat-, JWT `eyJ…`);
 * - sensitive values reached through named keys in structured objects
 *   (`peerId`, `apiKey`, `masterKey`, `authorization`, …).
 *
 * Deliberately ReDoS-safe: every pattern is bounded with no nested quantifiers
 * (same discipline as the sanitizer). Redaction is best-effort by nature — a
 * value we do not recognise can slip through, which is exactly why the plan
 * keeps a human-visible preview as the last gate before anything leaves the
 * machine.
 */

/** Masked form for a peerId, keeping a short hint either side of the gap. */
export function maskPeerId(peerId: string): string {
  if (peerId.length <= 12) {
    return `peer_${peerId.slice(0, 4)}…`;
  }
  return `peer_${peerId.slice(0, 4)}…${peerId.slice(-4)}`;
}

/** Masked form for an IPv4 / IPv6 / MAC-like address (zero leak). */
export function maskIp(address: string): string {
  return address.includes(":") ? "[ipv6]" : "[ip]";
}

/** True when `s` looks like a 64-hex peerId (the repo's identity shape). */
export function isPeerId(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/**
 * Mask a single named value in structured output. Secret-bearing keys are
 * replaced wholesale (`[redacted:<key>]`); `peerId`-shaped values get the
 * partial peerId mask so the reader can still correlate log lines.
 */
export function redactNamedValue(key: string, value: unknown): unknown {
  const normalized = key.toLowerCase();
  if (normalized.includes("peerid") || normalized.includes("peer_id")) {
    if (typeof value === "string" && isPeerId(value)) {
      return maskPeerId(value);
    }
    return `[redacted:${key}]`;
  }
  if (SENSITIVE_KEY_RE.test(normalized)) {
    return `[redacted:${key}]`;
  }
  return value;
}

/**
 * Keys whose values must never be echoed to the user. Matched on the
 * lowercased key name, anchored to the *end* of the key so a namespaced key
 * like `vault.masterKey` or `ai.apiKey` is still caught.
 */
const SENSITIVE_KEY_RE =
  /(?:^|\.|_)(apikey|api_key|authorization|auth|token|boottoken|boot_token|accesstoken|access_token|refreshtoken|refresh_token|secret|masterkey|master_key|password|passphrase|privatekey|private_key|cookie|sessionid|session_id)$/;

const SENSITIVE_DEPTH_MAX = 10;

/**
 * Deep-copy `input`, replacing every sensitive named value with its masked
 * form and every `peerId`-shaped value with the partial mask. Depth-capped so
 * a hostile nested object cannot overflow the stack (mirrors
 * `validateObjectDepth` discipline).
 */
export function redactStructured(
  input: unknown,
  depth = 0,
): unknown {
  if (depth > SENSITIVE_DEPTH_MAX) {
    return "[depth-limit]";
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactStructured(item, depth + 1));
  }
  if (isPlainObjectLike(input)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      out[key] = redactNamedValue(key, redactStructured(value, depth + 1));
    }
    return out;
  }
  return input;
}

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A 64-hex peerId / boot token. */
const PEER_HEX_RE = /\b[0-9a-f]{64}\b/g;

/** IPv4 dotted quad. */
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/**
 * IPv6 (incl. `::`-compression) / MAC-like colon-hex groups. Two bounded
 * branches with no nested quantifiers: the `::`-free branch needs ≥4 groups
 * (so times like `12:34:56` are untouched), the compressed branch allows an
 * empty left/right side. All colon-hex shapes are treated as addresses.
 */
const IPV6_OR_MAC_RE =
  /\b(?:(?:[0-9a-f]{1,4}:){3,}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,3})?::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,3})\b/gi;

/** Well-known secret/token prefixes (sk-, glpat-, JWT). */
const TOKEN_PREFIX_RE =
  /\b(?:sk-[a-zA-Z0-9_-]{8,}|glpat-[a-zA-Z0-9_-]{8,}|xox[baprs]-[a-zA-Z0-9-]{8,}|gh[pousr]_[a-zA-Z0-9]{16,}|eyJ[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]{4,})\b/g;

/**
 * Redact one text line/record for display. Masks peerIds/tokens, IPv4 and
 * IPv6/MAC addresses. `keepPartial` controls the peerId form: the default
 * keeps `peer_9f2a…a1c0` hints; `false` replaces the whole value with
 * `[peerId]` (e.g. for the "ongeredacteerd" power-user export, which still
 * never prints a full identity).
 */
export function redact(text: string, options: { keepPartial?: boolean } = {}): string {
  const keepPartial = options.keepPartial ?? true;
  let out = text
    .replace(IPV6_OR_MAC_RE, (m) => maskIp(m))
    .replace(IPV4_RE, (m) => maskIp(m))
    .replace(TOKEN_PREFIX_RE, "[redacted:token]");
  if (keepPartial) {
    out = out.replace(PEER_HEX_RE, (m) => maskPeerId(m));
  } else {
    out = out.replace(PEER_HEX_RE, "[peerId]");
  }
  return out;
}

/**
 * Redact a full (possibly multi-line) log export. Lines are split and
 * redacted independently so one hostile multi-line value cannot span masks.
 */
export function redactLines(text: string, options?: { keepPartial?: boolean }): string {
  return text
    .split("\n")
    .map((line) => redact(line, options))
    .join("\n");
}
