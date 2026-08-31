/**
 * PAL v0.1 — Peer/Agent Language. A declarative, NON-Turing-complete workflow
 * specification (Brief 5). Rules are plain JSON: no loops, no allocation, no
 * arbitrary code execution, no `eval`/`new Function`. A rule's `where:`
 * conditions reuse the shared SmartBase filter DSL (`QueryFilter` from
 * `../query/filter`) — the evaluator is imported, never re-written.
 *
 * Security invariants (CLAUDE.md, Brief 5 corrections):
 * - A rule can never execute anything itself. Its `action` is *always* a
 *   `propose_task` that must be dispatched by the host through the existing
 *   TaskBroker/Tier-2 confirm path; PAL code contains no execution primitive.
 * - `rule.id` is validated against the same identifier regex that guards
 *   manifest ids (it is later used to build derived agent labels and vault
 *   keys), so a hostile id can never become a path/vault-key component.
 * - Validation is hand-written (repo convention) on top of the shared
 *   boundary-guard primitives (`validateObjectDepth`, `validateKeyCount`) —
 *   no new schema-validation dependency.
 */

import {
  isPlainObject,
  validateKeyCount,
  validateObjectDepth,
  validateTextLength,
} from "../boundary-guard";
import { validateFilter, type QueryFilter } from "../query/filter";

/** Identifier regex for `rule.id` — the same shape manifest ids use. */
export const PAL_RULE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Max length of `rule.id`. A rule id becomes the suffix of the derived agent
 * label `pal.<id>`, which must stay within `CHILD_LABEL_RE` (max 64 chars),
 * so the id is capped at 60 here — validated at load, never at dispatch.
 */
export const PAL_RULE_ID_MAX_LENGTH = 60;

/** Identifier regex for a skill key a `propose_task` may target. */
export const PAL_SKILL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Topic-segment regex for `trigger.type` (no `:` — that is the delimiter). */
export const PAL_TRIGGER_TYPE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** Max length of a human `name` field. */
export const PAL_NAME_MAX_LENGTH = 200;

/** Which lifecycle state of the event source a rule reacts to. */
export type PALTriggerEvent = "created" | "updated" | "deleted" | "observed";

export interface PALTrigger {
  /**
   * Event-source namespace, e.g. `"invoice"`. Combined with {@link event} it
   * forms the event-bus topic `invoice:created`.
   */
  type: string;
  /** Lifecycle state the rule reacts to. */
  event: PALTriggerEvent;
}

/**
 * The only action PAL v0.1 knows: propose a task to the platform's
 * TaskBroker/Tier-2 path. `skill` is the task-broker skill key (e.g.
 * `core.ai.generateText`); `payload` is the argument object handed to the
 * skill handler.
 */
export interface PALProposeTaskAction {
  type: "propose_task";
  skill: string;
  payload: Record<string, unknown>;
}

/** Future action types (e.g. `notify`, `link_object`) are out of scope for v0.1. */
export type PALAction = PALProposeTaskAction;

export interface PALRule {
  /** Unique rule id — becomes part of the agent label (`pal.<id>`) and vault key. */
  id: string;
  /** Human-readable description (audit/confirm prompts). */
  name: string;
  trigger: PALTrigger;
  /** SmartBase filter-DSL conditions over the flat event payload. Absent = match all. */
  where?: QueryFilter;
  action: PALAction;
}

/** The event-bus topic a rule subscribes to: `<type>:<event>` (e.g. `invoice:created`). */
export function triggerTopic(trigger: PALTrigger): string {
  return `${trigger.type}:${trigger.event}`;
}

/**
 * The confirm/audit initiator tag for a PAL rule: `agent:pal.<ruleId>`.
 * Note the `.` separator: agent labels (`CHILD_LABEL_RE`) deliberately forbid
 * `:`, so the colon form from the original brief is represented dot-safe.
 */
export function palInitiator(ruleId: string): string {
  return `agent:pal.${ruleId}`;
}

