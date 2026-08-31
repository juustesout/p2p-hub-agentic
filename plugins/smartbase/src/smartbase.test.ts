import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  HookRegistry,
  StorageManager,
  TaskBroker,
  loadPlugin,
} from "@p2p-hub/core";
import type {
  SmartbasePlugin,
  TableSchema,
} from "./index";
import { MAX_QUERY_LIMIT } from "./index";

const pluginDir = path.resolve(__dirname, "..");

async function loadSmartbase(): Promise<{
  smartbase: SmartbasePlugin;
  hooks: HookRegistry;
  broker: TaskBroker;
  dataDir: string;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "smartbase-data-"));
  const manager = new StorageManager(dataDir);
  const hooks = new HookRegistry();
  const broker = new TaskBroker();
  const smartbase = (await loadPlugin(
    pluginDir,
    manager,
    hooks,
    broker,
  )) as SmartbasePlugin;
  return { smartbase, hooks, broker, dataDir };
}

async function setupTable(
  smartbase: SmartbasePlugin,
  schema: TableSchema,
  title = "Base",
  name = "Table",
): Promise<{ databaseId: string; tableId: string }> {
  const db = await smartbase.createDatabase({ title });
  const table = await smartbase.createTable({ databaseId: db.databaseId, name, schema });
  return { databaseId: db.databaseId, tableId: table.tableId };
}

async function seed(
  smartbase: SmartbasePlugin,
  databaseId: string,
  tableId: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await smartbase.insertRecord({ databaseId, tableId, fields: { n: i } });
  }
}

test("createTable/insertRecord build PBX documents and validate against the schema", async () => {
  const { smartbase } = await loadSmartbase();
  const { databaseId, tableId } = await setupTable(smartbase, {
    fields: [
      { name: "name", type: "string" },
      { name: "age", type: "number" },
      { name: "active", type: "boolean" },
      { name: "joined", type: "date" },
    ],
  });

  const record = await smartbase.insertRecord({
    databaseId,
    tableId,
    fields: { name: "Alice", age: 30, active: true, joined: "2026-01-01" },
  });
  assert.equal(record.fields.name, "Alice");
  assert.equal(record.fields.age, 30);
  assert.equal(record.fields.active, true);
  assert.equal(record.fields.joined, "2026-01-01");

  await assert.rejects(
    smartbase.insertRecord({ databaseId, tableId, fields: { age: "thirty" } }),
    /must be a number/,
  );
  await assert.rejects(
    smartbase.insertRecord({ databaseId, tableId, fields: { hacker: true } }),
    /unknown field "hacker"/,
  );
  await assert.rejects(
    smartbase.insertRecord({ databaseId, tableId, fields: { joined: "not-a-date" } }),
    /ISO 8601/,
  );

  // The failed inserts must not have persisted.
  const result = await smartbase.query({ databaseId, tableId });
  assert.equal(result.records.length, 1);
});

test("query without filter returns all records, bounded by the default limit", async () => {
  const { smartbase } = await loadSmartbase();
  const { databaseId, tableId } = await setupTable(smartbase, {
    fields: [{ name: "n", type: "number" }],
  });
  await seed(smartbase, databaseId, tableId, 150);

  const result = await smartbase.query({ databaseId, tableId });
  assert.equal(result.records.length, 100);
  assert.equal(result.truncated, true);
});

