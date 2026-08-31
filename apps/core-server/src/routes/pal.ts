import * as http from "node:http";
import { PAL_RULE_ID_RE } from "@p2p-hub/sdk";
import type { TaskBroker } from "@p2p-hub/core";
import type { PALManager } from "../pal/manager";
import {
  DuplicatePALRuleError,
  InvalidPALRuleError,
} from "../pal/store";
import { readJsonBody, sendJson } from "./helpers";

/**
 * Everything the PAL routes need from the CoreServer. Deliberately narrow —
 * the routes never reach for the whole server object.
 */
export interface PalContext {
  pal(): PALManager | null;
}

/** URL prefix under which the Brief 6 PAL rules API is mounted. */
export const PAL_PREFIX = "/api/pal/rules";

/**
 * Brief 6 — local-only PAL rule management. Mounted under `/api/` so the
 * existing boot-token gate applies before any handler runs. This surface is
 * structurally local-only: it is an HTTP bridge route (a local operator
 * privilege, reachable only with the per-boot token), and the peer-facing
 * equivalents (`pal-ui.*`, registered via {@link registerPalSkills}) are
 * `httpBridgeOnly` — the TaskBroker denies any remote caller with an explicit
 * `local-only and not network-accessible` verdict, so an external P2P peer can
 * never add/remove/list rules (CLAUDE.md: a LAN peer and a local HTTP client
 * are different threat models — rule management is denied to the peer one).
 */
export async function servePal(
  ctx: PalContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith(PAL_PREFIX)) {
    return false;
  }
  const pal = ctx.pal();
  if (!pal) {
    sendJson(res, 503, { error: "pal not initialized" });
    return true;
  }

  if (req.method === "GET" && pathname === PAL_PREFIX) {
    sendJson(res, 200, { rules: pal.list() });
    return true;
  }

  if (req.method === "POST" && pathname === PAL_PREFIX) {
    const body = await readJsonBody(req);
    try {
      const rule = await pal.add(body);
      sendJson(res, 200, { ok: true, rule });
    } catch (err) {
      if (err instanceof InvalidPALRuleError) {
        sendJson(res, 422, { ok: false, error: err.message });
        return true;
      }
      if (err instanceof DuplicatePALRuleError) {
        sendJson(res, 409, { ok: false, error: err.message });
        return true;
      }
      throw err;
    }
    return true;
  }

  const match = pathname.match(/^\/api\/pal\/rules\/([^/]+)$/);
  if (match && req.method === "DELETE") {
    const ruleId = decodeURIComponent(match[1]);
    if (!PAL_RULE_ID_RE.test(ruleId)) {
      sendJson(res, 400, { error: "invalid rule id" });
      return true;
    }
    const removed = await pal.remove(ruleId);
    sendJson(res, 200, { ok: true, removed });
    return true;
  }

  sendJson(res, 404, { error: "not found" });
  return true;
}

/**
 * Dependencies for the pal-ui operator skill bridge.
 */
export interface PalSkillDeps {
  broker: TaskBroker;
  getPal(): PALManager;
}

/**
 * The operator bridge for PAL rule management, mirroring the governance-ui
 * pattern. These are `httpBridgeOnly` operator skills (a local operator
 * privilege, structurally never peer-facing — see the doc on {@link servePal});
 * the desktop shell reaches them through the established plugin bridge
 * (`POST /api/execute`, boot token). A remote P2P caller that tries any of
 * them is denied by the TaskBroker with an explicit
 * `local-only and not network-accessible` verdict.
 */
export function registerPalSkills(deps: PalSkillDeps): void {
  const register = (
    method: string,
    handler: (payload: unknown) => Promise<unknown>,
  ) => {
    deps.broker.registerSkill(
      `pal-ui.${method}`,
      async (payload) => handler(payload),
      {
        httpExposed: true,
        httpBridgeOnly: true,
        capabilityType: "action",
      },
    );
  };

  register("listRules", async () => ({ rules: deps.getPal().list() }));

  register("addRule", async (payload) => {
    const rule = await deps.getPal().add(payload);
    return { ok: true, rule };
  });

  register("removeRule", async (payload) => {
    const raw = (payload ?? {}) as { ruleId?: unknown };
    if (typeof raw.ruleId !== "string" || !PAL_RULE_ID_RE.test(raw.ruleId)) {
      throw new Error("removeRule expects { ruleId: <safe identifier> }");
    }
    const removed = await deps.getPal().remove(raw.ruleId);
    return { ok: true, removed };
  });
}
