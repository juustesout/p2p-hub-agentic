import {
  MAX_KEY_COUNT,
  MAX_OBJECT_DEPTH,
  isPlainObject,
} from "./boundary-guard";
import { containsUnsafeContent } from "./sanitizer";

/**
 * A validated, renderable action card. Pure data — no executable strings,
 * code references, or prototype-polluting keys survive validation. `data` is
 * an open-ended bag of plain-data attributes (primitives and nested plain
 * objects/arrays) capped by the boundary guard limits.
 */
export interface ChatActionPayload {
  /** Dot/colon-namespaced action id, e.g. `chess.invite`. */
  actionId: string;
  /** Short category tag, e.g. `invitation`. */
  type: string;
  /** Human-readable title (already checked to contain no markup). */
  title: string;
  /** Optional data attributes. */
  data?: Record<string, unknown>;
}

/** Raised when an action card is malformed or carries suspicious content. */
export class InvalidActionPayloadError extends Error {
  constructor(message: string) {
    super(`invalid action payload: ${message}`);
    this.name = "InvalidActionPayloadError";
  }
}

const ACTION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const TYPE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const MAX_ACTION_ID_LENGTH = 128;
const MAX_TYPE_LENGTH = 64;
const MAX_TITLE_LENGTH = 500;
const MAX_DATA_STRING_LENGTH = 10_000;

/** Keys that could mutate an object's prototype if copied naively. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function fail(message: string): never {
  throw new InvalidActionPayloadError(message);
}

function validateDataTree(value: unknown, depth: number): void {
  if (depth > MAX_OBJECT_DEPTH) {
    fail(`data exceeds the maximum nesting depth of ${MAX_OBJECT_DEPTH}`);
  }
  if (value === null) {
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_DATA_STRING_LENGTH) {
      fail(`data string exceeds ${MAX_DATA_STRING_LENGTH} characters`);
    }
    if (containsUnsafeContent(value)) {
      fail("data contains unsafe content");
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_KEY_COUNT) {
      fail(`data array exceeds ${MAX_KEY_COUNT} items`);
    }
    for (const item of value) {
      validateDataTree(item, depth + 1);
    }
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > MAX_KEY_COUNT) {
      fail(`data object exceeds ${MAX_KEY_COUNT} keys`);
    }
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) {
        fail(`forbidden key "${key}"`);
      }
      validateDataTree(value[key], depth + 1);
    }
    return;
  }
  fail("data contains a non-data value");
}

/**
 * Validate an incoming action card and return a clean, safe
 * {@link ChatActionPayload}. Rejects (throws
 * {@link InvalidActionPayloadError}) on malformed shapes, unsafe content
 * (HTML/scripts/dangerous URLs) in `title` or `data`, and prototype-polluting
 * keys. Unknown top-level keys are stripped; only `actionId`, `type`, `title`
 * and `data` are carried through.
 */
export function validateActionPayload(payload: unknown): ChatActionPayload {
  if (!isPlainObject(payload)) {
    fail("expected a plain object");
  }
  const record = payload as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key)) {
      fail(`forbidden key "${key}"`);
    }
  }

  const { actionId, type, title, data } = record;

  if (
    typeof actionId !== "string" ||
    actionId.length === 0 ||
    actionId.length > MAX_ACTION_ID_LENGTH ||
    !ACTION_ID_RE.test(actionId)
  ) {
    fail("actionId must be a safe identifier string");
  }
  if (
    typeof type !== "string" ||
    type.length === 0 ||
    type.length > MAX_TYPE_LENGTH ||
    !TYPE_RE.test(type)
  ) {
    fail("type must be a safe identifier string");
  }
  if (
    typeof title !== "string" ||
    title.length === 0 ||
    title.length > MAX_TITLE_LENGTH
  ) {
    fail(`title must be a non-empty string up to ${MAX_TITLE_LENGTH} characters`);
  }
  if (containsUnsafeContent(title)) {
    fail("title contains unsafe content");
  }

  let cleanData: Record<string, unknown> | undefined;
  if (data !== undefined) {
    if (!isPlainObject(data)) {
      fail("data must be a plain object");
    }
    validateDataTree(data, 1);
    cleanData = data as Record<string, unknown>;
  }

  const result: ChatActionPayload = { actionId, type, title };
  if (cleanData !== undefined) {
    result.data = cleanData;
  }
  return result;
}
