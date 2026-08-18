import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  HookRegistry,
  StorageManager,
  TaskBroker,
  VaultManager,
  loadPlugin,
} from "@p2p-hub/core";
import {
  resolveRef,
  rootObject,
  type PBXDocument,
  type PBXObject,
  type PBXReference,
} from "@p2p-hub/sdk";
import {
  AI_ERROR,
  REF_ERROR,
  coordToLabel,
  evaluateMath,
  parseCoord,
  parseFormula,
  parseRange,
  rangeCells,
} from "./formula";

const pluginDir = path.resolve(__dirname, "..");

/* ------------------------------------------------------------------ */
/* Formula engine (pure) unit tests                                    */
/* ------------------------------------------------------------------ */

test("parseCoord parses A1-style coordinates", () => {
  assert.deepEqual(parseCoord("A1"), { col: 0, row: 0 });
  assert.deepEqual(parseCoord("B2"), { col: 1, row: 1 });
  assert.deepEqual(parseCoord("AA10"), { col: 26, row: 9 });
  assert.equal(parseCoord("1A"), null);
  assert.equal(parseCoord("nope"), null);
});

test("coordToLabel round-trips with parseCoord", () => {
  for (const coord of ["A1", "B2", "Z26", "AA10", "ABC123"]) {
    const parsed = parseCoord(coord)!;
    assert.equal(coordToLabel(parsed.col, parsed.row), coord);
  }
});

test("parseRange normalises single cells and ranges", () => {
  assert.deepEqual(parseRange("A1:A5"), { start: "A1", end: "A5" });
  assert.deepEqual(parseRange("B2"), { start: "B2", end: "B2" });
  assert.equal(parseRange("A1:"), null);
});

test("rangeCells expands ranges row-major", () => {
  assert.deepEqual(rangeCells(parseRange("A1:B2")!), [
    "A1",
    "B1",
    "A2",
    "B2",
  ]);
  assert.deepEqual(rangeCells(parseRange("A1:A3")!), ["A1", "A2", "A3"]);
});

test("parseFormula recognises SUM, AVERAGE and AI", () => {
  assert.deepEqual(parseFormula("=SUM(A1:A5)"), { kind: "sum", range: "A1:A5" });
  assert.deepEqual(parseFormula("=AVERAGE(B1:B3)"), {
    kind: "average",
    range: "B1:B3",
  });
  assert.deepEqual(parseFormula('=AI("Translate to Spanish", A2)'), {
    kind: "ai",
    prompt: "Translate to Spanish",
    ref: "A2",
  });
  assert.deepEqual(parseFormula("=AI('Summarize', A1)"), {
    kind: "ai",
    prompt: "Summarize",
    ref: "A1",
  });
});

test("parseFormula returns null for literals and unknown functions", () => {
  assert.equal(parseFormula("hello"), null);
  assert.equal(parseFormula("=FOO(A1)"), null);
  assert.equal(parseFormula("42"), null);
});

test("evaluateMath ignores non-numeric values and handles empty average", () => {
  assert.equal(evaluateMath("sum", [1, 2, 3, null, "x"]), 6);
  assert.equal(evaluateMath("average", [1, 2, 3]), 2);
  assert.equal(evaluateMath("average", [null, "x"]), "#DIV/0!");
});

/* ------------------------------------------------------------------ */
/* Plugin integration                                                  */
/* ------------------------------------------------------------------ */

interface CalcApi {
  createSheet(input: {
    title?: string;
  }): Promise<PBXDocument>;
  getSheet(sheetId: string): Promise<PBXDocument | null>;
  listSheets(): Promise<Array<{ sheetId: string; title: string }>>;
  updateCell(input: {
    sheetId: string;
    coord: string;
    value?: unknown;
    formula?: string;
  }): Promise<PBXObject>;
  updateCells(input: {
    sheetId: string;
    updates: Array<{ coord: string; value?: unknown; formula?: string }>;
  }): Promise<PBXObject[]>;
  insertRows(input: { sheetId: string; at: number; count: number }): Promise<PBXDocument>;
  deleteRows(input: { sheetId: string; at: number; count: number }): Promise<PBXDocument>;
  evaluateAIFormula(input: {
    sheetId: string;
    coord: string;
  }): Promise<PBXObject>;
  embedObject(input: {
    sheetId: string;
    coord: string;
    targetObjectId: string;
    targetClass: string;
  }): Promise<PBXObject>;
  aiFillColumn(input: {
    sheetId: string;
    startCoord: string;
    endCoord: string;
    instruction: string;
  }): Promise<{ sheetId: string; filled: string[]; values: Record<string, unknown> }>;
}

