import * as http from "node:http";
import { isPlainObject } from "@p2p-hub/sdk";
import type { HelpCenterService } from "../help-center/service";
import { readJsonBody, sendJson } from "./helpers";

/**
 * HelpCenter operator routes (`/api/help/*`) — Brief 7D.
 *
 * Three surfaces, all behind the uniform `/api` token gate:
 * - `GET /api/help/support` — the baked-in support contact. `configured: false`
 *   (no peerId) when the operator has not supplied a support identity, so the
 *   shell's chat tab can fail closed instead of addressing nobody.
 * - `GET /api/help/agent/status` — whether the AI provider is configured (the
 *   shell hides the help-agent tab when it is not).
 * - `POST /api/help/agent/ask` — one read-only question; the agent answers from
 *   the local docs corpus + server state and returns a *proposal* (answer +
 *   steps for the operator to take themselves). Domain failures (no AI, quota,
 *   unreachable provider) are typed results in the body, never raw throws.
 *
 * These routes deliberately do NOT hand the agent any capability beyond
 * reading docs + state: there is no skill dispatch, no vault read, no execute.
 */

export interface HelpCenterContext {
  service: HelpCenterService;
}

export async function serveHelpCenter(
  ctx: HelpCenterContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method === "GET" && pathname === "/api/help/support") {
    sendJson(res, 200, { ok: true, support: ctx.service.support() });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/help/agent/status") {
    sendJson(res, 200, { ok: true, ...(await ctx.service.status()) });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/help/agent/ask") {
    const body = await readJsonBody(req);
    if (!isPlainObject(body)) {
      sendJson(res, 400, { ok: false, error: "expected a JSON body" });
      return true;
    }
    const result = await ctx.service.ask(body.question);
    if (!result.ok) {
      sendJson(res, 200, {
        ok: false,
        code: result.error.code,
        detail: result.error.detail,
      });
      return true;
    }
    sendJson(res, 200, { ok: true, proposal: result.proposal });
    return true;
  }

  return false;
}
