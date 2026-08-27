import { CoreAIProvider } from "@p2p-hub/core";
import type { TaskBroker, VaultManager } from "@p2p-hub/core";

/**
 * Register the two core skills that are owned by core-server itself:
 * `core.echo` (peer-facing smoke skill) and `core.ai.generateText` (vault-fed
 * AI capability; the raw key never leaves the vault — CLAUDE.md principle #6).
 */
export function registerCoreSkills(
  broker: TaskBroker,
  vault: VaultManager,
): void {
  broker.registerSkill(
    "core.echo",
    async (payload) => payload,
    {
      localOnly: false,
      httpExposed: true,
      remote: { gate: "any" },
      capabilityType: "action",
    },
  );

  const aiProvider = new CoreAIProvider({ vault });
  broker.registerSkill(
    "core.ai.generateText",
    async (payload) => {
      const { prompt, system, model } = (payload ?? {}) as {
        prompt?: unknown;
        system?: unknown;
        model?: unknown;
      };
      if (typeof prompt !== "string") {
        throw new Error("generateText expects { prompt: string }");
      }
      return aiProvider.generateText({
        prompt,
        system: typeof system === "string" ? system : undefined,
        model: typeof model === "string" ? model : undefined,
      });
    },
    {
      localOnly: true,
      httpExposed: true,
      capabilityType: "action",
    },
  );
}
