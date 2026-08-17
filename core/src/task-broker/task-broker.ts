import type { TaskRequest, TaskResult } from "@p2p-hub/sdk";

export type SkillHandler = (payload: unknown) => Promise<unknown>;

/**
 * Maps skill names to handlers. Skills are free-form strings; by convention
 * they are `<pluginId>.<skillName>`, but the broker itself does not enforce
 * that — the plugin loader prefixes each plugin's skills with its own id, so
 * a plugin can only ever register under its own namespace.
 */
export class TaskBroker {
  private readonly skills = new Map<string, SkillHandler>();

  registerSkill(skill: string, handler: SkillHandler): void {
    this.skills.set(skill, handler);
  }

  unregisterSkill(skill: string): void {
    this.skills.delete(skill);
  }

  hasSkill(skill: string): boolean {
    return this.skills.has(skill);
  }

  /**
   * Execute an incoming {@link TaskRequest}. Never throws: an unknown skill
   * or a throwing handler both resolve to a `status: "error"` {@link
   * TaskResult}, mirroring the provider's own `dispatchTask` behaviour. This
   * is the function handed to `provider.onTask(...)`.
   */
  async handle(task: TaskRequest): Promise<TaskResult> {
    const handler = this.skills.get(task.skill);
    if (!handler) {
      return {
        taskId: task.id,
        status: "error",
        error: `no skill registered for "${task.skill}"`,
      };
    }
    try {
      const result = await handler(task.payload);
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
