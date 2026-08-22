/**
 * Fase 3 Slice 1 — Sandboxing IPC wire protocol.
 *
 * A strict, dependency-free subset of JSON-RPC 2.0 used on the PluginHost ↔
 * sandbox-runner channel. Every frame is a JSON object carrying a `type`
 * discriminator so the wire format is unambiguously a request, a response or a
 * notification and parsing is fail-closed by construction:
 *
 * - `jsonrpc` MUST be the literal string `"2.0"`.
 * - request/response `id` MUST be a UUIDv4 string (no numbers, no null — this
 *   is an internal protocol with strict correlation).
 * - a response carries exactly one of `result` / `error` (JSON-RPC 2.0 rule;
 *   both or neither is rejected).
 * - `params` is a structured value (object or array).
 *
 * Parsing never throws for a wrong shape: `parseIPCMessageEnvelope` returns
 * `null` on any violation so callers default-deny. `parseIPCMessageText`
 * (used by the transport) converts the two failure classes into a typed
 * {@link IPCParseError}: `PARSE_ERROR` for undecodable JSON, `INVALID_REQUEST`
 * for a JSON value that is not a valid IPC message.
 */

/** Envelope discriminator: what kind of JSON-RPC frame this is. */
export type IPCMessageType = "request" | "response" | "notification";

export interface IPCRequestMessage {
  type: "request";
  jsonrpc: "2.0";
  /** UUIDv4 correlating request ↔ response. Mandatory (no `null` ids). */
  id: string;
  /** Method name to invoke in the remote runtime. */
  method: string;
  /** Optional structured parameter value (object or array). */
  params?: unknown;
}

export interface IPCResponseMessage {
  type: "response";
  jsonrpc: "2.0";
  /** Echo of the request id that produced this response. */
  id: string;
  /**
   * Exactly one of `result` / `error` is present. `result` may legitimately be
   * `null` (a resolved method returning nothing) — presence is the signal.
   */
  result?: unknown;
  error?: IPCErrorObject;
}

export interface IPCNotificationMessage {
  type: "notification";
  jsonrpc: "2.0";
  /** Method name of the event/crash being reported. */
  method: string;
  params?: unknown;
}

/** Every valid IPC frame, discriminated on `type`. */
export type IPCMessageEnvelope =
  | IPCRequestMessage
  | IPCResponseMessage
  | IPCNotificationMessage;

/** JSON-RPC 2.0 error object. `code` must be an integer. */
export interface IPCErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export const JSONRPC_VERSION = "2.0" as const;

/**
 * Error codes. The `-32xxx` range is the JSON-RPC 2.0 standard; the positive
 * range is IPC-specific (sandbox channel) and kept distinct so a protocol code
 * can never be confused with an application error code.
 */
export const IPCErrorCodes = {
  /** Invalid JSON was received. */
  PARSE_ERROR: -32700,
  /** A JSON value that is not a valid request/response/notification. */
  INVALID_REQUEST: -32600,
  /** The requested method does not exist in the remote runtime. */
  METHOD_NOT_FOUND: -32601,
  /** Valid method, but the params did not match what it accepts. */
  INVALID_PARAMS: -32602,
  /** Unhandled error inside the remote runtime. */
  INTERNAL_ERROR: -32603,
  /** The IPC channel is closed; sending on it is a caller bug. */
  CHANNEL_CLOSED: 1000,
  /** A frame exceeds the negotiated maximum payload size. */
  FRAME_TOO_LARGE: 1001,
} as const;

export type IPCErrorCode = (typeof IPCErrorCodes)[keyof typeof IPCErrorCodes];

/**
 * Typed protocol error thrown by the transport/runner on a malformed frame or
 * a protocol violation. Carries the JSON-RPC error code so a caller can react
 * to the failure class without string-matching.
 */
export class IPCParseError extends Error {
  readonly code: IPCErrorCode;
  /** Optional machine-readable detail (e.g. the offending frame length). */
  readonly detail?: string;

