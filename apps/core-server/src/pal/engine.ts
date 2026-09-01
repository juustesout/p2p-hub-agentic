/**
 * PALExecutionEngine — the v0.1 runtime for PAL (Peer/Agent Language) rules
 * (Brief 5).
 *
 * Responsibilities, strictly scoped:
 * - **Subscribe** each validated rule to its trigger topic on the
 *   {@link CoreEventBus} (`invoice:created` from `trigger.type: "invoice"` +
 *   `trigger.event: "created"`).
 * - **Evaluate** the rule's `where:` conditions with the shared SmartBase
 *   filter-DSL evaluator (`matchesRecord` from `@p2p-hub/sdk`) over the flat
 *   scalar projection of the event payload — the SDK evaluator is imported,
 *   never re-implemented (0% new parser code).
 * - **Gate** every matched execution through the {@link PALRateLimiter}
 *   (event-loop DoS protection), checked only after a where-match so a flood
 *   of *non-matching* noise can never drain a rule's budget.
 * - **Propose** by calling the injected `dispatch` seam with a typed
 *   {@link PALProposal} carrying `initiator: "agent:pal.<ruleId>"`. The engine
 *   itself contains NO execution primitive: it can never run a task, mutate
 *   storage or reach the network — the seam (wired by the host through the
 *   TaskBroker/Tier-2 path) is the only way a proposal becomes a task.
 *
 * The dispatched task payload is `{ ...rule.action.payload, event: {...} }`:
 * the engine injects a data-only `event` context (topic, timestamp and the
 * scalar field projection of the triggering payload) so a skill can act on
 * *which* object triggered the rule, without any expression/template language.
 * The `event` key is reserved and rejected by the schema validator.
 *
 * Fail-closed: an invalid ruleset throws at construction (loud, never a
 * partially-activated set); a throwing dispatch is caught and logged and never
 * crashes the bus; a missing/denied dispatch resolves to a non-ok result.
 */

import { randomUUID } from "node:crypto";
import {
  matchesRecord,
  palInitiator,
  triggerTopic,
  validatePALRules,
  type FieldValue,
  type PALRule,
} from "@p2p-hub/sdk";
import type { CoreEventBus, Disposable } from "../events/core-event-bus";
import type { PALRateLimiter } from "./rate-limiter";
import { moduleLogger } from "../logger";

/** A task the engine proposes — never executed by the engine itself. */
export interface PALProposal {
  /** Unique proposal/task id (the host may reuse it as the task id). */
  id: string;
  ruleId: string;
  ruleName: string;
  /** The exact topic that triggered the rule (e.g. `invoice:created`). */
  topic: string;
  /** The platform-set confirm/audit tag: `agent:pal.<ruleId>`. */
  initiator: string;
  /** Task-broker skill key the proposal targets. */
  skill: string;
  /** Skill arguments: `{ ...action.payload, event: { topic, at, fields } }`. */
  payload: Record<string, unknown>;
}

/** Verdict of a dispatch. `ok: false` means denied/rejected — not a throw. */
export interface PALDispatchResult {
  ok: boolean;
  detail?: string;
}

/**
 * The one seam between the engine and the world. The host wires this to its
 * TaskBroker/Tier-2 path (e.g. `broker.handleRemote` with the rule's derived
 * child peerId so the broker's agent gate recognises `initiator`).
 */
export type PALDispatch = (proposal: PALProposal) => Promise<PALDispatchResult>;

export interface PALExecutionEngineOptions {
  /** Untrusted ruleset — validated (and normalized) at construction. */
  rules: unknown;
  eventBus: CoreEventBus;
  rateLimiter: PALRateLimiter;
  dispatch: PALDispatch;
}

/** Flat scalar projection of a payload — what `where:` conditions see. */
function scalarFields(payload: Record<string, unknown>): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

export class PALExecutionEngine {
  private readonly rules: PALRule[];
  private readonly eventBus: CoreEventBus;
  private readonly rateLimiter: PALRateLimiter;
  private readonly dispatch: PALDispatch;
  private readonly subscriptions: Disposable[] = [];
  private started = false;

  constructor(options: PALExecutionEngineOptions) {
    // Fail-closed: an invalid or duplicate rule id throws here, before any
    // subscription is taken — a broken ruleset is never partially active.
    this.rules = validatePALRules(options.rules);
    this.eventBus = options.eventBus;
    this.rateLimiter = options.rateLimiter;
    this.dispatch = options.dispatch;
  }

  /** The validated, normalized ruleset (read-only; audit/tests). */
  ruleSet(): readonly PALRule[] {
    return this.rules;
  }

  /** Subscribe every rule to its trigger topic. Idempotent. */
  start(): void {
    if (this.started) {
      return;
    }
    for (const rule of this.rules) {
      const topic = triggerTopic(rule.trigger);
      const subscription = this.eventBus.subscribe(topic, (payload, event) =>
        this.handleEvent(rule, payload, event),
      );
      this.subscriptions.push(subscription);
    }
    this.started = true;
  }

  /** Unsubscribe every rule. Idempotent. */
  stop(): void {
    if (!this.started) {
      return;
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.started = false;
  }

  private async handleEvent(
    rule: PALRule,
    payload: unknown,
    event: { topic: string; at: number },
  ): Promise<void> {
    const fields = scalarFields((payload ?? {}) as Record<string, unknown>);

    // where-clause first: only a *matched* event is an execution, so a flood
    // of non-matching noise never consumes a rule's (or the node's) budget.
    if (rule.where && !matchesRecord(fields, rule.where)) {
      return;
    }

    // Event-loop DoS gate: caps executions per rule and node-wide.
    if (!this.rateLimiter.allow(rule.id)) {
      return;
    }

    const proposal: PALProposal = {
      id: `pal:${rule.id}:${randomUUID()}`,
      ruleId: rule.id,
      ruleName: rule.name,
      topic: event.topic,
      initiator: palInitiator(rule.id),
      skill: rule.action.skill,
      payload: {
        ...rule.action.payload,
        event: { topic: event.topic, at: event.at, fields },
      },
    };

    try {
      const result = await this.dispatch(proposal);
      if (!result.ok) {
        moduleLogger("pal").warn(
          `[PAL] rule "${rule.id}" proposal not dispatched: ${result.detail ?? "denied"}`,
        );
      }
    } catch (err) {
      moduleLogger("pal").warn(err, `[PAL] rule "${rule.id}" dispatch threw`);
    }
  }
}
