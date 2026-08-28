import type { ActivityEvent, NotificationSpec } from "../types";

const MAX_LABEL_LENGTH = 24;

/**
 * Sanitize a free-form string for display in an OS notification: collapse
 * control characters, trim, and cap the length. Notification text must never
 * smuggle raw payload bytes onto the lock screen.
 */
export function sanitizeLabel(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MAX_LABEL_LENGTH
    ? `${cleaned.slice(0, MAX_LABEL_LENGTH)}…`
    : cleaned;
}

/**
 * Peer label for notification copy. Uses the persistent peer id when no name
 * is available; never the message text.
 */
function peerLabel(payload: {
  fromPeerId?: unknown;
  peerId?: unknown;
  peerLabel?: unknown;
}): string {
  const named = sanitizeLabel(payload.peerLabel ?? payload.peerId ?? payload.fromPeerId);
  return named.length > 0 ? named : "een peer";
}

interface TaskDetailPayload {
  projectId?: unknown;
  taskId?: unknown;
  taskName?: unknown;
  action?: unknown;
}

const TASK_ACTION_TITLES: Record<string, string> = {
  acceptDelegation: "Taak geaccepteerd",
  declineDelegation: "Taak geweigerd",
  submitCompletionProof: "Taak ter controle ingeleverd",
  assignAgent: "Taak toegewezen",
};

function taskNotification(payload: TaskDetailPayload): NotificationSpec | null {
  const action = typeof payload.action === "string" ? payload.action : "";
  const title = TASK_ACTION_TITLES[action];
  if (!title) {
    return null;
  }
  const task = sanitizeLabel(payload.taskName ?? payload.taskId ?? "Taak");
  const project = sanitizeLabel(payload.projectId);
  return {
    title,
    body: project.length > 0 ? `${task} (project ${project})` : task,
  };
}

/**
 * Build an OS-notification spec from a bridged event, or `null` when the event
 * should not produce one. Privacy rule: the spec never contains message text,
 * secret values, or raw payload fields — the lock screen only ever sees
 * sanitized labels ("Nieuw bericht van Peer X", not the message body).
 */
export function sanitizeNotification(event: ActivityEvent): NotificationSpec | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  switch (event.event) {
    case "chat:messageReceived":
      return {
        title: "Nieuw chatbericht",
        body: `Nieuw bericht van ${peerLabel(payload)}`,
      };
    case "tasks:taskUpdated":
      return taskNotification(payload as TaskDetailPayload);
    default:
      return null;
  }
}
