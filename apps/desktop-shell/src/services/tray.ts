/**
 * Events the native tray emits to the main webview when the operator picks a
 * quick action. The tray only forwards intents; the webview owns the actual
 * HTTP calls, so the JS tests can cover the actions.
 */
export const TRAY_EVENT_LOCK_VAULT = "p2p:lock-vault";
export const TRAY_EVENT_TOGGLE_NETWORK = "p2p:toggle-network";

export interface TrayHandlers {
  onLockVault: () => void;
  onToggleNetwork: () => void;
}

/**
 * Pure mapping from a tray event name to the handler key it drives. Unknown
 * event names (tray internals, future items) map to `null` — never an action.
 */
export function trayEventAction(
  event: string,
): "lock-vault" | "toggle-network" | null {
  switch (event) {
    case TRAY_EVENT_LOCK_VAULT:
      return "lock-vault";
    case TRAY_EVENT_TOGGLE_NETWORK:
      return "toggle-network";
    default:
      return null;
  }
}

/**
 * Wire tray events to webview handlers. Returns an unsubscribe function.
 * Outside Tauri (plain-browser dev) the `@tauri-apps/api/event` import is
 * unavailable and this is a quiet no-op.
 */
export async function attachTrayEvents(
  handlers: TrayHandlers,
): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisteners = await Promise.all([
      listen(TRAY_EVENT_LOCK_VAULT, () => handlers.onLockVault()),
      listen(TRAY_EVENT_TOGGLE_NETWORK, () => handlers.onToggleNetwork()),
    ]);
    return () => {
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  } catch {
    return () => {};
  }
}
