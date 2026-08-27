import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { TrustConfirmationDeniedError, TrustTierGate, isValidAgentLabel } from "@p2p-hub/core";
import type { PluginHost, TaskBroker } from "@p2p-hub/core";
import type { NetworkLightProvider } from "@p2p-hub/network-light";
import {
  asContactLookup,
  evaluateSettingsRisk,
  isPlainObject,
  normalizeSettings,
} from "@p2p-hub/sdk";
import type {
  ChildCertificate,
  ChildIdentity,
  EffectiveSettings,
  RiskAssessment,
  TaskResult,
} from "@p2p-hub/sdk";
import {
  DEFAULT_BRIDGED_EVENTS,
  IDENTIFIER_RE,
  PEER_ID_RE,
  readJsonBody,
  sendJson,
} from "./helpers";

/** Everything the operator `/api/*` routes need from the CoreServer. */
export interface OperatorContext {
  host: PluginHost;
  broker: TaskBroker;
  provider(): NetworkLightProvider | null;
  trustGate: TrustTierGate;
  broadcast(event: string, payload: unknown): void;
  loadSettings(): Promise<EffectiveSettings>;
  saveSettings(settings: EffectiveSettings): Promise<void>;
}

interface ExecuteBody {
  peerId?: string;
  serviceId: string;
  method: string;
  requestId?: string;
  arguments?: unknown;
}

/**
 * The remaining operator `/api/*` surface (everything that is not the
 * governance API): health, capabilities, skill execution, the vault bridge,
 * settings persistence and agent identity management. Every route here runs
 * after the global `/api` boot-token gate in the dispatcher.
 */
export async function serveOperator(
  ctx: OperatorContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/")) {
    return false;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, uptime: process.uptime() });
    return true;
  }
  if (req.method === "GET" && pathname === "/api/capabilities") {
    sendJson(res, 200, await buildCapabilities(ctx));
    return true;
  }
  if (req.method === "POST" && pathname === "/api/execute") {
    const body = (await readJsonBody(req)) as ExecuteBody;
    sendJson(res, 200, await execute(ctx, body));
    return true;
  }
  if (req.method === "GET" && pathname === "/api/vault/keys") {
    const vault = ctx.host.vaultManager();
    sendJson(res, 200, {
      keys: await vault.listSecretMetadata(),
      masterKeyConfigured: !vault.usesFallbackKey,
    });
    return true;
  }
  if (req.method === "GET" && pathname === "/api/vault/model") {
    const vault = ctx.host.vaultManager();
    const hasModel = await vault.hasSecret("ai.model");
    const hasBaseUrl = await vault.hasSecret("ai.baseUrl");
    const hasApiKey = await vault.hasSecret("ai.apiKey");
    sendJson(res, 200, { hasModel, hasBaseUrl, hasApiKey });
    return true;
  }
  if (req.method === "POST" && pathname === "/api/vault/set") {
    const body = (await readJsonBody(req)) as { key?: unknown; value?: unknown };
    if (typeof body.key !== "string" || typeof body.value !== "string") {
      sendJson(res, 400, {
        ok: false,
        error: "set expects { key: string, value: string }",
      });
      return true;
    }
    const reserved = reservedPrefixFor(ctx, body.key);
    if (reserved) {
      sendJson(res, 403, {
        ok: false,
        error: `vault key "${body.key}" is in the reserved namespace "${reserved}" and cannot be modified over HTTP`,
      });
      return true;
    }
    await ctx.host.vaultManager().setSecret(body.key, body.value);
    ctx.broadcast("vault:updated", { key: body.key, action: "set" });
    sendJson(res, 200, { ok: true, key: body.key });
    return true;
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/vault/")) {
    const key = decodeURIComponent(pathname.slice("/api/vault/".length));
    const reserved = reservedPrefixFor(ctx, key);
    if (reserved) {
      sendJson(res, 403, {
        ok: false,
        error: `vault key "${key}" is in the reserved namespace "${reserved}" and cannot be modified over HTTP`,
      });
      return true;
    }
    const deleted = await ctx.host.vaultManager().deleteSecret(key);
    ctx.broadcast("vault:updated", { key, action: "delete" });
    sendJson(res, 200, { ok: true, deleted });
    return true;
  }
  if (req.method === "GET" && pathname === "/api/settings") {
    const settings = await ctx.loadSettings();
    sendJson(res, 200, {
      settings,
      risk: evaluateSettingsRisk(settings),
    });
    return true;
  }
  if (req.method === "POST" && pathname === "/api/settings/apply") {
    const body = await readJsonBody(req);
    if (!isPlainObject(body)) {
      sendJson(res, 400, {
        ok: false,
        error: "apply expects a settings object",
      });
      return true;
    }
    const settings = normalizeSettings(body);
    const risk = evaluateSettingsRisk(settings);
    try {
      await ctx.trustGate.authorize(risk.aggregate, settingsApplySummary(risk), {
        authenticated: true,
      });
    } catch (err) {
      if (err instanceof TrustConfirmationDeniedError) {
        sendJson(res, 403, {
          ok: false,
          error: "confirmation required",
          requiredTier: err.requiredTier,
        });
        return true;
      }
      throw err;
    }
    await ctx.saveSettings(settings);
    ctx.broadcast("settings:updated", { settings, risk });
    sendJson(res, 200, { ok: true, risk });
    return true;
  }
  if (req.method === "GET" && pathname === "/api/agents") {
    const agents: unknown[] = [];
    for (const { label } of await ctx.host
      .identityManager()
      .listChildIdentities()) {
      const child = await ctx.host.identityManager().getChildIdentity(label);
      if (child) {
        agents.push(agentView(child));
      }
    }
    sendJson(res, 200, { agents });
    return true;
  }
  if (req.method === "POST" && pathname === "/api/agents") {
    const body = (await readJsonBody(req)) as { label?: unknown };
    if (typeof body.label !== "string" || !isValidAgentLabel(body.label)) {
      sendJson(res, 400, {
        ok: false,
        error: "create expects a valid agent label (^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$)",
      });
      return true;
    }
    const child = await ctx.host
      .identityManager()
      .deriveChildIdentity(body.label);
    sendJson(res, 200, { ok: true, agent: agentView(child) });
    return true;
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/agents/")) {
    const label = decodeURIComponent(pathname.slice("/api/agents/".length));
    if (!isValidAgentLabel(label)) {
      sendJson(res, 400, {
        ok: false,
        error: `invalid agent label "${label}"`,
      });
      return true;
    }
    const deleted = await ctx.host
      .identityManager()
      .deleteChildIdentity(label);
    sendJson(res, 200, { ok: true, deleted });
    return true;
  }

  sendJson(res, 404, { error: "not found" });
  return true;
}

