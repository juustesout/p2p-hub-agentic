/**
 * Fase 3 Slice 1 — IPC socket transport over any NodeJS Readable/Writable pair
 * (`process.stdin`/`process.stdout`, child_process stdio, `PassThrough`).
 *
 * Framing is length-prefixed (4-byte big-endian payload length + UTF-8 JSON),
 * the same shape `network-light` uses — it survives arbitrary pipe/stream
 * fragmentation and needs no delimiter escaping. Every decoded frame is parsed
 * fail-closed through `parseIPCMessageText`: malformed JSON and protocol
 * violations surface as a typed {@link IPCParseError} (never a stream crash or
 * an uncaught exception), and on a security boundary a hostile/corrupt frame
 * tears the channel down via the error + close handlers.
 *
 * The frame length is read before allocation and capped at `maxFrameBytes`, so
 * a peer that declares a huge frame cannot grow the receive buffer unboundedly
 * (fail-closed against memory exhaustion).
 */

import type { IPCMessageEnvelope } from "@p2p-hub/sdk";
import {
  IPCErrorCodes,
  IPCParseError,
  parseIPCMessageText,
  stringifyIPCMessage,
} from "@p2p-hub/sdk";

/** Bytes of the big-endian length header preceding each frame payload. */
export const IPC_FRAME_HEADER_BYTES = 4;

/** Fail-closed default cap for a single frame payload. */
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

export interface IPCSocketTransportOptions {
  /**
   * Maximum accepted frame payload length in bytes. A frame that declares a
   * larger payload fails closed (FRAME_TOO_LARGE) before any allocation beyond
   * the header. Also enforced when *sending* so we never emit a frame the peer
   * would reject. Defaults to {@link DEFAULT_MAX_FRAME_BYTES}.
   */
  maxFrameBytes?: number;
}

export type IPCMessageHandler = (message: IPCMessageEnvelope) => void;
export type IPCErrorHandler = (err: IPCParseError | Error) => void;
export type IPCVoidHandler = () => void;

/** Optional teardown surface some streams expose (fs/net/PassThrough). */
interface Destroyable {
  destroy?: (err?: Error) => void;
  pause?: () => void;
}

export class IPCSocketTransport {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly maxFrameBytes: number;

  private buffer = Buffer.alloc(0);
  private writeQueue: Buffer[] = [];
  private flushing = false;
  private closed = false;

  private messageHandler: IPCMessageHandler | null = null;
  private errorHandler: IPCErrorHandler | null = null;
  private closeHandler: IPCVoidHandler | null = null;

  constructor(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
    options: IPCSocketTransportOptions = {},
  ) {
    this.input = input;
    this.output = output;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;

    // Reading immediately after construction: for a paused stream (process
    // stdin, PassThrough) attaching the 'data' listener starts flowing mode.
    input.on("data", (chunk: Buffer) => this.onData(chunk));
    input.on("error", (err) => this.onInputError(err));
    input.on("end", () => this.close());
    output.on("error", (err) => this.onInputError(err));
  }

  /** Register the handler invoked for every successfully decoded message. */
  onMessage(handler: IPCMessageHandler): this {
    this.messageHandler = handler;
    return this;
  }

  /**
   * Register the handler invoked with a typed {@link IPCParseError} (or other
   * stream error) before the channel is torn down. Never called on a clean
   * `close()`.
   */
  onError(handler: IPCErrorHandler): this {
    this.errorHandler = handler;
    return this;
  }

  /** Register the handler invoked when the channel is closed (any reason). */
  onClose(handler: IPCVoidHandler): this {
    this.closeHandler = handler;
    return this;
  }

  /**
   * Serialize and write one message as a length-prefixed frame. Backpressure
   * is honored via an internal write queue flushed on 'drain'. Throws a typed
   * {@link IPCParseError} when the channel is closed or the frame would exceed
   * `maxFrameBytes` — sending on a dead channel is a caller bug, not silent.
   */
  send(message: IPCMessageEnvelope): void {
    if (this.closed) {
      throw new IPCParseError(
        IPCErrorCodes.CHANNEL_CLOSED,
        "IPC transport is closed",
      );
    }
    const payload = Buffer.from(stringifyIPCMessage(message), "utf8");
    if (payload.length > this.maxFrameBytes) {
      throw new IPCParseError(
        IPCErrorCodes.FRAME_TOO_LARGE,
        `IPC frame payload of ${payload.length} bytes exceeds the ${this.maxFrameBytes}-byte limit`,
      );
    }
    const frame = Buffer.allocUnsafe(IPC_FRAME_HEADER_BYTES + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, IPC_FRAME_HEADER_BYTES);
    this.writeQueue.push(frame);
    this.flushWrites();
  }

  /**
   * Gracefully close the channel: stop reading, flush-ended output. No error
   * handler is invoked. Safe to call multiple times.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.teardown();
    this.closeHandler?.();
  }

  /** True once the channel is closed (any reason). */
  isClosed(): boolean {
    return this.closed;
  }

  private onData(chunk: Buffer): void {
    if (this.closed) {
      return;
    }
    this.buffer =
      this.buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, chunk]);
    try {
      for (;;) {
        const payload = this.tryDecodeFrame();
        if (payload === null) {
          return;
        }
        this.dispatchFrame(payload);
      }
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private onInputError(err: Error): void {
    this.fail(err instanceof Error ? err : new Error(String(err)));
  }

  /** Decode one complete frame, or `null` when more bytes are needed. */
  private tryDecodeFrame(): Buffer | null {
    if (this.buffer.length < IPC_FRAME_HEADER_BYTES) {
      return null;
    }
    const length = this.buffer.readUInt32BE(0);
    if (length > this.maxFrameBytes) {
      throw new IPCParseError(
        IPCErrorCodes.FRAME_TOO_LARGE,
        `IPC frame header declares ${length} bytes, exceeding the ${this.maxFrameBytes}-byte limit`,
      );
    }
    if (this.buffer.length < IPC_FRAME_HEADER_BYTES + length) {
      return null;
    }
    const payload = this.buffer.subarray(
      IPC_FRAME_HEADER_BYTES,
      IPC_FRAME_HEADER_BYTES + length,
    );
    this.buffer = this.buffer.subarray(IPC_FRAME_HEADER_BYTES + length);
    return payload;
  }

  /** Fail-closed parse of one frame; throws IPCParseError on any violation. */
  private dispatchFrame(payload: Buffer): void {
    const message = parseIPCMessageText(payload.toString("utf8"));
    this.messageHandler?.(message);
  }

  /** Fail the channel: error handler first, then teardown + close handler. */
  private fail(err: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.errorHandler?.(err);
    } catch {
      // An error handler must not turn a parse failure into a throw.
    }
    this.teardown();
    this.closeHandler?.();
  }

  private teardown(): void {
    const input = this.input as unknown as Destroyable;
    const output = this.output as unknown as { end?: () => void };
    try {
      input.pause?.();
    } catch {
      // ignore
    }
    try {
      input.destroy?.();
    } catch {
      // ignore
    }
    try {
      output.end?.();
    } catch {
      // ignore
    }
  }

  private flushWrites(): void {
    if (this.flushing || this.closed) {
      return;
    }
    while (this.writeQueue.length > 0) {
      const frame = this.writeQueue[0];
      let ok: boolean;
      try {
        ok = this.output.write(frame);
      } catch (err) {
        this.fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!ok) {
        this.flushing = true;
        this.output.once("drain", () => {
          this.flushing = false;
          this.flushWrites();
        });
        return;
      }
      this.writeQueue.shift();
    }
  }
}