  constructor(code: IPCErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "IPCParseError";
    this.code = code;
    this.detail = detail;
  }
}

/** Strict UUIDv4 (variant 1, version 4). */
const UUIDV4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUUIDv4(value: unknown): value is string {
  return typeof value === "string" && UUIDV4_RE.test(value);
}

function isStructuredParams(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

export function isIPCErrorObject(value: unknown): value is IPCErrorObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const e = value as Record<string, unknown>;
  return (
    typeof e.code === "number" &&
    Number.isInteger(e.code) &&
    typeof e.message === "string" &&
    (e.data === undefined || isStructuredParams(e.data))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Strictly validate an arbitrary JSON value as an IPC message. Returns `null`
 * on any violation (fail-closed); callers must never treat a non-null-returning
 * parse as "maybe". Unknown `type` discriminators, a wrong `jsonrpc` version,
 * non-UUID ids, a response with both/neither of result+error, and missing
 * method names are all rejected.
 */
export function parseIPCMessageEnvelope(value: unknown): IPCMessageEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const m = value as Record<string, unknown>;
  if (m.jsonrpc !== JSONRPC_VERSION) {
    return null;
  }
  const type = m.type;
  if (type === "request") {
    if (!isUUIDv4(m.id) || !isNonEmptyString(m.method)) {
      return null;
    }
    if (m.params !== undefined && !isStructuredParams(m.params)) {
      return null;
    }
    const out: IPCRequestMessage = {
      type: "request",
      jsonrpc: JSONRPC_VERSION,
      id: m.id,
      method: m.method,
    };
    if (m.params !== undefined) {
      out.params = m.params;
    }
    return out;
  }
  if (type === "response") {
    if (!isUUIDv4(m.id)) {
      return null;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(m, "result");
    const hasError = m.error !== undefined;
    // JSON-RPC 2.0: a response carries exactly one of result/error.
    if (hasResult === hasError) {
      return null;
    }
    let parsedError: IPCErrorObject | undefined;
    if (hasError) {
      if (!isIPCErrorObject(m.error)) {
        return null;
      }
      parsedError = m.error;
    }
    const out: IPCResponseMessage = {
      type: "response",
      jsonrpc: JSONRPC_VERSION,
      id: m.id,
    };
    if (hasResult) {
      out.result = m.result;
    } else if (parsedError !== undefined) {
      out.error = parsedError;
    }
    return out;
  }
  if (type === "notification") {
    if (!isNonEmptyString(m.method)) {
      return null;
    }
    if (m.params !== undefined && !isStructuredParams(m.params)) {
      return null;
    }
    const out: IPCNotificationMessage = {
      type: "notification",
      jsonrpc: JSONRPC_VERSION,
      method: m.method,
    };
    if (m.params !== undefined) {
      out.params = m.params;
    }
    return out;
  }
  return null;
}

/**
 * Parse a complete frame's text into an IPC message, throwing a typed
 * {@link IPCParseError} on failure — `PARSE_ERROR` for undecodable JSON and
 * `INVALID_REQUEST` for a value that is not a valid message. This is what the
 * transport uses so a hostile or corrupt frame never reaches the handler.
 */
export function parseIPCMessageText(text: string): IPCMessageEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new IPCParseError(IPCErrorCodes.PARSE_ERROR, "frame is not valid JSON");
  }
  const message = parseIPCMessageEnvelope(value);
  if (message === null) {
    throw new IPCParseError(
      IPCErrorCodes.INVALID_REQUEST,
      "frame is not a valid IPC message",
    );
  }
  return message;
}

/** Serialize an IPC message to the wire text. */
export function stringifyIPCMessage(message: IPCMessageEnvelope): string {
  return JSON.stringify(message);
}

/** Build a JSON-RPC error object for use in a response. */
export function makeIPCError(
  code: IPCErrorCode,
  message: string,
  data?: unknown,
): IPCErrorObject {
  return data === undefined ? { code, message } : { code, message, data };
}
