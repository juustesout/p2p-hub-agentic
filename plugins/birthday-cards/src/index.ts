import type { PluginContext } from "@p2p-hub/core";

export interface BirthdayCard {
  eventId: string;
  title: string;
  date: string;
  status: "pending" | "sent";
}

export interface BirthdayCardsApi {
  listPendingCards(): Promise<BirthdayCard[]>;
  markSent(eventId: string): Promise<void>;
}

function isBirthdayTitle(value: unknown): value is string {
  return typeof value === "string" && /\b(verjaardag|birthday)\b/i.test(value);
}

function isBirthdayCard(value: unknown): value is BirthdayCard {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).eventId === "string" &&
    typeof (value as Record<string, unknown>).title === "string" &&
    typeof (value as Record<string, unknown>).date === "string"
  );
}

export default function activate(ctx: PluginContext): BirthdayCardsApi {
  ctx.hooks.on("calendar:eventAdded", async (payload) => {
    if (typeof payload !== "object" || payload === null) {
      return;
    }
    const event = payload as { id?: unknown; title?: unknown; date?: unknown };
    if (!isBirthdayTitle(event.title)) {
      return;
    }
    const card: BirthdayCard = {
      eventId: typeof event.id === "string" ? event.id : "",
      title: event.title,
      date: typeof event.date === "string" ? event.date : "",
      status: "pending",
    };
    await ctx.storage.set(`card:${card.eventId}`, card);
  });

  return {
    async listPendingCards() {
      const keys = await ctx.storage.list("card:");
      const cards: BirthdayCard[] = [];
      for (const key of keys) {
        const value = await ctx.storage.get(key);
        if (isBirthdayCard(value) && value.status === "pending") {
          cards.push(value);
        }
      }
      return cards;
    },

    async markSent(eventId) {
      const key = `card:${eventId}`;
      const value = await ctx.storage.get(key);
      if (isBirthdayCard(value)) {
        await ctx.storage.set(key, { ...value, status: "sent" });
      }
    },
  };
}
