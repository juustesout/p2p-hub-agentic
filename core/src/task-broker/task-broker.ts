import type { TaskRequest, TaskResult } from "@p2p-hub/sdk";
import {
  MAX_PAYLOAD_BYTES,
  validateObjectDepth,
  validatePayloadSize,
} from "@p2p-hub/sdk";

export type SkillHandler = (payload: unknown) => Promise<unknown>;

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
}

interface SkillRecord {
  handler: SkillHandler;
  localOnly: boolean;
  httpExposed: boolean;
}

export interface TaskBrokerOptions {
  /**
   * Maximum number of skill handlers that may be running concurrently. A task
   * that arrives while the broker is at capacity is rejected with an error
   * result rather than queued, so a flood of network/HTTP tasks cannot exhaust
   * memory or CPU. Defaults to 100.
   */
  maxConcurrentTasks?: number;
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
  private activeTasks = 0;

  constructor(options: TaskBrokerOptions = {}) {
    const max = options.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
    this.maxConcurrentTasks = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_CONCURRENT_TASKS;
  }

  registerSkill(
    skill: string,
    handler: SkillHandler,
    options: SkillRegistrationOptions = {},
  ): void {
    this.skills.set(skill, {
      handler,
      localOnly: options.localOnly ?? true,
      httpExposed: options.httpExposed ?? false,
    });
  }

  unregisterSkill(skill: string): void {
    this.skills.delete(skill);
  }

  hasSkill(skill: string): boolean {
    return this.skills.has(skill);
  }

  /** List every registered skill with its local-only and HTTP-exposure flags. */
  listSkills(): Array<{
    skill: string;
    localOnly: boolean;
    httpExposed: boolean;
  }> {
    return [...this.skills.entries()].map(([skill, record]) => ({
      skill,
      localOnly: record.localOnly,
      httpExposed: record.httpExposed,
    }));
  }

  /**
   * Execute an incoming {@link TaskRequest} on behalf of a local caller.
   * Applies no network authorization. Never throws: an unknown skill or a
   * throwing handler both resolve to a `status: "error"` {@link TaskResult}.
   */
  async handle(task: TaskRequest): Promise<TaskResult> {
    return this.execute(task, "local");
  }

  /**
   * Execute an incoming {@link TaskRequest} received from the network. Rejects
   * skills registered as `localOnly`. Never throws. This is the function to
   * hand to `provider.onTask(...)`.
   */
  async handleRemote(task: TaskRequest): Promise<TaskResult> {
    return this.execute(task, "network");
  }

  /**
   * Execute an incoming {@link TaskRequest} received over the local HTTP
   * bridge. Rejects skills unless they are explicitly registered with
   * `httpExposed: true`. Never throws. This is the function to call from the
   * HTTP `/api/execute` endpoint so the HTTP client is not treated as a
   * trusted in-process caller.
   */
  async handleHttp(task: TaskRequest): Promise<TaskResult> {
    return this.execute(task, "http");
  }

  private async execute(
    task: TaskRequest,
    gate: "local" | "network" | "http",
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
      const result = await record.handler(task.payload);
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
}
