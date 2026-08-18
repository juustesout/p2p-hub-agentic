/**
 * A resource that can be released. Every subscription/timer/teardown handle in
 * the framework implements this so plugin deactivation can release them all in
 * one pass.
 */
export interface Disposable {
  dispose(): void;
}

/**
 * Accumulates {@link Disposable}s (or bare cleanup functions) created during a
 * plugin's lifetime and releases them all on {@link DisposerBag.dispose}.
 * Idempotent: a second `dispose()` is a no-op, and `add()` after disposal runs
 * the cleanup immediately so a late-registered resource can never leak.
 */
export class DisposerBag implements Disposable {
  private readonly disposers: Disposable[] = [];
  private disposed = false;

  add(disposable: Disposable | (() => void)): void {
    const wrapped: Disposable =
      typeof disposable === "function" ? { dispose: disposable } : disposable;
    if (this.disposed) {
      wrapped.dispose();
      return;
    }
    this.disposers.push(wrapped);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const items = this.disposers.splice(0);
    for (const item of items) {
      try {
        item.dispose();
      } catch {
        // A failing disposer must not prevent the remaining ones from running.
      }
    }
  }
}
