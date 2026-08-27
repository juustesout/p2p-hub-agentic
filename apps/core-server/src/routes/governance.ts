import * as http from "node:http";
import { TrustConfirmationDeniedError } from "@p2p-hub/core";
import type { TaskBroker } from "@p2p-hub/core";
import {
  AccessDeniedError,
  InvalidRateLimitError,
  PEER_ID_RE as GOVERNANCE_PEER_ID_RE,
} from "../governance/matrix";
import type { GovernanceService } from "../governance/service";
import type { GovernanceStream } from "../governance/stream";
import { readJsonBody, sendJson } from "./helpers";

/**
 * Everything the governance routes need from the CoreServer. Deliberately
 * narrow — the routes never reach for the whole server object.
 */
export interface GovernanceContext {
  governance(): GovernanceService | null;
  governanceStream(): GovernanceStream | null;
  broadcast(event: string, payload: unknown): void;
}

/** URL prefix under which the Stap-6 governance API is mounted. */
const GOVERNANCE_PREFIX = "/api/governance/v1";

/**
 * Stap 6 — governance API. Mounted under `/api/` so the existing boot-token
 * check (`isAuthorized`) applies to every route here, including the SSE
 * stream, before any handler runs. All writes are tier-2 confirmed inside the
 * governance service (the boot token alone authorizes nothing on this
 * surface). The catalog/topology/matrix reads are operator-visible.
 */
export async function serveGovernance(
  ctx: GovernanceContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith(GOVERNANCE_PREFIX)) {
    return false;
  }
  const governance = ctx.governance();
  if (!governance) {
    sendJson(res, 503, { error: "governance not initialized" });
    return true;
  }

  if (req.method === "GET" && pathname === `${GOVERNANCE_PREFIX}/catalog`) {
    sendJson(res, 200, await governance.catalog());
    return true;
  }

  if (req.method === "GET" && pathname === `${GOVERNANCE_PREFIX}/topology`) {
    sendJson(res, 200, { peers: await governance.topology() });
    return true;
  }

  if (req.method === "GET" && pathname === `${GOVERNANCE_PREFIX}/matrix`) {
    sendJson(res, 200, { entries: governance.matrixList() });
    return true;
  }

  if (req.method === "GET" && pathname === `${GOVERNANCE_PREFIX}/stream`) {
    attachGovernanceStream(ctx, req, res);
    return true;
  }

  const verifyMatch = pathname.match(
    /^\/api\/governance\/v1\/peers\/([^/]+)\/verify$/,
  );
  if (req.method === "POST" && verifyMatch) {
    const peerId = decodeURIComponent(verifyMatch[1]);
    if (!GOVERNANCE_PEER_ID_RE.test(peerId)) {
      sendJson(res, 400, { error: "invalid peerId" });
      return true;
    }
    try {
      const result = await governance.verifyPeer(peerId);
      sendJson(res, 200, result);
    } catch (err) {
      sendGovernanceWriteError(res, err);
    }
    return true;
  }

  const permissionsMatch = pathname.match(
    /^\/api\/governance\/v1\/peers\/([^/]+)\/permissions$/,
  );
  if (permissionsMatch) {
    const peerId = decodeURIComponent(permissionsMatch[1]);
    if (!GOVERNANCE_PEER_ID_RE.test(peerId)) {
      sendJson(res, 400, { error: "invalid peerId" });
      return true;
    }
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      let spec: {
        peerId: string;
        skills: string[];
        topics: string[];
        customRateLimit?: number;
      };
      try {
        spec = parseGovernancePermissionsSpec(body, peerId);
      } catch (err) {
        sendJson(res, 400, {
          ok: false,
          error: err instanceof Error ? err.message : "invalid body",
        });
        return true;
      }
      try {
        const entry = await governance.setPermissions(peerId, spec);
        ctx.broadcast("governance:matrix:updated", { peerId });
        sendJson(res, 200, { ok: true, entry });
      } catch (err) {
        sendGovernanceWriteError(res, err);
      }
      return true;
    }
    if (req.method === "DELETE") {
      try {
        const removed = await governance.removePermissions(peerId);
        ctx.broadcast("governance:matrix:updated", { peerId });
        sendJson(res, 200, { ok: true, removed });
      } catch (err) {
        sendGovernanceWriteError(res, err);
      }
      return true;
    }
  }

  sendJson(res, 404, { error: "not found" });
  return true;
}

/** Attach an authenticated SSE client. Headers are set here; the body stays
 * open and is written to by the GovernanceStream until the socket closes. */
