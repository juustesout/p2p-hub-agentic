/**
 * Boundary guard: hard, deterministic limits on every structured payload that
 * crosses a trust boundary (network frames, chat messages, action cards).
 * These run in-memory and throw typed errors, so an oversized or over-deep
 * payload is rejected before it can exhaust memory or the JS call stack.
 */

/** Maximum bytes for a generic P2P message/frame. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/** Maximum characters for a single chat text body. */
export const MAX_CHAT_TEXT_LENGTH = 10_000;

/** Maximum nesting depth for structured objects (prevents stack overflow). */
export const MAX_OBJECT_DEPTH = 10;

/** Maximum number of keys in a single object (and items in a single array). */
export const MAX_KEY_COUNT = 500;

/** Raised when a payload exceeds its byte budget. */
export class PayloadTooLargeError extends Error {
  readonly actual: number;
  readonly limit: number;

  constructor(actual: number, limit: number) {
    super(`payload is ${actual} bytes, exceeding the ${limit}-byte limit`);
    this.name = "PayloadTooLargeError";
    this.actual = actual;
    this.limit = limit;
  }
}

/** Raised when a structured value nests deeper than allowed. */
export class ObjectDepthExceededError extends Error {
  readonly maxDepth: number;

  constructor(maxDepth: number) {
    super(`object exceeds the maximum nesting depth of ${maxDepth}`);
    this.name = "ObjectDepthExceededError";
    this.maxDepth = maxDepth;
  }
}

/** Raised when an object or array has more keys/items than allowed. */
export class KeyCountExceededError extends Error {
  readonly actual: number;
  readonly limit: number;

  constructor(actual: number, limit: number) {
    super(`object has ${actual} keys, exceeding the ${limit}-key limit`);
    this.name = "KeyCountExceededError";
    this.actual = actual;
    this.limit = limit;
  }
}

/** True for plain objects (including `Object.create(null)`), false otherwise. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Throw {@link PayloadTooLargeError} when `data` exceeds `maxBytes`. A string
 * is measured in UTF-8 bytes, a typed array by its `byteLength`.
 */
export function validatePayloadSize(
  data: string | Uint8Array,
  maxBytes: number = MAX_PAYLOAD_BYTES,
): void {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data).byteLength
      : data.byteLength;
  if (bytes > maxBytes) {
    throw new PayloadTooLargeError(bytes, maxBytes);
  }
}

/**
 * Throw {@link ObjectDepthExceededError} when `obj` nests containers deeper
 * than `maxDepth`. Containers are plain objects and arrays; a leaf scalar is
 * never itself counted as a level. Depth is bounded by construction (the cap
 * also stops the recursion), so even a cyclic in-memory structure terminates
 * with an error instead of overflowing the stack.
 */
export function validateObjectDepth(
  obj: unknown,
  maxDepth: number = MAX_OBJECT_DEPTH,
): void {
  walkDepth(obj, 1, maxDepth);
}

function walkDepth(value: unknown, depth: number, maxDepth: number): void {
  if (Array.isArray(value)) {
    if (depth > maxDepth) {
      throw new ObjectDepthExceededError(maxDepth);
    }
    for (const item of value) {
      walkDepth(item, depth + 1, maxDepth);
    }
    return;
  }
  if (isPlainObject(value)) {
    if (depth > maxDepth) {
      throw new ObjectDepthExceededError(maxDepth);
    }
    for (const key of Object.keys(value)) {
      walkDepth(value[key], depth + 1, maxDepth);
    }
  }
}

/**
 * Reject a raw JSON *string* whose container nesting exceeds `maxDepth`
 * without parsing it. Deeply-nested input like `[[[[…]]]]` (2 bytes per
 * level) is cheap to build, but it can overflow recursive consumers further
 * down the line. `validateObjectDepth` already caps post-parse traversal
 * stack-safely (it throws at depth `maxDepth` before recursing), but it only
 * runs *after* `JSON.parse` has already built the full object graph. This
 * guard runs first, scanning the bytes linearly (string/escape-aware) so
 * over-deep JSON is rejected deterministically with an
 * {@link ObjectDepthExceededError} before any recursive work — including
 * `JSON.stringify`, which *does* overflow the call stack on such a graph —
 * can happen.
 *
 * It is also defensive against JSON parsers that are themselves recursive
 * (e.g. serde_json, older or non-V8 engines), where deep input would throw a
 * stack-overflow `RangeError` from inside the parser rather than a typed
 * depth error.
 *
 * This is a conservative pre-check, not a JSON validator: it only measures
 * bracket/brace depth and never rejects valid JSON at or under `maxDepth`.
 * Brackets inside string literals are ignored, and malformed JSON is left to
 * the real parser to reject.
 */
export function validateJsonNestingDepth(
  raw: string,
  maxDepth: number = MAX_OBJECT_DEPTH,
): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      depth += 1;
      if (depth > maxDepth) {
        throw new ObjectDepthExceededError(maxDepth);
      }
    } else if (ch === "]" || ch === "}") {
      depth -= 1;
    }
  }
}

/**
 * Throw {@link KeyCountExceededError} when any object (or array) in `obj` has
 * more than `maxKeys` keys/items. Traversal is depth-capped by
 * {@link MAX_OBJECT_DEPTH} so a pathological deep structure fails fast.
 */
export function validateKeyCount(
  obj: unknown,
  maxKeys: number = MAX_KEY_COUNT,
): void {
  walkKeys(obj, 1, maxKeys);
}

function walkKeys(value: unknown, depth: number, maxKeys: number): void {
  if (Array.isArray(value)) {
    if (depth > MAX_OBJECT_DEPTH) {
      throw new ObjectDepthExceededError(MAX_OBJECT_DEPTH);
    }
    if (value.length > maxKeys) {
      throw new KeyCountExceededError(value.length, maxKeys);
    }
    for (const item of value) {
      walkKeys(item, depth + 1, maxKeys);
    }
    return;
  }
  if (isPlainObject(value)) {
    if (depth > MAX_OBJECT_DEPTH) {
      throw new ObjectDepthExceededError(MAX_OBJECT_DEPTH);
    }
    const keys = Object.keys(value);
    if (keys.length > maxKeys) {
      throw new KeyCountExceededError(keys.length, maxKeys);
    }
    for (const key of keys) {
      walkKeys(value[key], depth + 1, maxKeys);
    }
  }
}

/**
 * Throw {@link PayloadTooLargeError} when `text` exceeds `maxLength`
 * characters. Used to enforce {@link MAX_CHAT_TEXT_LENGTH} for chat bodies.
 */
export function validateTextLength(
  text: string,
  maxLength: number = MAX_CHAT_TEXT_LENGTH,
): void {
  if (text.length > maxLength) {
    throw new PayloadTooLargeError(text.length, maxLength);
  }
}
