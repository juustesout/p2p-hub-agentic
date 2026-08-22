import type { TaskRequest, TaskResult } from "@p2p-hub/sdk";
import {
  MAX_PAYLOAD_BYTES,
  validateObjectDepth,
  validatePayloadSize,
} from "@p2p-hub/sdk";
import type {
  AgentGate,
  RemoteAccessPolicy,
  RemoteGate,
  RemoteGateKind,
  TaskApprovalGate,
} from "./remote-access";
import {
  DEFAULT_AGENT_ACCESS_LEVEL,
  isAgentAccessLevel,
  normalizeRemoteGates,
} from "./remote-access";

/**
 * Second argument handed to a skill handler alongside the payload. Carries
 * only transport-verified facts about the *caller* — nothing caller-supplied.
 */
export interface SkillInvocationContext {
  /**
   * Transport-verified persistent peerId of the remote caller, set only on the
   * network path (`handleRemote`) and only when the transport proved it (Fase
   * 1B identity binding). Absent for local/HTTP invocations and for anonymous
   * remote callers. Never trust a caller-supplied `peerId` in the payload.
   */
  peerId?: string;
  /**
   * Auditability (A1/Slice 2): who initiated this invocation, as derived by
   * the platform from the transport-verified caller identity. `"agent"` when
   * the caller is a declared agent identity (with `agentLabel` set), `"operator"`
   * for a verified non-agent remote peer. Absent for local/HTTP/anonymous calls.
   * This is a platform verdict — never a caller-supplied field.
   */
  initiatedBy?: "operator" | "agent";
  /**
   * The declared agent label when `initiatedBy === "agent"`, so handlers can
   * distinguish human-from-agent actions in their own audit output. Absent
   * for non-agent callers.
   */
  agentLabel?: string;
}

export type SkillHandler = (
  payload: unknown,
  context?: SkillInvocationContext,
) => Promise<unknown>;

export interface SkillRegistrationOptions {
  /**
   * When true (the default), the skill is local-only: it can be invoked via
   * {@link TaskBroker.handle} but is rejected by {@link TaskBroker.handleRemote}
   * (i.e. it is never reachable over the network). Set to `false` to opt a
   * skill in to remote invocation via `wireNetworkToBroker`.
   */
  localOnly?: boolean;
  /**
   * When true, the skill may be invoked through the local HTTP bridge
   * ({@link TaskBroker.handleHttp}), e.g. by the desktop shell. Defaults to
   * false: a skill is NOT reachable over HTTP unless it explicitly opts in,
   * independent of its `localOnly` network flag. This is deny-by-default so
   * an arbitrary HTTP client can never reach a skill the author did not
   * deliberately expose.
   */
  httpExposed?: boolean;
  /**
   * Fase 2A: who may invoke this skill over the network. Without a policy, a
   * skill registered with `localOnly: false` is *denied* on the network path —
   * this is the fail-closed default (see `remote-access.ts`). A policy does
   * not opt a skill into the network; that stays `localOnly: false` plus the
   * `network:skill:*` manifest permission. The policy only authorizes callers.
   */
  remote?: RemoteAccessPolicy;
}

interface SkillRecord {
  handler: SkillHandler;
  localOnly: boolean;
  httpExposed: boolean;
  remote: RemoteAccessPolicy | undefined;
}

export interface TaskBrokerOptions {
  /**
   * Maximum number of skill handlers that may be running concurrently. A task
   * that arrives while the broker is at capacity is rejected with an error
   * result rather than queued, so a flood of network/HTTP tasks cannot exhaust
   * memory or CPU. Defaults to 100.
   */
  maxConcurrentTasks?: number;
  /**
   * Fase 2A: the gate the broker consults to evaluate `remote` policies. When
   * absent, every `verified-contact`/`access-pass` policy fails closed. The
   * host injects a gate wired to its contacts lookup and access-pass manager.
   */
  remoteGate?: RemoteGate;
  /**
   * A1/Slice 2: the gate that resolves whether a transport-verified caller
   * peerId is a declared agent identity. When absent, no caller is treated as
   * an agent and the agent policy is inert.
   */
  agentGate?: AgentGate;
  /**
   * A1/Slice 2: per-invocation human approval for agent-initiated tasks that
   * need Tier-2 step-up. When absent, an agent task that requires approval is
   * denied (fail-closed).
   */
  taskApprovalGate?: TaskApprovalGate;
}

const DEFAULT_MAX_CONCURRENT_TASKS = 100;

/**
 * Maps skill names to handlers. Skills are free-form strings; by convention
 * they are `<pluginId>.<skillName>`, but the broker itself does not enforce
 * that — the plugin loader prefixes each plugin's skills with its own id, so
 * a plugin can only ever register under its own namespace.
 *
 * Skills are local-only by default (see {@link SkillRegistrationOptions});
 * a skill is only reachable over the network if it is explicitly registered
 * with `localOnly: false`.
 */