test("query filters by eq, gt and contains, combined with AND", async () => {
  const { smartbase } = await loadSmartbase();
  const { databaseId, tableId } = await setupTable(smartbase, {
    fields: [
      { name: "title", type: "string" },
      { name: "score", type: "number" },
    ],
  });
  await smartbase.insertRecord({ databaseId, tableId, fields: { title: "Alpha", score: 10 } });
  await smartbase.insertRecord({ databaseId, tableId, fields: { title: "Beta", score: 20 } });
  await smartbase.insertRecord({ databaseId, tableId, fields: { title: "Alphabet Soup", score: 30 } });

  const eq = await smartbase.query({
    databaseId,
    tableId,
    filter: { title: { op: "eq", value: "Beta" } },
  });
  assert.deepEqual(eq.records.map((r) => r.fields.title), ["Beta"]);

  const gt = await smartbase.query({
    databaseId,
    tableId,
    filter: { score: { op: "gt", value: 15 } },
  });
  assert.deepEqual(
    gt.records.map((r) => r.fields.score).sort((a, b) => (a as number) - (b as number)),
    [20, 30],
  );

  const contains = await smartbase.query({
    databaseId,
    tableId,
    filter: { title: { op: "contains", value: "alpha" } },
  });
  assert.deepEqual(contains.records.map((r) => r.fields.title).sort(), ["Alpha", "Alphabet Soup"]);

  const and = await smartbase.query({
    databaseId,
    tableId,
    filter: {
      title: { op: "contains", value: "alpha" },
      score: { op: "gte", value: 20 },
    },
  });
  assert.deepEqual(and.records.map((r) => r.fields.title), ["Alphabet Soup"]);
});

test("query clamps limit to the hard maximum, without error", async () => {
  const { smartbase } = await loadSmartbase();
  const { databaseId, tableId } = await setupTable(smartbase, {
    fields: [{ name: "n", type: "number" }],
  });
  await seed(smartbase, databaseId, tableId, MAX_QUERY_LIMIT + 5);

  const capped = await smartbase.query({ databaseId, tableId, limit: 1_000_000 });
  assert.equal(capped.records.length, MAX_QUERY_LIMIT);
  assert.equal(capped.truncated, true);

  const small = await smartbase.query({ databaseId, tableId, limit: 3 });
  assert.equal(small.records.length, 3);
  assert.equal(small.truncated, true);
});

test("filter values are compared literally, never interpreted or executed", async () => {
  const { smartbase } = await loadSmartbase();
  const { databaseId, tableId } = await setupTable(smartbase, {
    fields: [{ name: "title", type: "string" }],
  });

  await smartbase.insertRecord({ databaseId, tableId, fields: { title: "normal" } });
  const injection = "'; DROP TABLE x; --";
  await smartbase.insertRecord({ databaseId, tableId, fields: { title: injection } });
  const jsPayload = "() => fetch('http://evil.example')";
  await smartbase.insertRecord({ databaseId, tableId, fields: { title: jsPayload } });

  const eq = await smartbase.query({
    databaseId,
    tableId,
    filter: { title: { op: "eq", value: injection } },
  });
  assert.equal(eq.records.length, 1);
  assert.equal(eq.records[0].fields.title, injection);

  const drop = await smartbase.query({
    databaseId,
    tableId,
    filter: { title: { op: "contains", value: "DROP TABLE" } },
  });
  assert.equal(drop.records.length, 1);

  const fetch = await smartbase.query({
    databaseId,
    tableId,
    filter: { title: { op: "contains", value: "() => fetch" } },
  });
  assert.equal(fetch.records.length, 1);

  // Nothing was executed and nothing was destroyed: all three records remain.
  const all = await smartbase.query({ databaseId, tableId });
  assert.equal(all.records.length, 3);

  // An unknown op is rejected with a clean error, never dispatched.
  await assert.rejects(
    smartbase.query({
      databaseId,
      tableId,
      filter: { title: { op: "execute", value: "anything" } } as never,
    }),
    /invalid op/,
  );
});

test("updateRecord merges fields and validates types and unknown keys", async () => {
  const { smartbase } = await loadSmartbase();
  const { databaseId, tableId } = await setupTable(smartbase, {
    fields: [
      { name: "name", type: "string" },
      { name: "age", type: "number" },
    ],
  });
  const record = await smartbase.insertRecord({
    databaseId,
    tableId,
    fields: { name: "Alice", age: 30 },
  });

  const updated = await smartbase.updateRecord({
    databaseId,
    tableId,
    recordId: record.recordId,
    fields: { age: 31 },
  });
  assert.equal(updated.fields.name, "Alice");
  assert.equal(updated.fields.age, 31);

  await assert.rejects(
    smartbase.updateRecord({
      databaseId,
      tableId,
      recordId: record.recordId,
      fields: { age: "old" },
    }),
    /must be a number/,
  );
  await assert.rejects(
    smartbase.updateRecord({
      databaseId,
      tableId,
      recordId: record.recordId,
      fields: { nope: 1 },
    }),
    /unknown field "nope"/,
  );
});