/**
 * Validate and normalize an untrusted PAL rule. Throws (with the offending
 * field named) on any malformed input — a rule is rejected loudly at load,
 * never silently skipped. Depth and key counts are bounded so a pathological
 * deep rule cannot blow the stack during validation or evaluation.
 */
export function validatePALRule(input: unknown): PALRule {
  validateObjectDepth(input);
  if (!isPlainObject(input)) {
    throw new Error("PAL rule must be an object");
  }
  validateKeyCount(input);

  const id = input.id;
  if (typeof id !== "string" || !PAL_RULE_ID_RE.test(id)) {
    throw new Error(
      `PAL rule "id" must match ${PAL_RULE_ID_RE} (got ${JSON.stringify(id)})`,
    );
  }
  if (id.length > PAL_RULE_ID_MAX_LENGTH) {
    throw new Error(
      `PAL rule "id" exceeds ${PAL_RULE_ID_MAX_LENGTH} chars ` +
        `(it becomes the derived agent label "pal.<id>")`,
    );
  }

  const name = input.name;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > PAL_NAME_MAX_LENGTH
  ) {
    throw new Error(
      `PAL rule "${id}" "name" must be a non-empty string of at most ${PAL_NAME_MAX_LENGTH} chars`,
    );
  }
  validateTextLength(name, PAL_NAME_MAX_LENGTH);

  if (!isPlainObject(input.trigger)) {
    throw new Error(`PAL rule "${id}" requires a "trigger" object`);
  }
  const triggerType = input.trigger.type;
  if (
    typeof triggerType !== "string" ||
    !PAL_TRIGGER_TYPE_RE.test(triggerType)
  ) {
    throw new Error(
      `PAL rule "${id}" trigger.type must match ${PAL_TRIGGER_TYPE_RE} (no ":")`,
    );
  }
  const triggerEvent = input.trigger.event;
  if (
    typeof triggerEvent !== "string" ||
    !["created", "updated", "deleted", "observed"].includes(triggerEvent)
  ) {
    throw new Error(
      `PAL rule "${id}" trigger.event must be one of created|updated|deleted|observed`,
    );
  }

  let where: QueryFilter | undefined;
  if (input.where !== undefined) {
    where = validateFilter(input.where);
  }

  if (!isPlainObject(input.action)) {
    throw new Error(`PAL rule "${id}" requires an "action" object`);
  }
  if (input.action.type !== "propose_task") {
    throw new Error(
      `PAL rule "${id}" action.type must be "propose_task" (v0.1 supports no other action)`,
    );
  }
  const skill = input.action.skill;
  if (typeof skill !== "string" || !PAL_SKILL_RE.test(skill)) {
    throw new Error(
      `PAL rule "${id}" action.skill must match ${PAL_SKILL_RE} (got ${JSON.stringify(skill)})`,
    );
  }
  const payload = input.action.payload;
  if (!isPlainObject(payload)) {
    throw new Error(`PAL rule "${id}" action.payload must be an object`);
  }
  validateObjectDepth(payload);
  validateKeyCount(payload);
  if ("event" in payload) {
    throw new Error(
      `PAL rule "${id}" action.payload must not use the reserved key "event" ` +
        `(the engine injects the triggering event context under that name)`,
    );
  }

  return {
    id,
    name,
    trigger: { type: triggerType, event: triggerEvent as PALTriggerEvent },
    ...(where !== undefined ? { where } : {}),
    action: {
      type: "propose_task",
      skill,
      payload: { ...payload },
    },
  };
}

/**
 * Validate a full rule list. Throws on the first invalid rule (named), so a
 * misconfigured ruleset fails loudly at engine start rather than partially
 * activating. Returns a stable, normalized snapshot.
 */
export function validatePALRules(input: unknown): PALRule[] {
  if (!Array.isArray(input)) {
    throw new Error("PAL ruleset must be an array");
  }
  const seen = new Set<string>();
  return input.map((raw, index) => {
    const rule = validatePALRule(raw);
    if (seen.has(rule.id)) {
      throw new Error(`duplicate PAL rule id "${rule.id}" (index ${index})`);
    }
    seen.add(rule.id);
    return rule;
  });
}