export class TaskBroker {
  private readonly skills = new Map<string, SkillRecord>();
  private readonly maxConcurrentTasks: number;
  private readonly remoteGate: RemoteGate | undefined;
  private readonly agentGate: AgentGate | undefined;
  private readonly taskApprovalGate: TaskApprovalGate | undefined;
  private activeTasks = 0;

  constructor(options: TaskBrokerOptions = {}) {
    const max = options.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
    this.maxConcurrentTasks = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_CONCURRENT_TASKS;
    this.remoteGate = options.remoteGate;
    this.agentGate = options.agentGate;
    this.taskApprovalGate = options.taskApprovalGate;
  }

  registerSkill(
    skill: string,
    handler: SkillHandler,
    options: SkillRegistrationOptions = {},
  ): void {
    validateRemotePolicy(options.remote);
    this.skills.set(skill, {
      handler,
      localOnly: options.localOnly ?? true,
      httpExposed: options.httpExposed ?? false,
      remote: options.remote,
    });
  }

  unregisterSkill(skill: string): void {
    this.skills.delete(skill);
  }

  hasSkill(skill: string): boolean {
    return this.skills.has(skill);
  }

  /** List every registered skill with its local-only, HTTP-exposure and Fase 2A remote policy. */
  listSkills(): Array<{
    skill: string;
    localOnly: boolean;
    httpExposed: boolean;
    remote?: RemoteAccessPolicy;
  }> {
    return [...this.skills.entries()].map(([skill, record]) => ({
      skill,
      localOnly: record.localOnly,
      httpExposed: record.httpExposed,
      ...(record.remote ? { remote: record.remote } : {}),
    }));
  }

  /**
   * Execute an incoming {@link TaskRequest} on behalf of a local caller.
   * Applies no network authorization. Never throws: an unknown skill or a
   * throwing handler both resolve to a `status: "error"` {@link TaskResult}.
   */
  async handle(task: TaskRequest): Promise<TaskResult> {
    return this.execute(task, "local", undefined);
  }

  /**
   * Execute an incoming {@link TaskRequest} received from the network. Rejects
   * skills registered as `localOnly` and enforces the skill's Fase 2A `remote`
   * access policy (fail-closed: no policy → denied) using the transport-verified
   * `task.peerId` as caller identity. Never throws. This is the function to
   * hand to `provider.onTask(...)`.
   */
  async handleRemote(task: TaskRequest): Promise<TaskResult> {
    return this.execute(task, "network", task.peerId);
  }

  /**
   * Execute an incoming {@link TaskRequest} received over the local HTTP
   * bridge. Rejects skills unless they are explicitly registered with
   * `httpExposed: true`. Never throws. This is the function to call from the
   * HTTP `/api/execute` endpoint so the HTTP client is not treated as a
   * trusted in-process caller.
   */
  async handleHttp(task: TaskRequest): Promise<TaskResult> {
    return this.execute(task, "http", undefined);
  }

