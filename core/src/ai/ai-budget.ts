/**
 * AI budget gate: the structural point where every AI call (text or image)
 * is checked against the node's anti-financial-DoS quota *before* any bytes
 * reach the LLM provider.
 *
 * `CoreAIProvider` (the single in-process choke point every AI call funnels
 * through) invokes an optional {@link AIBudgetGate} at the top of
 * `generateText`/`generateImage`. The gate is an injected interface, so the
 * *implementation* lives where the operator-facing budgets are configured
 * (`AIBudgetManager` in `apps/core-server/src/ai/`) while the *enforcement*
 * stays structurally attached to the choke point — a caller cannot skip the
 * check by going around a specific skill handler. A gate that refuses the
 * call throws {@link AIQuotaExceededError}; the TaskBroker turns that into a
 * typed error result (`ai-quota-exceeded`) which the HTTP bridge maps to a
 * controlled 429 without the LLM ever being invoked.
 */

/** Machine-readable code carried on a quota-refused TaskResult (→ HTTP 429). */
export const AI_QUOTA_EXCEEDED_ERROR_CODE = "ai-quota-exceeded";

/**
 * Raised when an AI call is refused because a budget is exhausted. Never
 * "wrong secret" and never a hint about how to retry — it is a rate-limit
 * verdict with a stable `code` for wire/HTTP translation.
 */
export class AIQuotaExceededError extends Error {
  readonly code = AI_QUOTA_EXCEEDED_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "AIQuotaExceededError";
  }
}

/**
 * Facts about the caller of an AI call, as derived by the platform. Only
 * transport-verified fields live here — never a caller-supplied payload
 * value. `peerId` is present on the network path only; local and HTTP-bridge
 * callers pass `undefined` and are attributed to a shared local operator key
 * by the gate.
 */
export interface AIInvocationContext {
  peerId?: string;
}

/**
 * The capability-shaped seam CoreAIProvider consults before every LLM call.
 * `consume` must throw {@link AIQuotaExceededError} (or any error) to refuse
 * the call; a normal return means the call is within budget.
 */
export interface AIBudgetGate {
  consume(context?: AIInvocationContext): void;
}
