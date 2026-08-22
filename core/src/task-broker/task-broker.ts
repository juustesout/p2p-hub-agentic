import type { TaskRequest, TaskResult } from "@p2p-hub/sdk";
import {
  MAX_PAYLOAD_BYTES,
  validateObjectDepth,
  validatePayloadSize,
} from "@p2p-hub/sdk";
import type { RemoteAccessPolicy, RemoteGate } from "./remote-access";
import { normalizeRemoteGates } from "./remote-access";

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
  private activeTasks = 0;

  constructor(options: TaskBrokerOptions = {}) {
    const max = options.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
    this.maxConcurrentTasks = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_CONCURRENT_TASKS;
    this.remoteGate = options.remoteGate;
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
    if (gate === "network") {
      // Fase 2A: the network gate is evaluated here, before dispatch. A skill
      // without an explicit remote policy is denied — `localOnly: false` alone
      // authorizes nothing.
      const allowed = await this.evaluateRemotePolicy(record, callerPeerId);
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
      const result = await record.handler(task.payload, { peerId: callerPeerId });
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
   * Evaluate a skill's Fase 2A `remote` policy for a network caller. Never
   * throws (a broken gate denies rather than errors out). `any` is the only
   * gate with no proof requirement; every other gate fails closed on an
   * anonymous caller, a missing gate, or a peer the gate does not approve.
   */
  private async evaluateRemotePolicy(
    record: SkillRecord,
    callerPeerId: string | undefined,
  ): Promise<boolean> {
    const policy = record.remote;
    if (!policy) {
      return false;
    }
    const gates = normalizeRemoteGates(policy.gate);
    if (gates.length === 0) {
      return false;
    }
    const isAnonymous = callerPeerId === undefined || callerPeerId.length === 0;
    for (const kind of gates) {
      if (kind === "any") {
        return true;
      }
      if (isAnonymous) {
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
}

/**
 * Validate a `remote` policy at registration time so a misconfigured policy is
 * loud at boot, not silently ineffective on the network path. Throws when an
 * `access-pass` gate is declared without a scope.
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
}