  private async execute(
    task: TaskRequest,
    gate: "local" | "network" | "http",
    callerPeerId: string | undefined,
  ): Promise<TaskResult> {
    const record = this.skills.get(task.skill);
    if (!record) {
      return {
        taskId: task.id,
        status: "error",
        error: `no skill registered for "${task.skill}"`,
      };
    }
    if (gate === "network" && record.localOnly) {
      return {
        taskId: task.id,
        status: "error",
        error: `skill "${task.skill}" is local-only and not network-accessible`,
      };
    }
    // A1/Slice 2: resolve whether the transport-verified caller is a declared
    // agent identity. Only the network path can carry a verified caller, and
    // only `task.peerId` (set by the transport) is consulted — never a
    // caller-supplied payload field. A throwing/failing lookup reads as "not an
    // agent"; the normal gate still applies either way.
    let agentLabel: string | undefined;
    if (gate === "network" && callerPeerId) {
      try {
        agentLabel = (await this.agentGate?.resolveAgentLabel(callerPeerId)) ?? undefined;
      } catch {
        agentLabel = undefined;
      }
    }
    if (gate === "network") {
      // Fase 2A + A1/Slice 2: the network gate (and the agent escalation
      // matrix) is evaluated here, before dispatch. A skill without an explicit
      // remote policy is denied — `localOnly: false` alone authorizes nothing.
      const allowed = await this.evaluateRemotePolicy(
        record,
        task.id,
        task.skill,
        callerPeerId,
        agentLabel,
      );
      if (!allowed) {
        return {
          taskId: task.id,
          status: "error",
          error: `skill "${task.skill}" is not authorized for this remote peer`,
        };
      }
    }
    if (gate === "http" && !record.httpExposed) {
      return {
        taskId: task.id,
        status: "error",
        error: `skill "${task.skill}" is not exposed over the HTTP bridge`,
      };
    }
    if (this.activeTasks >= this.maxConcurrentTasks) {
      return {
        taskId: task.id,
        status: "error",
        error: `broker at capacity (${this.maxConcurrentTasks} concurrent tasks)`,
      };
    }
    this.activeTasks += 1;
    try {
      validateObjectDepth(task.payload);
      const serialized = JSON.stringify(task.payload ?? null) ?? "null";
      validatePayloadSize(serialized, MAX_PAYLOAD_BYTES);
      const context: SkillInvocationContext = { peerId: callerPeerId };
      if (agentLabel !== undefined) {
        context.initiatedBy = "agent";
        context.agentLabel = agentLabel;
      } else if (gate === "network" && callerPeerId) {
        context.initiatedBy = "operator";
      }
      const result = await record.handler(task.payload, context);
      return { taskId: task.id, status: "ok", result };
    } catch (err) {
      return {
        taskId: task.id,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.activeTasks -= 1;
    }
  }

  /**
   * Evaluate a skill's Fase 2A `remote` policy for a network caller, applying
   * the A1/Slice 2 agent escalation matrix for declared agent callers. Never
   * throws (a broken gate denies rather than errors out). `any` is the only
   * gate with no proof requirement; every other gate fails closed on an
   * anonymous caller, a missing gate, or a peer the gate does not approve.
   *
   * For agent callers (`agentLabel` resolved) the matrix from plan.md applies:
   * - `any` never authorizes an agent — the public path is structurally
   *   closed to agents (Tier 3 refusal).
   * - the remaining gate(s) must still pass, and then `remote.agent.level`
   *   decides: `"telemetry"` allows without approval (Tier 1),
   *   `"approved"` (default) requires a per-invocation native approval
   *   (Tier 2, fail-closed without a confirmer), `"never"` refuses (Tier 3).
   */
  private async evaluateRemotePolicy(
    record: SkillRecord,
    taskId: string,
    skill: string,
    callerPeerId: string | undefined,
    agentLabel: string | undefined,
  ): Promise<boolean> {
    const policy = record.remote;
    if (!policy) {
      return false;
    }
    const gates = normalizeRemoteGates(policy.gate);
    if (gates.length === 0) {
      return false;
    }
    const gatePassed = await this.evaluateGates(policy, gates, callerPeerId, agentLabel);
    if (!gatePassed) {
      return false;
    }
    if (agentLabel === undefined) {
      return true;
    }
    const level = policy.agent?.level ?? DEFAULT_AGENT_ACCESS_LEVEL;
    if (level === "never") {
      return false;
    }
    if (level === "approved") {
      return this.approveAgentTask(callerPeerId as string, agentLabel, taskId, skill);
    }
    return true;
  }

  /**
   * Evaluate the skill's named gates. For an agent caller the `any` gate is
   * skipped (agents can never use the public path) and every other gate still
   * has to prove the caller. Never throws.
   */
  private async evaluateGates(
    policy: RemoteAccessPolicy,
    gates: RemoteGateKind[],
    callerPeerId: string | undefined,
    agentLabel: string | undefined,
  ): Promise<boolean> {
    for (const kind of gates) {
      if (agentLabel !== undefined && kind === "any") {
        continue;
      }
      if (kind === "any") {
        return true;
      }
      if (callerPeerId === undefined || callerPeerId.length === 0) {
        continue;
      }
      if (!this.remoteGate) {
        continue;
      }
      try {
        if (kind === "verified-contact") {
          if (await this.remoteGate.isVerifiedContact(callerPeerId)) {
            return true;
          }
        } else if (kind === "access-pass") {
          if (
            typeof policy.scope === "string" &&
            policy.scope.length > 0 &&
            (await this.remoteGate.hasValidAccessPass(callerPeerId, policy.scope))
          ) {
            return true;
          }
        }
      } catch {
        // A throwing gate must not open the door — treat as denial.
      }
    }
    return false;
  }

  /**
   * Tier 2 step-up: ask the injected {@link TaskApprovalGate} for an explicit
   * native confirmation before dispatching an agent-initiated task. Fails
   * closed: no confirmer, a confirmer that throws, or a denial all refuse.
   */
  private async approveAgentTask(
    callerPeerId: string,
    agentLabel: string,
    taskId: string,
    skill: string,
  ): Promise<boolean> {
    const approve = this.taskApprovalGate?.approveAgentTask;
    if (!approve) {
      return false;
    }
    try {
      return await approve({
        taskId,
        skill,
        agentLabel,
        peerId: callerPeerId,
      });
    } catch {
      return false;
    }
  }
}

/**
 * Validate a `remote` policy at registration time so a misconfigured policy is
 * loud at boot, not silently ineffective on the network path. Throws when an
 * `access-pass` gate is declared without a scope, or when the `agent` policy
 * names an unknown access level.
 */
function validateRemotePolicy(policy: RemoteAccessPolicy | undefined): void {
  if (!policy) {
    return;
  }
  const gates = normalizeRemoteGates(policy.gate);
  if (gates.length === 0) {
    throw new Error(
      "remote policy must name at least one gate (verified-contact, access-pass, or any)",
    );
  }
  if (gates.includes("access-pass") && typeof policy.scope !== "string") {
    throw new Error(
      'remote policy with an "access-pass" gate requires a "scope"',
    );
  }
  if (policy.agent !== undefined && !isAgentAccessLevel(policy.agent.level)) {
    throw new Error(
      `remote policy "agent" level must be one of "telemetry", "approved", "never"`,
    );
  }
}
