export * from "./network-registry";
export * from "./disposable";
export * from "./network";
export * from "./security";
export * from "./certification";
export * from "./events";
export * from "./storage/scoped-storage";
export * from "./storage/storage-manager";
export * from "./storage/vault-manager";
export * from "./storage/atomic-write";
export * from "./storage/queue";
export * from "./hooks/hook-registry";
export * from "./ai/core-ai-provider";
export * from "./plugin-loader/plugin-context";
export * from "./plugin-loader/plugin-loader";
export * from "./plugin-host/plugin-host";
export * from "./task-broker/task-broker";
export * from "./task-broker/wire-network";
export * from "./task-broker/remote-access";
export * from "./task-broker/access-pass-manager";
export * from "./identity/peer-auth";
export * from "./agent/agent-runtime";
export * from "./site/site-files";
export * from "./site/site-mirror";
export * from "./test-support";

import { IdentityManager } from "./identity/identity-manager";
import { isValidChildLabel } from "./identity/child-identity";

/**
 * Re-export the identity manager class so a second node (own vault → own
 * persistent keypair) can be constructed in tests and tooling. `loadPlugin`
 * already exposes it as a parameter type, so this is the same surface, just
 * importable from the package root instead of a deep path.
 */
export { IdentityManager } from "./identity/identity-manager";

/**
 * Validate an agent label before it is used as a vault key/URL segment for a
 * derived agent identity. Re-exported so the HTTP bridge can reject a malformed
 * label with a clean 4xx before any vault write happens — the label becomes a
 * key under the reserved `identity.agent.*` namespace, so it must pass the same
 * check the derivation itself enforces (delimiter-anchored, per CLAUDE.md
 * principle #2).
 */
export function isValidAgentLabel(label: string): boolean {
  return isValidChildLabel(label);
}

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