async function loadCalc() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "calc-data-"));
  const storageManager = new StorageManager(dataDir);
  const hooks = new HookRegistry();
  const broker = new TaskBroker();
  const vault = new VaultManager({ dataDir, masterKey: "test-master-key" });
  const calc = (await loadPlugin(
    pluginDir,
    storageManager,
    hooks,
    broker,
    vault,
  )) as CalcApi;
  return { calc, storageManager, hooks, broker, vault, dataDir };
}

function stubFetch(responses: string[]): {
  restore: () => void;
  prompts: string[];
} {
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (_input: unknown, init?: unknown) => {
    const body = JSON.parse(
      String((init as { body?: unknown } | undefined)?.body ?? "{}"),
    ) as { messages?: Array<{ content?: string }> };
    prompts.push(body.messages?.map((m) => m.content ?? "").join(" ") ?? "");
    const content = responses[Math.min(i++, responses.length - 1)];
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    prompts,
  };
}

test("createSheet builds a P2P.Spreadsheet document with a linked sheet", async () => {
  const { calc, hooks, dataDir } = await loadCalc();
  const created: unknown[] = [];
  hooks.on("calc:sheetCreated", (p) => {
    created.push(p);
  });

  const doc = await calc.createSheet({ title: "Budget" });
  const root = rootObject(doc)!;
  assert.equal(root.$class, "P2P.Spreadsheet");
  assert.equal(root.title, "Budget");

  const sheetRefs = root.sheets as PBXReference[];
  assert.equal(sheetRefs.length, 1);
  const sheet = resolveRef(doc, sheetRefs[0])!;
  assert.equal(sheet.$class, "P2P.Sheet");
  assert.deepEqual(sheet.cells, {});

  const sheetId = sheet.$id;
  assert.equal(created.length, 1);

  // Persisted under `sheet:<sheetId>`.
  const raw = await fs.readFile(path.join(dataDir, "calc.json"), "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [`sheet:${sheetId}`]);
});

test("updateCell stores a value and evaluates =SUM over a range", async () => {
  const { calc } = await loadCalc();
  const doc = await calc.createSheet({ title: "Numbers" });
  const sheetId = (rootObject(doc)!.sheets as PBXReference[])[0].$ref;

  await calc.updateCell({ sheetId, coord: "A1", value: 10 });
  await calc.updateCell({ sheetId, coord: "A2", value: 5 });
  await calc.updateCell({ sheetId, coord: "A3", value: 7 });
  const sum = await calc.updateCell({ sheetId, coord: "A4", formula: "=SUM(A1:A3)" });

  assert.equal(sum.value, 22);
  assert.equal(sum.formula, "=SUM(A1:A3)");

  const avg = await calc.updateCell({ sheetId, coord: "B1", formula: "=AVERAGE(A1:A3)" });
  assert.equal(avg.value, 22 / 3);

  // Stored document reflects the evaluated value.
  const stored = await calc.getSheet(sheetId);
  const sheet = resolveRef(stored!, (rootObject(stored!)!.sheets as PBXReference[])[0])!;
  const a4 = resolveRef(stored!, (sheet.cells as Record<string, PBXReference>).A4)!;
  assert.equal(a4.value, 22);
});

test("updateCell rejects an invalid coordinate", async () => {
  const { calc } = await loadCalc();
  const doc = await calc.createSheet({});
  const sheetId = (rootObject(doc)!.sheets as PBXReference[])[0].$ref;
  await assert.rejects(
    calc.updateCell({ sheetId, coord: "not-a-cell", value: 1 }),
    /invalid coordinate/,
  );
});

test("evaluateAIFormula routes =AI(...) through ctx.ai and updates the cell", async () => {
  const { calc, hooks, vault } = await loadCalc();
  await vault.setSecret("ai.baseUrl", "http://localhost:11434");
  const updated: unknown[] = [];
  hooks.on("calc:cellUpdated", (p) => {
    updated.push(p);
  });

  const stub = stubFetch(["Hola mundo"]);

  try {
    const doc = await calc.createSheet({ title: "i18n" });
    const sheetId = (rootObject(doc)!.sheets as PBXReference[])[0].$ref;
    await calc.updateCell({ sheetId, coord: "A1", value: "Hello world" });
    await calc.updateCell({
      sheetId,
      coord: "B1",
      formula: '=AI("Translate to Spanish", A1)',
    });

    const cell = await calc.evaluateAIFormula({ sheetId, coord: "B1" });
    assert.equal(cell.value, "Hola mundo");
    assert.equal(cell.formula, '=AI("Translate to Spanish", A1)');
    assert.ok(stub.prompts.some((p) => p.includes("Translate to Spanish: Hello world")));
    assert.equal(updated.length, 3); // two updateCell + one evaluateAIFormula
  } finally {
    stub.restore();
  }
});

test("a failing AI formula degrades to #AI_ERR without crashing", async () => {
  const { calc, vault } = await loadCalc();
  await vault.setSecret("ai.baseUrl", "http://localhost:11434");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response("boom", { status: 500 });
  }) as typeof fetch;

  try {
    const doc = await calc.createSheet({ title: "Resilient" });
    const sheetId = (rootObject(doc)!.sheets as PBXReference[])[0].$ref;
    await calc.updateCell({ sheetId, coord: "A1", value: "data" });
    await calc.updateCell({ sheetId, coord: "B1", formula: "=AI('Summarize', A1)" });

    const cell = await calc.evaluateAIFormula({ sheetId, coord: "B1" });
    assert.equal(cell.value, AI_ERROR);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an AI formula with a missing cell reference emits #REF! in the prompt", async () => {
  const { calc, vault } = await loadCalc();
  await vault.setSecret("ai.baseUrl", "http://localhost:11434");
  const stub = stubFetch(["n/a"]);

  try {
    const doc = await calc.createSheet({ title: "Refs" });
    const sheetId = (rootObject(doc)!.sheets as PBXReference[])[0].$ref;
    await calc.updateCell({ sheetId, coord: "B1", formula: "=AI('Summarize', Z99)" });
    await calc.evaluateAIFormula({ sheetId, coord: "B1" });
    assert.ok(stub.prompts.some((p) => p.includes(REF_ERROR)));
  } finally {
    stub.restore();
  }
});

