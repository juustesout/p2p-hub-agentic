import type { TaskResult } from "../types";
import { coreBridge, resolveCoreOrigin } from "./core-bridge";

interface InboundCall {
  source: "p2p-hub-plugin";
  pluginId: string;
  requestId: string;
  serviceId: string;
  method: string;
  arguments?: unknown;
}

interface OutboundResult extends TaskResult {
  source: "p2p-hub-shell";
  requestId: string;
}

const explicitCoreOrigin = (
  import.meta as unknown as { env?: { VITE_CORE_ORIGIN?: string } }
).env?.VITE_CORE_ORIGIN;

/**
 * Origin the plugin UI iframes are loaded from. The core-server is reached
 * directly (never through the shell's own origin): keeping the iframe
 * cross-origin with the shell means a sandboxed plugin UI can never reach the
 * shell DOM, and `event.origin` stays an exact, verifiable value.
 *
 * `let`, not `const`: under the desktop shell the core-server runs as a sidecar
 * on an OS-assigned port, so this origin is synchronized to the resolved
 * backend base once `get_backend_config` reports it (see {@link syncCoreOrigin}).
 * An explicit `VITE_CORE_ORIGIN` build-time override always wins and disables
 * the sync.
 */
export let CORE_ORIGIN = explicitCoreOrigin ?? "http://127.0.0.1:8787";

let coreOriginSynced = false;

/** Resolve the sidecar's real origin once, at module load, unless overridden. */
async function syncCoreOrigin(): Promise<void> {
  if (coreOriginSynced || explicitCoreOrigin) {
    return;
  }
  coreOriginSynced = true;
  try {
    CORE_ORIGIN = await resolveCoreOrigin();
  } catch {
    // Keep the dev default; the bridge will surface an offline state.
  }
}

void syncCoreOrigin();

/**
 * The iframe URL for a plugin's bundled UI. Deliberately carries NO query
 * string and NO per-boot token: the plugin's own UI JavaScript can read
 * `location.search`, so a token in this URL would be handed to code that is
 * not trusted with it (CLAUDE.md #10). `/ui/*` is served unauthenticated by
 * the core-server; every capability call the UI makes goes over the bridge and
 * out through the shell's `Authorization: Bearer` header instead.
 */
export function pluginUiUrl(pluginId: string): string {
  return `${CORE_ORIGIN}/ui/${encodeURIComponent(pluginId)}/`;
}

/**
 * Secure postMessage bridge for plugin UI panels rendered in iframes. A plugin
 * iframe never talks to the core HTTP endpoints directly — it posts a call to
 * the shell, which checks the call against the plugin's manifest-declared
 * skill allowlist and routes it through the CoreBridge.
 *
 * Fase 2B hardening: both directions are origin-pinned. Inbound messages are
 * only accepted from {@link CORE_ORIGIN} (an exact `event.origin` equality,
 * never a prefix or `"*"`), and responses are posted back with the same
 * origin as `targetOrigin` — so a hostile page on any other origin cannot
 * forge a bridge call, and the response never leaks to one.
 */
export class PluginBridge {
  private readonly allowedSkills = new Map<string, Set<string>>();
  /**
   * Authorized `event.source` windows per pluginId. A bridge call is only
   * accepted from an iframe the shell itself bound to a plugin (via
   * {@link bindSource}); a plugin UI can never spoof another pluginId, and
   * content that is served from the same core-server origin but was never
   * bound — e.g. the `/remote-site/<peerId>` mirror viewer — can never reach
   * the bridge at all. WeakMap so a closed window is collected.
   */
  private readonly boundSources = new WeakMap<object, string>();
  private attached = false;

  /** Allow `pluginId` to invoke exactly the listed full skill names. */
  registerCapability(pluginId: string, skills: string[]): void {
    this.allowedSkills.set(pluginId, new Set(skills));
  }

  /** Bind a specific iframe window as the authorized source for `pluginId`. */
  bindSource(pluginId: string, source: MessageEventSource): void {
    this.boundSources.set(source as object, pluginId);
  }

  unregisterCapability(pluginId: string): void {
    this.allowedSkills.delete(pluginId);
  }

  /** Drop every registered capability (called when capabilities refresh). */
  clearCapabilities(): void {
    this.allowedSkills.clear();
  }

  attach(): void {
    if (this.attached) {
      return;
    }
    this.attached = true;
    window.addEventListener("message", (event) => {
      void this.onMessage(event);
    });
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    if (event.origin !== CORE_ORIGIN || !event.source) {
      return;
    }
    // Source-pinning: the caller must be an iframe window this shell bound to
    // a plugin. This is what keeps untrusted content that shares the
    // core-server origin (the mirrored remote-site viewer) out of the bridge —
    // an origin check alone is not enough when two surfaces share an origin.
    const pluginId = this.boundSources.get(event.source as object);
    if (!pluginId) {
      return;
    }
    const data = event.data as Partial<InboundCall>;
    if (data?.source !== "p2p-hub-plugin") {
      return;
    }
    const { pluginId: claimedPluginId, requestId, serviceId, method } = data;
    if (
      typeof claimedPluginId !== "string" ||
      typeof requestId !== "string" ||
      typeof serviceId !== "string" ||
      typeof method !== "string"
    ) {
      this.respond(event.source, {
        source: "p2p-hub-shell",
        requestId: requestId ?? "",
        taskId: requestId ?? "",
        status: "error",
        error: "malformed plugin bridge call",
      });
      return;
    }

    const skill = `${serviceId}.${method}`;
    const allowed = this.allowedSkills.get(pluginId);
    if (!allowed || !allowed.has(skill)) {
      this.respond(event.source, {
        source: "p2p-hub-shell",
        requestId,
        taskId: requestId,
        status: "error",
        error: `plugin "${pluginId}" is not permitted to call "${skill}"`,
      });
      return;
    }

    const result = await coreBridge.execute({
      serviceId,
      method,
      requestId,
      arguments: data.arguments,
    });
    this.respond(event.source, {
      source: "p2p-hub-shell",
      requestId,
      ...result,
    });
  }

  private respond(
    target: MessageEventSource,
    result: OutboundResult,
  ): void {
    (target as WindowProxy).postMessage(result, CORE_ORIGIN);
  }
}

export const pluginBridge = new PluginBridge();
