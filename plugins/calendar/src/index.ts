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

  ctx.skills.register("listEvents", async () => listEvents());

  return {
    async addEvent(event) {
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
    },

    listEvents,

    async removeEvent(id) {
      await ctx.storage.delete(id);
    },
  };
}
