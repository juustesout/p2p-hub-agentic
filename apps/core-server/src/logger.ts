import * as fs from "node:fs";
import pino from "pino";
import type { Logger } from "pino";
import pinoPretty from "pino-pretty";
import { diagnostics } from "./diagnostics/engine";

/**
 * Structured logger for the core-server runtime.
 *
 * JSON in production / non-interactive sinks, human-readable pretty output on
 * an interactive dev terminal. The machine-facing stdout contract is untouched:
 * the `[P2P_HUB_READY]` sidecar handshake is written via `process.stdout.write`
 * directly (never through this logger), and a piped stdout (sidecar, tests, CI,
 * log collectors) keeps pino's JSON records on fd 1 — the host scans lines for
 * the handshake prefix and treats everything else as ordinary log output.
 *
 * The pretty sink is engaged only when the standard library can guarantee a
 * human is watching: `process.stdout.isTTY` and not `NODE_ENV=production`.
 * `P2P_HUB_LOG_JSON=1` forces JSON on an interactive terminal; the level is
 * `P2P_HUB_LOG_LEVEL`/`LOG_LEVEL`, default `info`. In sidecar mode
 * (`P2P_HUB_SIDECAR_READY=1`, i.e. the desktop shell, whose stderr is drained
 * to `<dataDir>/core-server.log`) the default drops to `debug` unless an
 * explicit level is set — the whole point of that log file is troubleshooting,
 * so it starts verbose instead of hiding the request trace.
 *
 * Diagnostics integration: every JSON record is also routed into the
 * diagnostics engine's per-module ring buffers (see `diagnostics/engine.ts`),
 * which is the primary viewer source for the HelpCenter log tab. Pretty (TTY)
 * records are human text and are intentionally not parsed back.
 */
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
const requestedLevel =
  process.env.P2P_HUB_LOG_LEVEL ??
  process.env.LOG_LEVEL ??
  (process.env.P2P_HUB_SIDECAR_READY === "1" ? "debug" : "info");
const level = LOG_LEVELS.includes(requestedLevel) ? requestedLevel : "info";

const usePretty =
  !!process.stdout.isTTY &&
  process.env.NODE_ENV !== "production" &&
  process.env.P2P_HUB_LOG_JSON !== "1";

/**
 * Synchronous JSON destination on fd 1. pino's default destination
 * (sonic-boom) is buffered and asynchronous, which (a) can lose records when
 * the process exits right after a log — the desktop shell SIGTERMs the moment
 * it reads the ready handshake — and (b) makes ordering against the handshake
 * line non-deterministic. A local bridge produces little log volume, so
 * synchronous writes are free and ordering is exact. On EPIPE (the reader
 * closed the pipe) writing stops instead of crashing the server.
 *
 * The same write also feeds the diagnostics engine: a JSON line is ingested
 * into the per-module ring buffers so the HelpCenter viewer works even when
 * the on-disk log is missing or rotated. Ingestion failures are never fatal —
 * logging must never break because the diagnostics layer hiccuped.
 */
let brokenPipe = false;
const syncDest = {
  write(msg: string): void {
    if (brokenPipe) {
      return;
    }
    try {
      diagnostics.ingestLine(msg);
    } catch {
      /* diagnostics must never break logging */
    }
    try {
      fs.writeSync(process.stdout.fd ?? 1, msg);
    } catch (err) {
      brokenPipe = true;
      if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
        try {
          fs.writeSync(
            process.stderr.fd ?? 2,
            `[core-server] log write failed: ${(err as Error).message}\n`,
          );
        } catch {
          /* no further reporting possible */
        }
      }
    }
  },
};

export const logger = usePretty
  ? pino(
      { name: "core-server", level },
      pinoPretty({
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
      }),
    )
  : pino({ name: "core-server", level }, syncDest);

/** Whether JSON records are routed into the diagnostics ring buffers. */
export const diagnosticsEnabled = !usePretty;

/**
 * The shared, pre-registered child logger for a diagnostics module. Logging
 * through this tags every record with the `module` field so the engine can
 * route it into the module's ring buffer (and the viewer can filter by it).
 * Callers should cache the returned logger; the engine keeps one instance.
 */
export function moduleLogger(module: string): Logger {
  return diagnostics.moduleLogger(module);
}

export default logger;
