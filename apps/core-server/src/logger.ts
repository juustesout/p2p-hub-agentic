import * as fs from "node:fs";
import pino from "pino";
import pinoPretty from "pino-pretty";

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
 * `P2P_HUB_LOG_LEVEL`/`LOG_LEVEL`, default `info`.
 */
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
const requestedLevel =
  process.env.P2P_HUB_LOG_LEVEL ?? process.env.LOG_LEVEL ?? "info";
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
 */
let brokenPipe = false;
const syncDest = {
  write(msg: string): void {
    if (brokenPipe) {
      return;
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

export default logger;
