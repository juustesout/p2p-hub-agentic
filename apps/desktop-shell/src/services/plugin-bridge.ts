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
 * Secure postMessage bridge for plugin UI panels rendered in iframes. A plugin
 * iframe never talks to the core HTTP endpoints directly — it posts a call to
 * the shell, which checks the call against the plugin's registered skills and
 * routes it through the CoreBridge.
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
    target: MessageEventSource | null,
    result: OutboundResult,
  ): void {
    if (target && "postMessage" in target) {
      (target as WindowProxy).postMessage(result, "*");
    }
  }
}

export const pluginBridge = new PluginBridge();
