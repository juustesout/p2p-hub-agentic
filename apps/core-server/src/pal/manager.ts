/**
 * PALManager — the Brief 6 composition root that owns the *live* PAL rule set
 * and its engine lifecycle.
 *
 * Responsibilities:
 * - hydrate the rule set from the {@link PALRuleStore} (per-rule fail-safe);
 * - keep one {@link PALExecutionEngine} running over the current rule set and
 *   *rebuild* it on every `add`/`remove` (stop old subscriptions, subscribe the
 *   new set) so a change is live immediately;
 * - share one {@link PALRateLimiter} across every engine rebuild, so a rule
 *   reload never silently resets the node's execution budget (the brief's
 *   shared rate-limiter requirement);
 * - own the dispatch seam (`buildPALDispatch` → derived child identity →
 *   `TaskBroker.handleRemote`), identical to the Brief 5 wiring.
 *
 * Fail-closed: the engine is only ever built from store-validated rules, so a
 * rebuild cannot throw on malformed input (the store rejects those at
 * add-time and skips them at load-time). `stop()` is idempotent and releases
 * every engine subscription.
 */

import type { IdentityManager, TaskBroker } from "@p2p-hub/core";
import type { PALRule } from "@p2p-hub/sdk";
import { CoreEventBus } from "../events/core-event-bus";
import { logger } from "../logger";
import { PALExecutionEngine } from "./engine";
import { buildPALDispatch } from "./index";
import { PALRateLimiter, type PALRateLimitConfig } from "./rate-limiter";
import type { PALRuleStore } from "./store";

export interface PALManagerOptions {
  /** Durable rule store (reserved `sys.pal.rules` namespace). */
  store: PALRuleStore;
  /** Local domain event bus rules subscribe to. */
  eventBus: CoreEventBus;
  /** Shared TaskBroker (operator + plugins + agents all use this one). */
  broker: TaskBroker;
  /** Vault-backed identity manager used to derive each rule's child identity. */
  identityManager: IdentityManager;
  /** PAL rate-limit tuning (defaults follow Brief 5). */
  rateLimit?: PALRateLimitConfig;
}

export class PALManager {
  private readonly store: PALRuleStore;
  private readonly eventBus: CoreEventBus;
  private readonly rateLimiter: PALRateLimiter;
  private readonly dispatch: ReturnType<typeof buildPALDispatch>;
  private engine: PALExecutionEngine | null = null;
  private running = false;

  constructor(options: PALManagerOptions) {
    this.store = options.store;
    this.eventBus = options.eventBus;
    // The rate limiter outlives every engine rebuild: a rule-set reload must
    // not reset execution budgets (the shared rate-limiter requirement).
    this.rateLimiter = new PALRateLimiter(options.rateLimit);
    this.dispatch = buildPALDispatch(options.broker, options.identityManager);
  }

  /** Hydrate the store and bring the engine up over the persisted rules. */
  async start(): Promise<void> {
    await this.store.load();
    this.running = true;
    this.rebuildEngine();
  }

  /** Validated live rule set (sorted, read-only). */
  list(): readonly PALRule[] {
    return this.store.list();
  }

  get(ruleId: string): PALRule | undefined {
    return this.store.get(ruleId);
  }

  /** Add a rule (validated + persisted) and rebuild the engine. */
  async add(raw: unknown): Promise<PALRule> {
    const rule = await this.store.add(raw);
    this.rebuildEngine();
    return rule;
  }

  /** Remove a rule (persisted) and rebuild the engine. False when absent. */
  async remove(ruleId: string): Promise<boolean> {
    const removed = await this.store.remove(ruleId);
    if (removed) {
      this.rebuildEngine();
    }
    return removed;
  }

  /**
   * Graceful shutdown (Brief 6 lifecycle): stop the engine's subscriptions.
   * Idempotent; the CoreEventBus itself is torn down by the host.
   */
  stop(): void {
    this.running = false;
    if (this.engine) {
      this.engine.stop();
      this.engine = null;
    }
  }

  private rebuildEngine(): void {
    if (this.engine) {
      this.engine.stop();
    }
    this.engine = new PALExecutionEngine({
      rules: this.store.list(),
      eventBus: this.eventBus,
      rateLimiter: this.rateLimiter,
      dispatch: this.dispatch,
    });
    if (this.running) {
      this.engine.start();
    }
    logger.info(
      `[PAL] rule set rebuilt with ${this.store.list().length} active rule(s)`,
    );
  }
}