/** The full capability view the shell uses to render plugins/skills/peers. */
export async function buildCapabilities(ctx: OperatorContext): Promise<unknown> {
  const plugins = ctx.host.listPlugins().map((p) => ({
    id: p.id,
    name: p.name ?? p.id,
    kind: p.kind,
    version: p.version,
    // Fase 2B: manifest-declared UI surface. `skills` is the bridge allowlist
    // the shell must register — never derived from the full skill list.
    ui: p.ui
      ? {
          entry: p.ui.entry,
          defaultWidth: p.ui.defaultWidth,
          defaultHeight: p.ui.defaultHeight,
          skills: p.ui.skills ?? [],
        }
      : null,
  }));

  const skills = ctx.broker.listSkills().map((s) => ({
    skill: s.skill,
    localOnly: s.localOnly,
    httpExposed: s.httpExposed,
    httpBridgeOnly: s.httpBridgeOnly,
    capabilityType: s.capabilityType,
    pluginId: s.skill.split(".")[0] ?? "",
  }));

  const events = new Set<string>(DEFAULT_BRIDGED_EVENTS);
  for (const plugin of ctx.host.listPlugins()) {
    for (const event of plugin.exposedEvents ?? []) {
      events.add(event);
    }
  }
  events.add("peer:connected");
  events.add("peer:disconnected");
  events.add("task:started");
  events.add("task:completed");
  events.add("vault:updated");

  // Same duck-typed contacts read-seam the host's peer-access context uses
  // (Fase 2A): distinguish verified contacts from anonymous/self-signed peers
  // so the shell can render per-peer trust instead of assuming everyone is
  // equal.
  const contacts = asContactLookup(ctx.host.getActivated("contacts"));
  const provider = ctx.provider();
  const peers = provider
    ? await Promise.all(
        provider.listPeers().map(async (peer) => {
          let trust = "self-signed";
          if (peer.peerId && contacts) {
            const info = await contacts.getContact(peer.peerId);
            if (info?.trustState === "verified") {
              trust = "verified";
            }
          }
          return {
            id: peer.id,
            peerId: peer.peerId ?? null,
            name: peer.name ?? peer.id,
            address: peer.address,
            skills: peer.skills,
            transport: provider.id,
            trust,
          };
        }),
      )
    : [];

  return {
    local: {
      plugins,
      skills,
      events: [...events],
      connection: {
        providerId: provider?.id ?? null,
        ready: provider?.isReady() ?? false,
      },
    },
    remote: { peers },
  };
}