test("embedObject stores and resolves an OLE $ref inside a cell", async () => {
  const { calc, hooks } = await loadCalc();
  const updated: unknown[] = [];
  hooks.on("calc:cellUpdated", (p) => {
    updated.push(p);
  });

  const doc = await calc.createSheet({ title: "Design" });
  const sheetId = (rootObject(doc)!.sheets as PBXReference[])[0].$ref;

  const cell = await calc.embedObject({
    sheetId,
    coord: "C3",
    targetObjectId: "note-123",
    targetClass: "P2P.SmartNote",
  });

  const embedRef = cell.embeddedObject as PBXReference;
  assert.equal(typeof embedRef.$ref, "string");

  const stored = await calc.getSheet(sheetId);
  const embedded = resolveRef(stored!, embedRef)!;
  assert.equal(embedded.$class, "P2P.EmbeddedObject");
  assert.equal(embedded.targetId, "note-123");
  assert.equal(embedded.targetClass, "P2P.SmartNote");

  // OLE validation: the cell -> embedded object link resolves.
  const sheet = resolveRef(stored!, (rootObject(stored!)!.sheets as PBXReference[])[0])!;
  const cellRef = (sheet.cells as Record<string, PBXReference>).C3;
  const cellFromStore = resolveRef(stored!, cellRef)!;
  assert.equal(resolveRef(stored!, cellFromStore.embeddedObject as PBXReference), embedded);
  assert.equal(updated.length, 1);
});

