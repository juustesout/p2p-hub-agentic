import type { PluginContext } from "@p2p-hub/core";

export interface VaultApi {
  setSecret(key: string, value: string): Promise<void>;
  listKeys(): Promise<string[]>;
  deleteSecret(key: string): Promise<boolean>;
}

interface SetSecretPayload {
  key?: unknown;
  value?: unknown;
}

export default function activate(ctx: PluginContext): VaultApi {
  ctx.skills.register(
    "setSecret",
    async (payload) => {
      const { key, value } = (payload ?? {}) as SetSecretPayload;
      if (typeof key !== "string" || typeof value !== "string") {
        throw new Error("setSecret expects { key: string, value: string }");
      }
      await ctx.vault.setSecret(key, value);
      return { ok: true };
    },
    { localOnly: true },
  );

  ctx.skills.register(
    "listKeys",
    async () => {
      return ctx.vault.listSecretKeys();
    },
    { localOnly: true },
  );

  ctx.skills.register(
    "deleteSecret",
    async (payload) => {
      const { key } = (payload ?? {}) as SetSecretPayload;
      if (typeof key !== "string") {
        throw new Error("deleteSecret expects { key: string }");
      }
      return ctx.vault.deleteSecret(key);
    },
    { localOnly: true },
  );

  return {
    async setSecret(key, value) {
      await ctx.vault.setSecret(key, value);
    },
    async listKeys() {
      return ctx.vault.listSecretKeys();
    },
    async deleteSecret(key) {
      return ctx.vault.deleteSecret(key);
    },
  };
}