/** Execute a skill request locally or against a remote peer. */
export async function execute(
  ctx: OperatorContext,
  body: ExecuteBody,
): Promise<TaskResult> {
  const id =
    typeof body.requestId === "string" && body.requestId.length > 0
      ? body.requestId
      : randomUUID();

  const { serviceId, method } = body;
  if (
    typeof serviceId !== "string" ||
    typeof method !== "string" ||
    !IDENTIFIER_RE.test(serviceId) ||
    !IDENTIFIER_RE.test(method)
  ) {
    return {
      taskId: id,
      status: "error",
      error: "execute expects serviceId and method as safe identifier strings",
    };
  }
  if (
    body.peerId !== undefined &&
    (typeof body.peerId !== "string" || !PEER_ID_RE.test(body.peerId))
  ) {
    return {
      taskId: id,
      status: "error",
      error: "execute expects peerId as a safe identifier string",
    };
  }

  const skill = `${serviceId}.${method}`;

  ctx.broadcast("task:started", {
    requestId: id,
    serviceId,
    method,
    peerId: body.peerId ?? null,
  });

  const result = body.peerId
    ? await executeRemote(ctx, body.peerId, skill, id, body.arguments)
    : await ctx.broker.handleHttp({ id, skill, payload: body.arguments });

  ctx.broadcast("task:completed", {
    requestId: id,
    serviceId,
    method,
    peerId: body.peerId ?? null,
    status: result.status,
  });

  return result;
}

/** Send a task to a remote peer over the active network provider. */
export async function executeRemote(
  ctx: OperatorContext,
  peerId: string,
  skill: string,
  id: string,
  args: unknown,
): Promise<TaskResult> {
  const provider = ctx.provider();
  if (!provider) {
    return { taskId: id, status: "error", error: "no active network provider" };
  }
  const peers = provider.listPeers();
  // Resolve by the persistent `peerId` (identity) first — the same concept
  // `ctx.network.sendTask` uses — and fall back to the per-boot instance
  // `id` for clients that still address peers by session id.
  const peer =
    peers.find((p) => p.peerId === peerId) ??
    peers.find((p) => p.id === peerId);
  if (!peer) {
    return { taskId: id, status: "error", error: `unknown peer "${peerId}"` };
  }
  return provider.sendTask(peer, { id, skill, payload: args });
}

/**
 * Return the reserved namespace a key falls into (e.g. `ai.`), or null when
 * the key is writable. This mirrors the `assertWritable` guard the plugin
 * loader enforces on the plugin-facing {@link VaultContext}; the HTTP client
 * must not be able to rewrite the AI key/endpoint that core later uses.
 */
function reservedPrefixFor(ctx: OperatorContext, key: string): string | null {
  const reserved = ctx.host.vaultManager().reservedPrefixes;
  return reserved.find((p) => key.startsWith(p)) ?? null;
}

/** Human-readable summary shown to the native tier-2 confirmation prompt. */
function settingsApplySummary(risk: RiskAssessment): string {
  if (risk.findings.length === 0) {
    return "Apply security settings (no known risks)";
  }
  return `Apply security settings (${risk.aggregate}): ${risk.findings
    .map((f) => f.id)
    .join(", ")}`;
}

/**
 * Public view of a derived agent identity for the `/api/agents` surface. Only
 * public material is exposed: the peerId, the public key, the operator-signed
 * certificate and its `issuedAt`. The private key never leaves
 * `IdentityManager` — it is structurally absent from this view (CLAUDE.md
 * principle #6).
 */
function agentView(child: ChildIdentity): {
  label: string;
  peerId: string;
  publicKeyHex: string;
  certificate: ChildCertificate;
  createdAt: number;
} {
  return {
    label: child.label,
    peerId: child.peerId,
    publicKeyHex: child.publicKeyHex,
    certificate: child.certificate,
    createdAt: child.certificate.issuedAt,
  };
}