test("aiFillColumn predicts values for empty cells in a range", async () => {
  const { calc, vault } = await loadCalc();
  await vault.setSecret("ai.baseUrl", "http://localhost:11434");
  const stub = stubFetch(["Mar", "Apr"]);

  try {
    const doc = await calc.createSheet({ title: "Months" });
    const sheetId = (rootObject(doc)!.sheets as PBXReference[])[0].$ref;
    await calc.updateCell({ sheetId, coord: "A1", value: "Jan" });
    await calc.updateCell({ sheetId, coord: "A2", value: "Feb" });

    const result = await calc.aiFillColumn({
      sheetId,
      startCoord: "A1",
      endCoord: "A4",
      instruction: "Continue the sequence of months",
    });

    assert.deepEqual(result.filled, ["A3", "A4"]);
    assert.equal(result.values.A3, "Mar");
    assert.equal(result.values.A4, "Apr");
    assert.ok(stub.prompts.every((p) => p.includes("Continue the sequence of months")));
  } finally {
    stub.restore();
  }
});

test("skills are registered in the calc namespace and local-only", async () => {
  const { broker } = await loadCalc();
  const names = broker.listSkills().map((s) => s.skill).sort();
  assert.deepEqual(names, [
    "calc.aiFillColumn",
    "calc.createSheet",
    "calc.deleteCols",
    "calc.deleteRows",
    "calc.embedObject",
    "calc.evaluateAIFormula",
    "calc.getSheet",
    "calc.insertCols",
    "calc.insertRows",
    "calc.listSheets",
    "calc.updateCell",
    "calc.updateCells",
  ]);
  for (const entry of broker.listSkills()) {
    assert.equal(entry.localOnly, true);
  }
});

/* ------------------------------------------------------------------ */
/* Recalculation & structural edits                                     */
/* ------------------------------------------------------------------ */

test("changing a source cell propagates to dependent formulas", async () => {
  const { calc } = await loadCalc();
  const doc = await calc.createSheet({ title: "Dep" });
  const sheetId = (rootObject(doc)!.sheets as PBXReference[])[0].$ref;

  await calc.updateCell({ sheetId, coord: "A1", value: 10 });
  await calc.updateCell({ sheetId, coord: "A2", value: 5 });
  await calc.updateCell({ sheetId, coord: "A3", formula: "=A1+A2" });

  // Change A1 -> A3 must reflect the new sum.
  await calc.updateCell({ sheetId, coord: "A1", value: 20 });
  const stored = await calc.getSheet(sheetId);
  const sheet = resolveRef(stored!, (rootObject(stored!)!.sheets as PBXReference[])[0])!;
  const a3 = resolveRef(stored!, (sheet.cells as Record<string, PBXReference>).A3)!;
  assert.equal(a3.value, 25);
});

test("arithmetic and function formulas evaluate through the engine", async () => {
  const { calc } = await loadCalc();
  const doc = await calc.createSheet({ title: "Eng" });
  const sheetId = (rootObject(doc)!.sheets as PBXReference[])[0].$ref;

  await calc.updateCell({ sheetId, coord: "A1", value: 1 });
  await calc.updateCell({ sheetId, coord: "A2", value: 2 });
  await calc.updateCell({ sheetId, coord: "A3", value: 3 });
  const total = await calc.updateCell({ sheetId, coord: "B1", formula: "=SUM(A1:A3)*2" });
  assert.equal(total.value, 12);

  const avg = await calc.updateCell({ sheetId, coord: "B2", formula: "=AVERAGE(A1:A3)" });
  assert.equal(avg.value, 2);

  const cond = await calc.updateCell({ sheetId, coord: "B3", formula: '=IF(B1>10,"big","small")' });
  assert.equal(cond.value, "big");
});

