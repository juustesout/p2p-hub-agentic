import type { TaskResult } from "../types";
import { coreBridge } from "./core-bridge";

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

/**
 * Origin the plugin UI iframes are loaded from. The core-server is reached
 * directly (never through the shell's own origin): keeping the iframe
 * cross-origin with the shell means a sandboxed plugin UI can never reach the
 * shell DOM, and `event.origin` stays an exact, verifiable value.
 */
export const CORE_ORIGIN =
  (import.meta as unknown as { env?: { VITE_CORE_ORIGIN?: string } }).env
    ?.VITE_CORE_ORIGIN ?? "http://127.0.0.1:8787";

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
  private attached = false;

  /** Allow `pluginId` to invoke exactly the listed full skill names. */
  registerCapability(pluginId: string, skills: string[]): void {
    this.allowedSkills.set(pluginId, new Set(skills));
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
    const data = event.data as Partial<InboundCall>;
    if (data?.source !== "p2p-hub-plugin") {
      return;
    }
    const { pluginId, requestId, serviceId, method } = data;
    if (
      typeof pluginId !== "string" ||
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
