import type { ActionHandler, FilterFn } from "../hooks/hook-registry";
import type { SkillHandler } from "../task-broker/task-broker";

/**
 * Namespace-aware view over the shared {@link HookRegistry}. `emit` and
 * `applyFilters` are restricted to the plugin's own namespace, and
 * cross-namespace `registerFilter` requires a permission.
 */
export interface HookContext {
  on(event: string, handler: ActionHandler, priority?: number): void;
  emit(event: string, payload: unknown): Promise<void>;
  registerFilter(event: string, fn: FilterFn, priority?: number): void;
  applyFilters(event: string, value: unknown): Promise<unknown>;
}

/**
 * Skill registration for a plugin. The plugin supplies only the local name;
 * the loader prefixes it with `${pluginId}.`, so a plugin cannot register
 * outside its own namespace by construction.
 */
export interface SkillContext {
  register(skillName: string, handler: SkillHandler): void;
  unregister(skillName: string): void;
}

/**
 * The object handed to a plugin at activation time. This is the enforcement
 * point for permissions: a plugin can only touch its own storage directly,
 * and can only reach another plugin's storage via {@link readStorageOf}, which
 * checks the manifest permissions.
 */
export interface PluginContext {
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };
  /**
   * Read-only access to another plugin's storage. Returns `null` (not an
   * exception) when the current plugin's manifest lacks the
   * `storage:read:<otherPluginId>` permission.
   */
  readStorageOf(otherPluginId: string): {
    get(key: string): Promise<unknown>;
    list(prefix?: string): Promise<string[]>;
  } | null;
  hooks: HookContext;
  skills: SkillContext;
}
