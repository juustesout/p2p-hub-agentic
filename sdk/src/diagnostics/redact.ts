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
 *   (`peerId`, `apiKey`, `masterKey`, `authorization`, …);
 * - a high-entropy fallback for secrets whose *format* is not on the prefix
 *   list (a third-party plugin's custom API key, a raw hex private key, …).
 *
 * The fallback exists because a pattern list can never be complete: the cost
 * asymmetry favours masking — a false positive only makes a log slightly less
 * readable, a missed real secret leaks a credential. Two bounded gates:
 * - a pure-hex token of {@link HIGH_ENTROPY_HEX_MIN_LENGTH}+ characters in any
 *   case (a raw Ed25519 seed/private key is 64 hex chars and does not need a
 *   letter/digit mix to be a secret), and
 * - a letter/digit token of {@link HIGH_ENTROPY_MIXED_MIN_LENGTH}+ characters
 *   spanning at least two of {lower, upper, digit} with enough distinct
 *   characters (base64-ish and slug-style secrets).
 * Ordinary prose survives: single-class words (long Dutch compounds included)
 * and hyphenated correlation ids such as UUIDs break on the separator into
 * short segments and are left readable, which keeps bundles diagnostically
 * useful. Deliberately ReDoS-safe: every pattern is bounded with no nested
 * quantifiers (same discipline as the sanitizer). Redaction is best-effort by
 * nature — a value we do not recognise can slip through, which is exactly why
 * the plan keeps a human-visible preview as the last gate before anything
 * leaves the machine.
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
      const normalized = key.toLowerCase();
      const maskedByKey =
        normalized.includes("peerid") ||
        normalized.includes("peer_id") ||
        SENSITIVE_KEY_RE.test(normalized);
      if (maskedByKey) {
        // Decide on the *original* value so a peerId-shaped string still gets
        // its `peer_….` hint; the named-key verdict then replaces wholesale.
        out[key] = redactNamedValue(key, value);
      } else {
        // Benign key: recurse (nested objects repeat this logic) and let the
        // entropy fallback keep a secret under a neutral key out of the raw
        // view — the same policy as free text.
        out[key] = redactStructured(value, depth + 1);
      }
    }
    return out;
  }
  if (typeof input === "string") {
    // Named-key rules above handle the *key*; the entropy fallback keeps a
    // secret stored under a benign key (or embedded in a free scalar) from
    // showing up raw in the structured view — same policy as free text.
    return redactHighEntropy(input);
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
 * A pure-hex run of this many characters or more is treated as a secret in any
 * case mixture: a raw Ed25519 seed/private key is 64 hex chars and never needs
 * a letter/digit mix to be sensitive. The threshold (32 = 128-bit) is well
 * below that so shorter raw keys are not missed either. Long
 * hyphen/colon-separated hex is already covered by the address mask (colon) or
 * breaks on its separators; the contiguous-hex gate catches the raw form.
 */
export const HIGH_ENTROPY_HEX_MIN_LENGTH = 32;

/**
 * A letter/digit run of this many characters spanning at least two of
 * {lower, upper, digit} is treated as a secret (base64-ish, slug-style keys).
 */
export const HIGH_ENTROPY_MIXED_MIN_LENGTH = 16;

/** Distinct characters a token must contain to count as high-entropy. */
const HIGH_ENTROPY_DISTINCT_MIN = 6;

/** Contiguous hex runs (any case) — the raw-seed/key gate. */
const RAW_HEX_RE = new RegExp(`[0-9a-fA-F]{${HIGH_ENTROPY_HEX_MIN_LENGTH},}`, "g");

/** Letter/digit runs — the mixed-class gate (separators split slugs/UUIDs). */
const ALNUM_RUN_RE = new RegExp(
  `[A-Za-z0-9]{${HIGH_ENTROPY_MIXED_MIN_LENGTH},}`,
  "g",
);

function isHexOnly(s: string): boolean {
  return /^[0-9a-fA-F]+$/.test(s);
}

function distinctCount(s: string): number {
  return new Set(s).size;
}

function charClassCount(s: string): number {
  let classes = 0;
  if (/[a-z]/.test(s)) {
    classes += 1;
  }
  if (/[A-Z]/.test(s)) {
    classes += 1;
  }
  if (/[0-9]/.test(s)) {
    classes += 1;
  }
  return classes;
}

/**
 * The high-entropy fallback over one text string. Pure-hex runs of
 * {@link HIGH_ENTROPY_HEX_MIN_LENGTH}+ characters are always masked; other
 * long letter/digit runs are masked when they span ≥2 character classes with
 * enough distinct characters. Every non-matching token is returned verbatim,
 * so prose and hyphenated correlation ids survive.
 */
export function redactHighEntropy(text: string): string {
  let out = text.replace(RAW_HEX_RE, "[redacted:token]");
  out = out.replace(ALNUM_RUN_RE, (m) => {
    if (isHexOnly(m) || charClassCount(m) < 2 || distinctCount(m) < HIGH_ENTROPY_DISTINCT_MIN) {
      return m;
    }
    return "[redacted:token]";
  });
  return out;
}

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
  return redactHighEntropy(out);
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