test("insertRows shifts cells and rewrites relative references", async () => {
  const { calc } = await loadCalc();
  const doc = await calc.createSheet({ title: "Rows" });
  const sheetId = (rootObject(doc)!.sheets as PBXReference[])[0].$ref;

  await calc.updateCell({ sheetId, coord: "A1", value: 1 });
  await calc.updateCell({ sheetId, coord: "A2", value: 2 });
  await calc.updateCell({ sheetId, coord: "B1", formula: "=SUM(A1:A2)" });

  await calc.insertRows({ sheetId, at: 0, count: 1 });

  const stored = await calc.getSheet(sheetId);
  const sheet = resolveRef(stored!, (rootObject(stored!)!.sheets as PBXReference[])[0])!;
  const cells = sheet.cells as Record<string, PBXReference>;

  // Values shifted down: A1 -> A2, A2 -> A3.
  const a2 = resolveRef(stored!, cells.A2)!;
  assert.equal(a2.value, 1);
  const a3 = resolveRef(stored!, cells.A3)!;
  assert.equal(a3.value, 2);

  // Formula moved B1 -> B1 (row 0 is above the inserted row at index 0? no:
  // B1 is at row 0, insertion at index 0 shifts it to B2) and reference
  // rewrites SUM(A1:A2) -> SUM(A2:A3).
  const b2 = resolveRef(stored!, cells.B2)!;
  assert.equal(b2.formula, "=SUM(A2:A3)");
  assert.equal(b2.value, 3);
});

test("deleteRows removes shifted cells and shortens references", async () => {
  const { calc } = await loadCalc();
  const doc = await calc.createSheet({ title: "Del" });
  const sheetId = (rootObject(doc)!.sheets as PBXReference[])[0].$ref;

  await calc.updateCell({ sheetId, coord: "A1", value: 1 });
  await calc.updateCell({ sheetId, coord: "A2", value: 2 });
  await calc.updateCell({ sheetId, coord: "A3", value: 3 });
  await calc.updateCell({ sheetId, coord: "B1", formula: "=SUM(A1:A3)" });

  // Delete row index 1 (row 2): A2 is removed, A3 shifts up to A2.
  await calc.deleteRows({ sheetId, at: 1, count: 1 });

  const stored = await calc.getSheet(sheetId);
  const sheet = resolveRef(stored!, (rootObject(stored!)!.sheets as PBXReference[])[0])!;
  const cells = sheet.cells as Record<string, PBXReference>;

  const a1 = resolveRef(stored!, cells.A1)!;
  assert.equal(a1.value, 1);
  const a2 = resolveRef(stored!, cells.A2)!;
  assert.equal(a2.value, 3); // A3 shifted up into A2

  const b1 = resolveRef(stored!, cells.B1)!;
  assert.equal(b1.formula, "=SUM(A1:A2)");
  assert.equal(b1.value, 4);
});

test("updateCells applies a batch and recalculates once", async () => {
  const { calc } = await loadCalc();
  const doc = await calc.createSheet({ title: "Batch" });
  const sheetId = (rootObject(doc)!.sheets as PBXReference[])[0].$ref;

  const cells = await calc.updateCells({
    sheetId,
    updates: [
      { coord: "A1", value: 4 },
      { coord: "A2", value: 6 },
      { coord: "A3", formula: "=SUM(A1:A2)" },
    ],
  });

  assert.equal(cells.length, 3);
  const stored = await calc.getSheet(sheetId);
  const sheet = resolveRef(stored!, (rootObject(stored!)!.sheets as PBXReference[])[0])!;
  const a3 = resolveRef(stored!, (sheet.cells as Record<string, PBXReference>).A3)!;
  assert.equal(a3.value, 10);
});

test("circular references degrade to #CYCLE! instead of hanging", async () => {
  const { calc } = await loadCalc();
  const doc = await calc.createSheet({ title: "Cycle" });
  const sheetId = (rootObject(doc)!.sheets as PBXReference[])[0].$ref;

  await calc.updateCell({ sheetId, coord: "A1", formula: "=A1+1" });
  const stored = await calc.getSheet(sheetId);
  const sheet = resolveRef(stored!, (rootObject(stored!)!.sheets as PBXReference[])[0])!;
  const a1 = resolveRef(stored!, (sheet.cells as Record<string, PBXReference>).A1)!;
  assert.equal(a1.value, "#CYCLE!");
});
