import type { ActivityEvent, NotificationSpec } from "../types";
import { activityBus } from "./activity-bus";
import { sanitizeNotification } from "./notify-lib";

export type NotifySink = (spec: NotificationSpec) => Promise<void>;

/**
 * Default sink: forward a sanitized spec to the native `notify` command. The
 * command itself is deliberately dumb — it just posts the OS notification.
 * Outside Tauri (plain-browser dev/preview) there is no native notification
 * surface, so the sink is a quiet no-op rather than a crash.
 */
export const nativeNotifySink: NotifySink = async (spec) => {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("notify", { title: spec.title, body: spec.body });
  } catch {
    // Not running under Tauri — no OS notification surface available.
  }
};

/**
 * Bridges sanitized P2P events to OS notifications. The sanitizer lives in
 * `notify-lib` so the privacy guarantees are unit-testable; this service only
 * owns the subscription lifecycle. `attach`/`detach` are idempotent.
 */
export class NotificationsService {
  private unsubscribe: (() => void) | null = null;
  private readonly bus;
  private readonly sink;

  constructor(
    bus: Pick<typeof activityBus, "subscribeAll"> = activityBus,
    sink: NotifySink = nativeNotifySink,
  ) {
    this.bus = bus;
    this.sink = sink;
  }

  attach(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.bus.subscribeAll((event: ActivityEvent) => {
      const spec = sanitizeNotification(event);
      if (spec) {
        void this.sink(spec);
      }
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

export const notificationsService = new NotificationsService();
