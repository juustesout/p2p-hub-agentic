/**
 * Diagnostics operator routes (`/api/diagnostics/*`).
 *
 * A new operator surface (HelpCenter Pijler G), token-gated by the global
 * `/api` gate like every other operator route. Deny-by-default:
 * - only **registered** source ids are accepted — a client-supplied path never
 *   reaches the filesystem (file reads go through the engine's single resolved
 *   `core-server.log` path);
 * - reads are bounded (line count + byte tail);
 * - records are redacted by default; raw output requires an explicit
 *   `unredacted=1` (the power-user toggle), never the default;
 * - the level/source toggles cannot disable security-relevant sources
 *   (`vault`, `identity`) — enforced in the engine.
 */

import * as http from "node:http";
import { readJsonBody, sendJson } from "./helpers";
import { logger } from "../logger";
import { DIAGNOSTICS_MAX_READ } from "../diagnostics/ring-buffer";
import type { DiagnosticsEngine } from "../diagnostics/engine";

export interface DiagnosticsContext {
  engine: DiagnosticsEngine;
}

interface LogsQuery {
  source?: string;
  limit?: number;
  level?: string;
  unredacted?: boolean;
}

function parseLogsQuery(url: URL): LogsQuery {
  const q = url.searchParams;
  const source = q.get("source") ?? undefined;
  const limitRaw = q.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const level = q.get("level") ?? undefined;
  const unredacted = q.get("unredacted") === "1";
  return { source, limit, level, unredacted };
}

function parseLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DIAGNOSTICS_MAX_READ;
  }
  return Math.min(Math.max(1, Math.floor(raw)), DIAGNOSTICS_MAX_READ);
}

export async function serveDiagnostics(
  ctx: DiagnosticsContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (
    pathname !== "/api/diagnostics" &&
    !pathname.startsWith("/api/diagnostics/")
  ) {
    return false;
  }

  // Tail the log register: with `?source=` one source, without it the whole
  // register plus a bounded tail per source. Always redacted unless the caller
  // explicitly opts out (`unredacted=1`).
  if (req.method === "GET" && pathname === "/api/diagnostics/logs") {
    const query = parseLogsQuery(new URL(req.url ?? "/", "http://localhost"));
    const sources = ctx.engine.listSources();

    if (query.source !== undefined) {
      if (!sources.some((s) => s.id === query.source)) {
        sendJson(res, 400, {
          ok: false,
          error: `unknown diagnostics source "${query.source}"`,
        });
        return true;
      }
      const read = ctx.engine.readSource(query.source, {
        limit: parseLimit(query.limit),
        level: query.level,
        unredacted: query.unredacted,
      });
      sendJson(res, 200, {
        ok: true,
        sources,
        records: read ? { [read.source.id]: read.records } : {},
      });
      return true;
    }

    const records: Record<string, unknown[]> = {};
    for (const source of sources) {
      const read = ctx.engine.readSource(source.id, {
        limit: 50,
        level: query.level,
        unredacted: query.unredacted,
      });
      if (read) {
        records[read.source.id] = read.records;
      }
    }
    sendJson(res, 200, { ok: true, sources, records });
    return true;
  }

  // Global level toggle: validates against the pino set and applies it to the
  // live root logger (runtime, no restart).
  if (req.method === "PATCH" && pathname === "/api/diagnostics/level") {
    const body = (await readJsonBody(req)) as { level?: unknown };
    if (typeof body.level !== "string") {
      sendJson(res, 400, { ok: false, error: "level expects { level: string }" });
      return true;
    }
    const result = ctx.engine.setGlobalLevel(body.level);
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: result.error });
      return true;
    }
    logger.level = body.level as "info";
    sendJson(res, 200, { ok: true, level: body.level });
    return true;
  }

  // Per-source enable/disable (the viewer's checkboxes). Security-relevant
  // sources cannot be disabled (engine-enforced, deny-by-default).
  if (req.method === "PATCH" && pathname === "/api/diagnostics/source") {
    const body = (await readJsonBody(req)) as { id?: unknown; enabled?: unknown };
    if (typeof body.id !== "string" || typeof body.enabled !== "boolean") {
      sendJson(res, 400, {
        ok: false,
        error: "source expects { id: string, enabled: boolean }",
      });
      return true;
    }
    const result = ctx.engine.setSourceEnabled(body.id, body.enabled);
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: result.error });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 404, { error: "not found" });
  return true;
}