test("deleteRecord removes the record", async () => {
  const { smartbase } = await loadSmartbase();
  const { databaseId, tableId } = await setupTable(smartbase, {
    fields: [{ name: "n", type: "number" }],
  });
  const record = await smartbase.insertRecord({ databaseId, tableId, fields: { n: 1 } });

  const del = await smartbase.deleteRecord({ databaseId, tableId, recordId: record.recordId });
  assert.deepEqual(del, { recordId: record.recordId, deleted: true });

  const result = await smartbase.query({ databaseId, tableId });
  assert.equal(result.records.length, 0);

  await assert.rejects(
    smartbase.deleteRecord({ databaseId, tableId, recordId: record.recordId }),
    /not found/,
  );
});

test("listTables and getSchema expose discoverable schema", async () => {
  const { smartbase } = await loadSmartbase();
  const db = await smartbase.createDatabase({ title: "D" });
  const t1 = await smartbase.createTable({
    databaseId: db.databaseId,
    name: "A",
    schema: { fields: [{ name: "x", type: "string" }] },
  });
  const t2 = await smartbase.createTable({
    databaseId: db.databaseId,
    name: "B",
    schema: { fields: [{ name: "y", type: "number" }] },
  });

  const tables = await smartbase.listTables(db.databaseId);
  assert.deepEqual(tables.map((t) => t.name), ["A", "B"]);
  assert.deepEqual(tables.map((t) => t.tableId).sort(), [t1.tableId, t2.tableId].sort());

  const schema = await smartbase.getSchema(db.databaseId, t2.tableId);
  assert.deepEqual(schema, { fields: [{ name: "y", type: "number" }] });
  assert.equal(await smartbase.getSchema(db.databaseId, "missing"), null);
});

test("skills are registered in the smartbase namespace and local-only", async () => {
  const { broker } = await loadSmartbase();
  const names = broker.listSkills().map((s) => s.skill).sort();
  assert.deepEqual(names, [
    "smartbase.createDatabase",
    "smartbase.createTable",
    "smartbase.deleteRecord",
    "smartbase.getSchema",
    "smartbase.insertRecord",
    "smartbase.listTables",
    "smartbase.query",
    "smartbase.updateRecord",
  ]);
  for (const entry of broker.listSkills()) {
    assert.equal(entry.localOnly, true);
    assert.equal(entry.httpExposed, false);
  }
});

test("record mutations emit sanitized local domain events (invoice:created/updated/deleted)", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "smartbase-events-"));
  const manager = new StorageManager(dataDir);
  const hooks = new HookRegistry();
  const broker = new TaskBroker();
  const events: Array<{ topic: string; payload: unknown }> = [];
  const smartbase = (await loadPlugin(
    pluginDir,
    manager,
    hooks,
    broker,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { publish: async (topic, payload) => { events.push({ topic, payload }); } },
  )) as SmartbasePlugin;

  const db = await smartbase.createDatabase({ title: "Books" });
  const table = await smartbase.createTable({
    databaseId: db.databaseId,
    name: "invoice",
    schema: { fields: [{ name: "amount", type: "number" }], emitEvents: true },
  });

  const created = await smartbase.insertRecord({
    databaseId: db.databaseId,
    tableId: table.tableId,
    fields: { amount: 250 },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "invoice:created");
  assert.equal(
    (events[0].payload as { recordId: string }).recordId,
    created.recordId,
  );
  assert.deepEqual(
    (events[0].payload as { fields: unknown }).fields,
    { amount: 250 },
  );

  await smartbase.updateRecord({
    databaseId: db.databaseId,
    tableId: table.tableId,
    recordId: created.recordId,
    fields: { amount: 300 },
  });
  assert.equal(events[1].topic, "invoice:updated");
  assert.deepEqual(
    (events[1].payload as { fields: unknown }).fields,
    { amount: 300 },
  );

  await smartbase.deleteRecord({
    databaseId: db.databaseId,
    tableId: table.tableId,
    recordId: created.recordId,
  });
  assert.equal(events[2].topic, "invoice:deleted");
  assert.equal(
    (events[2].payload as { recordId: string }).recordId,
    created.recordId,
  );
});

