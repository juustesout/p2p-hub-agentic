import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadPlugin, StorageManager } from "@p2p-hub/core";

const pluginDir = path.resolve(__dirname, "..");

interface CalendarEvent {
  id: string;
  title: string;
  date: string;
}

interface CalendarApi {
  addEvent(event: { title: string; date: string }): Promise<CalendarEvent>;
  listEvents(): Promise<CalendarEvent[]>;
  removeEvent(id: string): Promise<void>;
}

test("calendar plugin stores, lists and removes events via ctx.storage only", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-data-"));
  const storageManager = new StorageManager(dataDir);

  const calendar = (await loadPlugin(pluginDir, storageManager)) as CalendarApi;

  const standup = await calendar.addEvent({ title: "Standup", date: "2026-08-17" });
  const review = await calendar.addEvent({ title: "Review", date: "2026-08-18" });

  assert.equal(standup.title, "Standup");
  assert.equal(review.title, "Review");

  let events = await calendar.listEvents();
  assert.equal(events.length, 2);

  await calendar.removeEvent(standup.id);

  events = await calendar.listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].id, review.id);

  // Isolation sanity-check: read the on-disk file and verify it only holds
  // this plugin's own data.
  const raw = await fs.readFile(path.join(dataDir, "calendar.json"), "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [review.id]);
  assert.deepEqual(parsed[review.id], {
    id: review.id,
    title: "Review",
    date: "2026-08-18",
  });
});

test("addEvent rejects empty title or date", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-data-"));
  const storageManager = new StorageManager(dataDir);

  const calendar = (await loadPlugin(pluginDir, storageManager)) as CalendarApi;

  await assert.rejects(
    calendar.addEvent({ title: "   ", date: "2026-08-17" }),
    /title and date must not be empty/,
  );
  await assert.rejects(
    calendar.addEvent({ title: "Standup", date: "" }),
    /title and date must not be empty/,
  );
});
