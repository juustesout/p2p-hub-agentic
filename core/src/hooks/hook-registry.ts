export type ActionHandler = (payload: unknown) => void | Promise<void>;
export type FilterFn = (value: unknown) => unknown | Promise<unknown>;

interface PrioritizedAction {
  handler: ActionHandler;
  priority: number;
}

interface PrioritizedFilter {
  fn: FilterFn;
  priority: number;
}

/**
 * Generic, plugin-unaware hook registry. Events are namespaced strings like
 * `calendar:eventAdded`; this class does not know about plugins or manifests
 * and does not enforce namespaces — that is the loader's job.
 *
 * Actions are fire-and-forget: handlers run in priority order and a throwing
 * handler is logged and skipped so it cannot block other handlers. Filters
 * transform a value through an ordered chain; a throwing filter propagates,
 * because a broken filter on pre-save data should block the save.
 */
export class HookRegistry {
  private readonly actions = new Map<string, PrioritizedAction[]>();
  private readonly filters = new Map<string, PrioritizedFilter[]>();

  on(event: string, handler: ActionHandler, priority = 10): void {
    const list = this.actions.get(event) ?? [];
    list.push({ handler, priority });
    this.actions.set(event, list);
  }

  async emit(event: string, payload: unknown): Promise<void> {
    const handlers = [...(this.actions.get(event) ?? [])].sort(
      (a, b) => a.priority - b.priority,
    );
    for (const { handler } of handlers) {
      try {
        await handler(payload);
      } catch (err) {
        console.error(`[hooks] action handler for "${event}" failed:`, err);
      }
    }
  }

  registerFilter(event: string, fn: FilterFn, priority = 10): void {
    const list = this.filters.get(event) ?? [];
    list.push({ fn, priority });
    this.filters.set(event, list);
  }

  async applyFilters(event: string, initialValue: unknown): Promise<unknown> {
    const fns = [...(this.filters.get(event) ?? [])].sort(
      (a, b) => a.priority - b.priority,
    );
    let value = initialValue;
    for (const { fn } of fns) {
      value = await fn(value);
    }
    return value;
  }
}
