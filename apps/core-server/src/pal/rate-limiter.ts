/**
 * PALRateLimiter — event-loop DoS protection for PAL rule execution (Brief 5).
 *
 * Distinguishes the two DoS dimensions the platform already separates:
 * - **AI-token DoS** is capped by the AI budget gate (`AIBudgetManager`, PR #6);
 * - **event-loop DoS** — a flood of events (buggy or hostile event source)
 *   that would evaluate rules and dispatch proposals *without ever touching
 *   the LLM* — is capped here.
 *
 * A thin, typed wrapper around the existing {@link FixedWindowLimiter} (no new
 * limiter implementation): every rule has its own rolling budget, and every
 * dispatch also draws from a node-wide budget so an operator's rule set cannot
 * aggregate past the node ceiling either. A refused rule logs the exact
 * acceptance-criterion sentence and is *not* recorded, so a flood of refusals
 * never extends the window.
 */

import { logger } from "../logger";
import { FixedWindowLimiter } from "../fixed-window";

export interface PALRateLimitConfig {
  /** Per-rule cap: at most `limit` executions per rolling `windowMs`. */
  perRule?: { limit: number; windowMs: number };
  /** Node-wide cap across all rules per rolling `windowMs`. */
  global?: { limit: number; windowMs: number };
  /** Log sink for refusal messages (defaults to the core-server logger). */
  log?: (message: string) => void;
}

/** Default per-rule budget: 30 executions per rolling hour (brief's default). */
export const DEFAULT_PAL_PER_RULE_LIMIT = 30;
export const DEFAULT_PAL_PER_RULE_WINDOW_MS = 60 * 60 * 1000;

/** Default node-wide budget: 100 executions per rolling minute (brief's default). */
export const DEFAULT_PAL_GLOBAL_LIMIT = 100;
export const DEFAULT_PAL_GLOBAL_WINDOW_MS = 60 * 1000;

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

export class PALRateLimiter {
  private readonly perRuleLimit: number;
  private readonly perRuleWindowMs: number;
  private readonly globalLimiter: FixedWindowLimiter;
  private readonly perRule = new Map<string, FixedWindowLimiter>();
  private readonly log: (message: string) => void;

  constructor(config: PALRateLimitConfig = {}) {
    this.perRuleLimit = positiveInt(config.perRule?.limit, DEFAULT_PAL_PER_RULE_LIMIT);
    this.perRuleWindowMs = positiveInt(
      config.perRule?.windowMs,
      DEFAULT_PAL_PER_RULE_WINDOW_MS,
    );
    const globalLimit = positiveInt(config.global?.limit, DEFAULT_PAL_GLOBAL_LIMIT);
    const globalWindowMs = positiveInt(
      config.global?.windowMs,
      DEFAULT_PAL_GLOBAL_WINDOW_MS,
    );
    this.globalLimiter = new FixedWindowLimiter(globalLimit, globalWindowMs);
    this.log = config.log ?? ((message) => logger.warn(message));
  }

  /**
   * Record and allow one rule execution, or refuse it. Both the rule's own
   * budget and the node-wide budget must pass. Refusals are checked
   * WITHOUT recording, so a refused call consumes no slot in either window;
   * the verdict is logged with the exact acceptance-criterion sentence.
   */
  allow(ruleId: string): boolean {
    const ruleLimiter = this.windowFor(ruleId);
    if (!ruleLimiter.wouldAllow()) {
      this.log(`[PAL] Rate limit exceeded for rule ${ruleId}, execution suppressed`);
      return false;
    }
    if (!this.globalLimiter.wouldAllow()) {
      this.log(
        `[PAL] Rate limit exceeded for rule ${ruleId}, execution suppressed ` +
          `(node-wide budget exhausted)`,
      );
      return false;
    }
    // Both budgets have room — record in each and dispatch.
    ruleLimiter.allow();
    this.globalLimiter.allow();
    return true;
  }

  /** Recorded executions for a rule in its current window (read-only). */
  ruleUsage(ruleId: string): number {
    return this.windowFor(ruleId).count();
  }

  /** Drop all budget state (tests and rule-set reloads). */
  reset(): void {
    this.perRule.clear();
    this.globalLimiter.reset();
  }

  private windowFor(ruleId: string): FixedWindowLimiter {
    let limiter = this.perRule.get(ruleId);
    if (!limiter) {
      limiter = new FixedWindowLimiter(this.perRuleLimit, this.perRuleWindowMs);
      this.perRule.set(ruleId, limiter);
    }
    return limiter;
  }
}
