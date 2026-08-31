/**
 * PAL wiring — the composition root that turns a validated PAL rule set into a
 * running engine whose proposals travel the platform's existing
 * TaskBroker/Tier-2 path (Brief 5: "no new execution path").
 *
 * The dispatch seam is wired to `TaskBroker.handleRemote` with the rule's
 * *derived child identity* as the transport-verified caller:
 *
 * - `IdentityManager.deriveChildIdentity("pal.<ruleId>")` gives the rule its
 *   own derived agent identity (CLAUDE.md A1: an agent always has its own
 *   identity, never the operator's). The label form uses `.` — `:` is not
 *   legal in a child label.
 * - `handleRemote` is the platform's own transport→broker seam (the same one
 *   `wireNetworkToBroker` hands `provider.onTask` to), so the broker's agent
 *   gate resolves the peerId → `agentLabel: "pal.<ruleId>"`, applies the
 *   skill's `remote` policy + the A1 agent escalation matrix (`never` /
 *   `approved` / `telemetry`), runs the Tier-2 native approval
 *   (`taskApprovalGate.approveAgentTask`, fail-closed when absent), and the
 *   skill handler receives `initiatedBy: "agent"` + `agentLabel`.
 *
 * A skill must therefore be network-reachable (`localOnly: false`) with a
 * `remote` policy declaring how agents may invoke it — PAL can never bypass
 * the manifest/permission layer, by construction.
 */

import type { IdentityManager, TaskBroker } from "@p2p-hub/core";
import { logger } from "../logger";
import { CoreEventBus } from "../events/core-event-bus";
import { PALRateLimiter, type PALRateLimitConfig } from "./rate-limiter";
import {
  PALExecutionEngine,
  type PALDispatch,
  type PALProposal,
} from "./engine";

/** Child-label prefix for every PAL rule identity. */
export const PAL_AGENT_LABEL_PREFIX = "pal.";

export interface PALWiringOptions {
  /** Untrusted ruleset — validated (and normalized) when the engine is built. */
  rules: unknown;
  /** The shared TaskBroker (operator + plugins + agents all use this one). */
  broker: TaskBroker;
  /** Vault-backed identity manager used to derive each rule's child identity. */
  identityManager: IdentityManager;
  /** Event bus PAL rules listen on. */
  eventBus: CoreEventBus;
  /** PAL rate-limit tuning (defaults follow Brief 5). */
  rateLimit?: PALRateLimitConfig;
}

export interface PALRuntime {
  engine: PALExecutionEngine;
  rateLimiter: PALRateLimiter;
  /** Map every validated rule id to its derived agent label (`pal.<id>`). */
  agentLabel(ruleId: string): string;
  stop(): void;
}

/** Build the dispatch seam: derive the rule's child identity, then broker.handleRemote. */
export function buildPALDispatch(
  broker: TaskBroker,
  identityManager: IdentityManager,
): PALDispatch {
  return async (proposal: PALProposal) => {
    const label = `${PAL_AGENT_LABEL_PREFIX}${proposal.ruleId}`;
    let peerId: string;
    try {
      const identity = await identityManager.deriveChildIdentity(label);
      peerId = identity.peerId;
    } catch (err) {
      logger.warn(err, `[PAL] rule "${proposal.ruleId}" child identity derivation failed`);
      return { ok: false, detail: "identity-derivation-failed" };
    }
    const result = await broker.handleRemote({
      id: proposal.id,
      skill: proposal.skill,
      payload: proposal.payload,
      peerId,
    });
    return {
      ok: result.status === "ok",
      detail: result.status === "ok" ? undefined : result.error,
    };
  };
}

/**
 * Assemble bus + limiter + engine for a ruleset. Returns the runtime plus the
 * derived label mapping. The ruleset is validated at construction (throws
 * loudly on any malformed rule — nothing is partially activated).
 */
export function createPALRuntime(options: PALWiringOptions): PALRuntime {
  const rateLimiter = new PALRateLimiter(options.rateLimit);
  const dispatch = buildPALDispatch(options.broker, options.identityManager);
  const engine = new PALExecutionEngine({
    rules: options.rules,
    eventBus: options.eventBus,
    rateLimiter,
    dispatch,
  });
  return {
    engine,
    rateLimiter,
    agentLabel: (ruleId) => `${PAL_AGENT_LABEL_PREFIX}${ruleId}`,
    stop: () => engine.stop(),
  };
}

/** Re-exported for callers that only need the primitives. */
export { CoreEventBus, PALExecutionEngine, PALRateLimiter };
export type { PALProposal, PALDispatchResult } from "./engine";

/** Brief 6 — rule persistence + live rule-set manager. */
export { PALRuleStore, palRulesFile, InvalidPALRuleError, DuplicatePALRuleError } from "./store";
export type { PALRuleStoreOptions } from "./store";
export { PALManager } from "./manager";
export type { PALManagerOptions } from "./manager";