test("a hostile table name is sanitized into a valid, delimiter-safe topic segment", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "smartbase-events-"));
  const manager = new StorageManager(dataDir);
  const hooks = new HookRegistry();
  const broker = new TaskBroker();
  const events: Array<{ topic: string }> = [];
  const smartbase = (await loadPlugin(
    pluginDir,
    manager,
    hooks,
    broker,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { publish: async (topic) => { events.push({ topic }); } },
  )) as SmartbasePlugin;

  const db = await smartbase.createDatabase({ title: "Evil" });
  // A colon/wildcard-laden name must never smuggle a delimiter into the topic:
  // every illegal char is mapped to `_`, so the emitted segment stays within
  // the `[A-Za-z0-9_][A-Za-z0-9_.-]*` grammar (CLAUDE.md principle #2).
  const table = await smartbase.createTable({
    databaseId: db.databaseId,
    name: "evil:*:name",
    schema: { fields: [{ name: "n", type: "number" }], emitEvents: true },
  });

  await smartbase.insertRecord({
    databaseId: db.databaseId,
    tableId: table.tableId,
    fields: { n: 1 },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, "evil___name:created");
});

test("record mutations do NOT emit local events without an explicit per-table opt-in", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "smartbase-events-"));
  const manager = new StorageManager(dataDir);
  const hooks = new HookRegistry();
  const broker = new TaskBroker();
  const events: Array<{ topic: string; payload: unknown }> = [];
  const smartbase = (await loadPlugin(
    pluginDir,
    manager,
    hooks,
    broker,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { publish: async (topic, payload) => { events.push({ topic, payload }); } },
  )) as SmartbasePlugin;

  const db = await smartbase.createDatabase({ title: "Ledger" });

  // `emitEvents` absent (default false) — a sensitive table like invoices must
  // stay off the bus unless the operator explicitly opts it in.
  const noFlag = await smartbase.createTable({
    databaseId: db.databaseId,
    name: "invoice",
    schema: { fields: [{ name: "amount", type: "number" }] },
  });
  // `emitEvents: false` — an explicit no is also respected.
  const explicitOff = await smartbase.createTable({
    databaseId: db.databaseId,
    name: "contracts",
    schema: { fields: [{ name: "signed", type: "boolean" }], emitEvents: false },
  });

  await smartbase.insertRecord({
    databaseId: db.databaseId,
    tableId: noFlag.tableId,
    fields: { amount: 99999 },
  });
  await smartbase.updateRecord({
    databaseId: db.databaseId,
    tableId: noFlag.tableId,
    recordId: (
      await smartbase.query({ databaseId: db.databaseId, tableId: noFlag.tableId })
    ).records[0].recordId,
    fields: { amount: 1 },
  });
  await smartbase.insertRecord({
    databaseId: db.databaseId,
    tableId: explicitOff.tableId,
    fields: { signed: true },
  });

  // The mutations all succeeded, but nothing touched the bus.
  assert.equal(events.length, 0);

  // A non-boolean flag is rejected loudly at table creation.
  await assert.rejects(
    smartbase.createTable({
      databaseId: db.databaseId,
      name: "broken",
      schema: { fields: [{ name: "x", type: "number" }], emitEvents: "yes" } as unknown as TableSchema,
    }),
    /emitEvents must be a boolean/,
  );
});
