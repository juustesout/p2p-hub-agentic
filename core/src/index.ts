export * from "./network-registry";
export * from "./storage/scoped-storage";
export * from "./storage/storage-manager";
export * from "./storage/vault-manager";
export * from "./storage/atomic";
export * from "./storage/backup";
export * from "./storage/queue";
export * from "./hooks/hook-registry";
export * from "./ai/core-ai-provider";
export * from "./plugin-loader/plugin-context";
export * from "./plugin-loader/plugin-loader";
export * from "./plugin-host/plugin-host";
export * from "./task-broker/task-broker";
export * from "./task-broker/wire-network";

import { IdentityManager } from "./identity/identity-manager";

/**
 * Standalone proof-of-possession verifier. Re-exported so consumers (plugins)
 * can verify a peer's signature without being handed the {@link IdentityManager}
 * instance that owns the local private key — the same capability-boundary
 * pattern used for `ctx.ai`/`ctx.vault`. The private key never leaves
 * `IdentityManager`; only this stateless verify function is public.
 */
export function verifyIdentitySignature(
  publicKeyHex: string,
  data: Buffer,
  signature: Buffer,
): boolean {
  return IdentityManager.verify(publicKeyHex, data, signature);
}