export function attachGovernanceStream(
  ctx: GovernanceContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const stream = ctx.governanceStream();
  if (!stream) {
    sendJson(res, 503, { error: "governance not initialized" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Flush the headers immediately so the client's EventSource fires
  // `open` without waiting for the first frame.
  res.flushHeaders();
  res.write("retry: 15000\n\n");
  stream.subscribe(res);
}

/** Map governance write failures to typed HTTP responses. Everything else
 * rethrows (the outer handler turns it into a 500). */
export function sendGovernanceWriteError(
  res: http.ServerResponse,
  err: unknown,
): void {  if (err instanceof AccessDeniedError) {
    sendJson(res, 403, {
      ok: false,
      error: err.message,
      kind: err.kind,
      name: err.name,
    });
    return;
  }
  if (err instanceof InvalidRateLimitError) {
    sendJson(res, 422, {
      ok: false,
      error: err.message,
      max: err.max,
    });
    return;
  }
  if (err instanceof TrustConfirmationDeniedError) {
    sendJson(res, 403, {
      ok: false,
      error: err.message,
      requiredTier: err.requiredTier,
    });
    return;
  }
  throw err;
}

/** Safe charset for a skill name (e.g. `core.ai.generateText`). */
const GOVERNANCE_SKILL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
/** Safe charset for an exposed event topic (e.g. `paint:canvasCreated`). */
const GOVERNANCE_TOPIC_RE = /^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/;

/** Extract a valid 64-hex peerId from a governance bridge payload, or null. */
export function asGovernancePeerId(payload: unknown): string | null {
  const raw = (payload ?? {}) as { peerId?: unknown };
  return typeof raw.peerId === "string" && GOVERNANCE_PEER_ID_RE.test(raw.peerId)
    ? raw.peerId
    : null;
}

/**
 * Parse and shape the `/permissions` (and `governance-ui.registerSkills`)
 * payload. `skills`/`topics` default to `[]` (omitting them clears the peer's
 * lists — explicit, not accidental); `customRateLimit` is passed through and
 * validated against {@link ABSOLUTE_MAX_RATE_LIMIT} by the matrix store, which
 * throws {@link InvalidRateLimitError} above the cap. Every listed skill/topic
 * is additionally validated against the manifest-exposed catalog by the store
 * (the intersection invariant), surfacing as {@link AccessDeniedError}.
 */
export function parseGovernancePermissionsSpec(
  body: unknown,
  peerId: string,
): {
  peerId: string;
  skills: string[];
  topics: string[];
  customRateLimit?: number;
} {
  const raw = (body ?? {}) as Record<string, unknown>;
  const skills = raw.skills === undefined ? [] : raw.skills;
  const topics = raw.topics === undefined ? [] : raw.topics;
  if (
    !Array.isArray(skills) ||
    !Array.isArray(topics) ||
    !skills.every(
      (s) => typeof s === "string" && GOVERNANCE_SKILL_RE.test(s),
    ) ||
    !topics.every(
      (t) => typeof t === "string" && GOVERNANCE_TOPIC_RE.test(t),
    )
  ) {
    throw new Error(
      "permissions expects { skills: string[], topics: string[], customRateLimit?: number }",
    );
  }
  let customRateLimit: number | undefined;
  if (raw.customRateLimit !== undefined) {
    if (typeof raw.customRateLimit !== "number") {
      throw new Error("customRateLimit must be a number");
    }
    customRateLimit = raw.customRateLimit;
  }
  return { peerId, skills, topics, customRateLimit };
}

/** Dependencies for the governance-ui operator skill bridge. */
export interface GovernanceSkillDeps {
  broker: TaskBroker;
  getGovernance(): GovernanceService;
  broadcast(event: string, payload: unknown): void;
}

/**
 * The admin HTTP bridge for the governance-ui plugin. These are
 * `httpBridgeOnly` operator skills (local operator privilege, structurally
 * never peer-facing) that the sandboxed UI reaches through the established
 * plugin bridge (`POST /api/execute`, boot token). The plugin's manifest
 * declares them as `ui.skills`; the handlers themselves are core-server-owned
 * so the UI never needs access to the governance service.
 */
export function registerGovernanceSkills(deps: GovernanceSkillDeps): void {
  const governance = deps.getGovernance;

  const register = (
    method: string,
    handler: (payload: unknown) => Promise<unknown>,
  ) => {
    deps.broker.registerSkill(
      `governance-ui.${method}`,
      async (payload) => handler(payload),
      {
        httpExposed: true,
        httpBridgeOnly: true,
        capabilityType: "action",
      },
    );
  };

  register("getCatalog", async () => governance().catalog());
  register("getTopology", async () => ({ peers: await governance().topology() }));
  register("listPermissions", async () => ({ entries: governance().matrixList() }));

  register("verifyPeer", async (payload) => {
    const peerId = asGovernancePeerId(payload);
    if (!peerId) {
      throw new Error("verifyPeer expects { peerId: <64-hex> }");
    }
    return governance().verifyPeer(peerId);
  });

  register("registerSkills", async (payload) => {
    const peerId = asGovernancePeerId(payload);
    if (!peerId) {
      throw new Error(
        "registerSkills expects { peerId: <64-hex>, skills?, topics?, customRateLimit? }",
      );
    }
    const spec = parseGovernancePermissionsSpec(payload, peerId);
    const entry = await governance().setPermissions(peerId, spec);
    deps.broadcast("governance:matrix:updated", { peerId });
    return { ok: true, entry };
  });

  register("removePermissions", async (payload) => {
    const peerId = asGovernancePeerId(payload);
    if (!peerId) {
      throw new Error("removePermissions expects { peerId: <64-hex> }");
    }
    const removed = await governance().removePermissions(peerId);
    deps.broadcast("governance:matrix:updated", { peerId });
    return { ok: true, removed };
  });
}
