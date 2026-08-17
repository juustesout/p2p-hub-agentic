import type { TaskRequest, TaskResult } from "@p2p-hub/sdk";

export type SkillHandler = (payload: unknown) => Promise<unknown>;

export interface SkillRegistrationOptions {
  /**
   * When true (the default), the skill is local-only: it can be invoked via
   * {@link TaskBroker.handle} but is rejected by {@link TaskBroker.handleRemote}
   * (i.e. it is never reachable over the network). Set to `false` to opt a
   * skill in to remote invocation via `wireNetworkToBroker`.
   */
  localOnly?: boolean;
}

interface SkillRecord {
  handler: SkillHandler;
  localOnly: boolean;
}

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

  registerSkill(
    skill: string,
    handler: SkillHandler,
    options: SkillRegistrationOptions = {},
  ): void {
    this.skills.set(skill, {
      handler,
      localOnly: options.localOnly ?? true,
    });
  }

  unregisterSkill(skill: string): void {
    this.skills.delete(skill);
  }

  hasSkill(skill: string): boolean {
    return this.skills.has(skill);
  }

  /**
   * Execute an incoming {@link TaskRequest} on behalf of a local caller.
   * Applies no network authorization. Never throws: an unknown skill or a
   * throwing handler both resolve to a `status: "error"` {@link TaskResult}.
   */
  async handle(task: TaskRequest): Promise<TaskResult> {
    return this.execute(task, false);
  }

  /**
   * Execute an incoming {@link TaskRequest} received from the network. Rejects
   * skills registered as `localOnly`. Never throws. This is the function to
   * hand to `provider.onTask(...)`.
   */
  async handleRemote(task: TaskRequest): Promise<TaskResult> {
    return this.execute(task, true);
  }

  private async execute(
    task: TaskRequest,
    remote: boolean,
  ): Promise<TaskResult> {
    const record = this.skills.get(task.skill);
    if (!record) {
      return {
        taskId: task.id,
        status: "error",
        error: `no skill registered for "${task.skill}"`,
      };
    }
    if (remote && record.localOnly) {
      return {
        taskId: task.id,
        status: "error",
        error: `skill "${task.skill}" is local-only and not network-accessible`,
      };
    }
    try {
      const result = await record.handler(task.payload);
      return { taskId: task.id, status: "ok", result };
    } catch (err) {
      return {
        taskId: task.id,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
