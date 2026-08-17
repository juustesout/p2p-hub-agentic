import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadPlugin, StorageManager, HookRegistry } from "@p2p-hub/core";

const calendarDir = path.resolve(__dirname, "../../calendar");
const birthdayDir = path.resolve(__dirname, "..");

interface CalendarApi {
  addEvent(event: { title: string; date: string }): Promise<{
    id: string;
    title: string;
    date: string;
  }>;
}

interface BirthdayCard {
  eventId: string;
  title: string;
  date: string;
  status: string;
}

interface BirthdayCardsApi {
  listPendingCards(): Promise<BirthdayCard[]>;
}

async function bootBoth(): Promise<{
  calendar: CalendarApi;
  cards: BirthdayCardsApi;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "birthday-"));
  const storageManager = new StorageManager(dataDir);
  const hookRegistry = new HookRegistry();

  const calendar = (await loadPlugin(
    calendarDir,
    storageManager,
    hookRegistry,
  )) as CalendarApi;
  const cards = (await loadPlugin(
    birthdayDir,
    storageManager,
    hookRegistry,
  )) as BirthdayCardsApi;

  return { calendar, cards };
}

test("an event with 'verjaardag' in the title creates a pending card", async () => {
  const { calendar, cards } = await bootBoth();

  await calendar.addEvent({ title: "Mama's verjaardag", date: "2026-09-01" });

  const pending = await cards.listPendingCards();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].title, "Mama's verjaardag");
  assert.equal(pending[0].status, "pending");
});

test("an event without 'verjaardag'/'birthday' creates no card", async () => {
  const { calendar, cards } = await bootBoth();

  await calendar.addEvent({ title: "Weekly standup", date: "2026-08-20" });

  const pending = await cards.listPendingCards();
  assert.equal(pending.length, 0);
});
