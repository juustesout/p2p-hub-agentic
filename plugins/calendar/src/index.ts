import type { PluginContext } from "@p2p-hub/core";

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
}

export interface CalendarPlugin {
  addEvent(event: { title: string; date: string }): Promise<CalendarEvent>;
  listEvents(): Promise<CalendarEvent[]>;
  removeEvent(id: string): Promise<void>;
}

function isCalendarEvent(value: unknown): value is CalendarEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === "string" &&
    typeof (value as Record<string, unknown>).title === "string" &&
    typeof (value as Record<string, unknown>).date === "string"
  );
}

export default function activate(ctx: PluginContext): CalendarPlugin {
  async function listEvents(): Promise<CalendarEvent[]> {
    const keys = await ctx.storage.list();
    const events: CalendarEvent[] = [];
    for (const key of keys) {
      const value = await ctx.storage.get(key);
      if (isCalendarEvent(value)) {
        events.push(value);
      }
    }
    return events;
  }

  async function addEvent(event: {
    title: string;
    date: string;
  }): Promise<CalendarEvent> {
    const title = event.title.trim();
    const date = event.date.trim();
    if (!title || !date) {
      throw new Error("title and date must not be empty");
    }
    const id = `event-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let stored: CalendarEvent = { id, title, date };
    stored = (await ctx.hooks.applyFilters(
      "calendar:beforeSave",
      stored,
    )) as CalendarEvent;
    await ctx.storage.set(id, stored);
    await ctx.hooks.emit("calendar:eventAdded", stored);
    return stored;
  }

  async function removeEvent(id: string): Promise<void> {
    await ctx.storage.delete(id);
  }

  ctx.skills.register("listEvents", async () => listEvents(), {
    localOnly: false,
    httpExposed: true,
  });

  ctx.skills.register(
    "addEvent",
    async (payload) => {
      const { title, date } = (payload ?? {}) as {
        title?: unknown;
        date?: unknown;
      };
      if (typeof title !== "string" || typeof date !== "string") {
        throw new Error("addEvent expects { title: string, date: string }");
      }
      return addEvent({ title, date });
    },
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "removeEvent",
    async (payload) => {
      const { id } = (payload ?? {}) as { id?: unknown };
      if (typeof id !== "string") {
        throw new Error("removeEvent expects { id: string }");
      }
      await removeEvent(id);
      return { ok: true };
    },
    { localOnly: true, httpExposed: true },
  );

  return {
    addEvent,
    listEvents,
    removeEvent,
  };
}
