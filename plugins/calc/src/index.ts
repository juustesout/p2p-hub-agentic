import type { PluginContext } from "@p2p-hub/core";
import {
  addObject,
  createDocument,
  linkObject,
  resolveRef,
  rootObject,
  type PBXDocument,
  type PBXObject,
  type PBXReference,
} from "@p2p-hub/sdk";
import {
  AI_ERROR,
  ERROR_ERROR,
  REF_ERROR,
  coordToLabel,
  evaluateExpression,
  isAIFormula,
  isErrorValue,
  makeRefMutator,
  makeShifts,
  parseCoord,
  parseExpression,
  parseRange,
  rangeCells,
  rewriteRefs,
  shiftCoord,
  stringifyExpression,
  type CellValue,
  type Expr,
} from "./formula";

/**
 * dreamsheet (AI Grid & Sheet) — a generative spreadsheet on the PBX/OLE
 * standard.
 *
 * A workbook is a `P2P.Spreadsheet` root linking to `P2P.Sheet` children;
 * each sheet maps A1-style coordinates to `P2P.Cell` objects via `$ref`
 * pointers. Cells hold a raw `value`, an optional `formula`, an optional
 * `format`, and an optional OLE `embeddedObject` link.
 *
 * Formulae are evaluated eagerly and recursively (with cycle detection), so a
 * change to one cell propagates to every dependent formula before the sheet is
 * persisted.
 */

export interface CreateSheetInput {
  title?: string;
  rowCount?: number;
  colCount?: number;
}

export interface UpdateCellInput {
  sheetId: string;
  coord: string;
  value?: CellValue;
  formula?: string;
  format?: Record<string, unknown>;
}

export interface BulkUpdate {
  coord: string;
  value?: CellValue;
  formula?: string;
  format?: Record<string, unknown>;
}

export interface UpdateCellsInput {
  sheetId: string;
  updates: BulkUpdate[];
}

export interface StructuralInput {
  sheetId: string;
  at: number;
  count: number;
}

export interface EvaluateAIFormulaInput {
  sheetId: string;
  coord: string;
}

export interface EmbedObjectInput {
  sheetId: string;
  coord: string;
  targetObjectId: string;
  targetClass: string;
}

export interface AiFillColumnInput {
  sheetId: string;
  startCoord: string;
  endCoord: string;
  instruction: string;
}

export interface AiFillColumnResult {
  sheetId: string;
  filled: string[];
  values: Record<string, CellValue>;
}

export interface SheetSummary {
  sheetId: string;
  title: string;
}

export interface CalcPlugin {
  createSheet(input: CreateSheetInput): Promise<PBXDocument>;
  getSheet(sheetId: string): Promise<PBXDocument | null>;
  listSheets(): Promise<SheetSummary[]>;
  updateCell(input: UpdateCellInput): Promise<PBXObject>;
  updateCells(input: UpdateCellsInput): Promise<PBXObject[]>;
  insertRows(input: StructuralInput): Promise<PBXDocument>;
  deleteRows(input: StructuralInput): Promise<PBXDocument>;
  insertCols(input: StructuralInput): Promise<PBXDocument>;
  deleteCols(input: StructuralInput): Promise<PBXDocument>;
  evaluateAIFormula(input: EvaluateAIFormulaInput): Promise<PBXObject>;
  embedObject(input: EmbedObjectInput): Promise<PBXObject>;
  aiFillColumn(input: AiFillColumnInput): Promise<AiFillColumnResult>;
}

const SHEET_KEY_PREFIX = "sheet:";
const SPREADSHEET_CLASS = "P2P.Spreadsheet";
const SHEET_CLASS = "P2P.Sheet";
const CELL_CLASS = "P2P.Cell";
const EMBEDDED_CLASS = "P2P.EmbeddedObject";

const DEFAULT_ROWS = 1000;
const DEFAULT_COLS = 100;

function sheetKey(sheetId: string): string {
  return `${SHEET_KEY_PREFIX}${sheetId}`;
}

function normalizeCoord(coord: string): string {
  return coord.trim().toUpperCase();
}

function isPBXDocument(value: unknown): value is PBXDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as PBXDocument).$top === "object" &&
    typeof (value as PBXDocument).$objects === "object"
  );
}

export default function activate(ctx: PluginContext): CalcPlugin {
  async function getSheet(sheetId: string): Promise<PBXDocument | null> {
    const value = await ctx.storage.get(sheetKey(sheetId));
    return isPBXDocument(value) ? value : null;
  }

  async function requireSheet(
    sheetId: string,
  ): Promise<{ doc: PBXDocument; sheet: PBXObject }> {
    const doc = await getSheet(sheetId);
    if (!doc) {
      throw new Error(`sheet "${sheetId}" not found`);
    }
    const root = rootObject(doc);
    if (!root || root.$class !== SPREADSHEET_CLASS) {
      throw new Error(`"${sheetId}" is not a valid spreadsheet document`);
    }
    const refs = Array.isArray(root.sheets)
      ? (root.sheets as PBXReference[])
      : [];
    for (const ref of refs) {
      const sheet = resolveRef(doc, ref);
      if (sheet && sheet.$id === sheetId) {
        return { doc, sheet };
      }
    }
    throw new Error(`sheet "${sheetId}" not found`);
  }

  function cellAt(
    doc: PBXDocument,
    sheet: PBXObject,
    coord: string,
  ): PBXObject | null {
    const cells = sheet.cells as Record<string, PBXReference> | undefined;
    const ref = cells?.[coord];
    if (!ref) return null;
    return resolveRef(doc, ref);
  }

  function cellValue(
    doc: PBXDocument,
    sheet: PBXObject,
    coord: string,
  ): CellValue {
    const cell = cellAt(doc, sheet, coord);
    if (!cell || cell.value === undefined || cell.value === null) {
      return null;
    }
    return cell.value as CellValue;
  }

  function ensureCell(
    doc: PBXDocument,
    sheet: PBXObject,
    coord: string,
  ): PBXObject {
    const existing = cellAt(doc, sheet, coord);
    if (existing) return existing;
    const cellId = addObject(doc, CELL_CLASS, {
      coord,
      value: null,
      formula: null,
      format: null,
      embeddedObject: null,
    });
    const cells = (sheet.cells ?? {}) as Record<string, PBXReference>;
    cells[coord] = linkObject(doc, cellId);
    sheet.cells = cells;
    return doc.$objects[cellId];
  }

  /**
   * Recompute every formula cell in the sheet. References resolve recursively
   * (so a formula can depend on another formula) and cycles degrade to
   * `#CYCLE!` instead of infinite recursion.
   */
  function recalcSheet(doc: PBXDocument, sheet: PBXObject): void {
    const cells = (sheet.cells ?? {}) as Record<string, PBXReference>;
    const memo = new Map<string, CellValue>();
    const visiting = new Set<string>();

    const resolve = (coord: string): CellValue => {
      const key = normalizeCoord(coord);
      if (memo.has(key)) return memo.get(key)!;
      if (visiting.has(key)) return "#CYCLE!";
      const cell = cellAt(doc, sheet, key);
      if (!cell) {
        memo.set(key, null);
        return null;
      }
      if (typeof cell.formula === "string" && cell.formula !== "") {
        let ast: Expr | null = null;
        try {
          ast = parseExpression(cell.formula);
        } catch {
          ast = null;
        }
        if (ast && !isAIFormula(ast)) {
          visiting.add(key);
          let value: CellValue;
          try {
            value = evaluateExpression(ast, resolve);
          } catch {
            value = ERROR_ERROR;
          }
          visiting.delete(key);
          memo.set(key, value);
          return value;
        }
        memo.set(key, null);
        return null;
      }
      const v = (cell.value ?? null) as CellValue;
      memo.set(key, v);
      return v;
    };

    for (const coord of Object.keys(cells)) {
      const key = normalizeCoord(coord);
      const cell = cellAt(doc, sheet, key);
      if (!cell || typeof cell.formula !== "string" || cell.formula === "") {
        continue;
      }
      let ast: Expr | null = null;
      try {
        ast = parseExpression(cell.formula);
      } catch {
        cell.value = ERROR_ERROR;
        continue;
      }
      if (!ast || isAIFormula(ast)) {
        // AI (or blank) formula: leave value pending for `evaluateAIFormula`.
        continue;
      }
      try {
        cell.value = evaluateExpression(ast, resolve);
      } catch {
        cell.value = ERROR_ERROR;
      }
    }
  }

  function bumpUpdatedAt(doc: PBXDocument): void {
    const root = rootObject(doc);
    if (root) {
      root.updatedAt = new Date().toISOString();
    }
  }

  /* ---------------- CRUD ---------------- */

  async function createSheet(input: CreateSheetInput): Promise<PBXDocument> {
    const title = (input.title ?? "").trim() || "Untitled sheet";
    const rowCount = input.rowCount ?? DEFAULT_ROWS;
    const colCount = input.colCount ?? DEFAULT_COLS;
    const now = new Date().toISOString();

    const doc = createDocument(SPREADSHEET_CLASS, {
      title,
      createdAt: now,
      updatedAt: now,
    });
    const root = rootObject(doc)!;

    const sheetId = addObject(doc, SHEET_CLASS, {
      name: "Sheet1",
      rowCount,
      colCount,
      cells: {},
    });
    root.sheets = [linkObject(doc, sheetId)];

    await ctx.storage.set(sheetKey(sheetId), doc);
    await ctx.hooks.emit("calc:sheetCreated", { sheetId, title });
    return doc;
  }

  async function listSheets(): Promise<SheetSummary[]> {
    const keys = await ctx.storage.list(SHEET_KEY_PREFIX);
    const summaries: SheetSummary[] = [];
    for (const key of keys) {
      const doc = await ctx.storage.get(key);
      if (!isPBXDocument(doc)) continue;
      const root = rootObject(doc);
      summaries.push({
        sheetId: key.slice(SHEET_KEY_PREFIX.length),
        title: (root?.title as string | undefined) ?? "Untitled",
      });
    }
    return summaries;
  }

  async function updateCell(input: UpdateCellInput): Promise<PBXObject> {
    const coord = normalizeCoord(input.coord);
    if (!parseCoord(coord)) {
      throw new Error(`updateCell: invalid coordinate "${input.coord}"`);
    }
    const { doc, sheet } = await requireSheet(input.sheetId);
    const cell = ensureCell(doc, sheet, coord);

    if (input.formula !== undefined) {
      cell.formula = input.formula;
    } else if (input.value !== undefined) {
      cell.formula = null;
      cell.value = input.value;
    }
    if (input.format !== undefined) {
      cell.format = input.format;
    }
    cell.updatedAt = new Date().toISOString();

    recalcSheet(doc, sheet);
    bumpUpdatedAt(doc);
    await ctx.storage.set(sheetKey(input.sheetId), doc);
    await ctx.hooks.emit("calc:cellUpdated", { sheetId: input.sheetId, coord });
    return cell;
  }

  async function updateCells(input: UpdateCellsInput): Promise<PBXObject[]> {
    const { doc, sheet } = await requireSheet(input.sheetId);
    const touched: PBXObject[] = [];

    for (const update of input.updates) {
      const coord = normalizeCoord(update.coord);
      if (!parseCoord(coord)) continue;
      const cell = ensureCell(doc, sheet, coord);
      if (update.formula !== undefined) {
        cell.formula = update.formula;
      } else if (update.value !== undefined) {
        cell.formula = null;
        cell.value = update.value;
      }
      if (update.format !== undefined) {
        cell.format = update.format;
      }
      cell.updatedAt = new Date().toISOString();
      touched.push(cell);
    }

    recalcSheet(doc, sheet);
    bumpUpdatedAt(doc);
    await ctx.storage.set(sheetKey(input.sheetId), doc);
    if (touched.length > 0) {
      await ctx.hooks.emit("calc:cellUpdated", {
        sheetId: input.sheetId,
        coords: input.updates.map((u) => normalizeCoord(u.coord)),
      });
    }
    return touched;
  }

  /* ---------------- structural edits ---------------- */

  async function structuralEdit(
    input: StructuralInput,
    kind: "insertRows" | "deleteRows" | "insertCols" | "deleteCols",
  ): Promise<PBXDocument> {
    const { doc, sheet } = await requireSheet(input.sheetId);
    const cells = (sheet.cells ?? {}) as Record<string, PBXReference>;
    const { shiftRow, shiftCol } = makeShifts(kind, input.at, input.count);
    const mutate = makeRefMutator(shiftRow, shiftCol);

    const nextCells: Record<string, PBXReference> = {};
    for (const coord of Object.keys(cells)) {
      const ref = cells[coord];
      const cell = resolveRef(doc, ref);
      if (!cell) continue;
      const newCoord = shiftCoord(coord, shiftRow, shiftCol);
      if (!newCoord) continue; // cell removed

      if (typeof cell.formula === "string" && cell.formula !== "") {
        let ast: Expr | null = null;
        try {
          ast = parseExpression(cell.formula);
        } catch {
          ast = null;
        }
        if (ast) {
          cell.formula = "=" + stringifyExpression(rewriteRefs(ast, mutate));
        }
      }

      cell.coord = newCoord;
      nextCells[newCoord] = ref;
    }
    sheet.cells = nextCells;

    if (kind === "insertRows" || kind === "deleteRows") {
      const current = typeof sheet.rowCount === "number" ? sheet.rowCount : DEFAULT_ROWS;
      sheet.rowCount =
        kind === "insertRows" ? current + input.count : current - input.count;
    } else {
      const current = typeof sheet.colCount === "number" ? sheet.colCount : DEFAULT_COLS;
      sheet.colCount =
        kind === "insertCols" ? current + input.count : current - input.count;
    }

    recalcSheet(doc, sheet);
    bumpUpdatedAt(doc);
    await ctx.storage.set(sheetKey(input.sheetId), doc);
    await ctx.hooks.emit("calc:structureChanged", {
      sheetId: input.sheetId,
      kind,
      at: input.at,
      count: input.count,
    });
    return doc;
  }

  /* ---------------- AI + OLE ---------------- */

  async function evaluateAIFormula(
    input: EvaluateAIFormulaInput,
  ): Promise<PBXObject> {
    const coord = normalizeCoord(input.coord);
    const { doc, sheet } = await requireSheet(input.sheetId);
    const cell = cellAt(doc, sheet, coord);
    if (!cell) {
      throw new Error(`evaluateAIFormula: no cell at "${coord}"`);
    }

    const parsed =
      typeof cell.formula === "string" ? parseExpression(cell.formula) : null;
    if (!parsed || !isAIFormula(parsed)) {
      throw new Error(`evaluateAIFormula: cell "${coord}" has no AI formula`);
    }

    const aiCall = parsed as Expr & { type: "func"; args: Expr[] };
    const prompt = aiCall.args[0]?.type === "str" ? aiCall.args[0].value : "";
    const refArg = aiCall.args[1]?.type === "cell" ? aiCall.args[1].ref.coord : null;
    const refValue = refArg ? cellValue(doc, sheet, refArg) : null;
    const refText = isErrorValue(refValue) || refValue === null ? REF_ERROR : refValue;

    try {
      cell.value = await ctx.ai.generateText({
        prompt: `${prompt}: ${refText}`,
      });
    } catch {
      cell.value = AI_ERROR;
    }
    cell.updatedAt = new Date().toISOString();

    bumpUpdatedAt(doc);
    await ctx.storage.set(sheetKey(input.sheetId), doc);
    await ctx.hooks.emit("calc:cellUpdated", { sheetId: input.sheetId, coord });
    return cell;
  }

  async function embedObject(input: EmbedObjectInput): Promise<PBXObject> {
    const coord = normalizeCoord(input.coord);
    if (!input.targetObjectId || !input.targetClass) {
      throw new Error("embedObject: targetObjectId and targetClass are required");
    }
    const { doc, sheet } = await requireSheet(input.sheetId);
    const cell = ensureCell(doc, sheet, coord);

    const embedId = addObject(doc, EMBEDDED_CLASS, {
      targetClass: input.targetClass,
      targetId: input.targetObjectId,
      embeddedAt: new Date().toISOString(),
    });
    cell.embeddedObject = linkObject(doc, embedId);
    cell.updatedAt = new Date().toISOString();

    bumpUpdatedAt(doc);
    await ctx.storage.set(sheetKey(input.sheetId), doc);
    await ctx.hooks.emit("calc:cellUpdated", {
      sheetId: input.sheetId,
      coord,
      embeddedObjectId: embedId,
    });
    return cell;
  }

  async function aiFillColumn(
    input: AiFillColumnInput,
  ): Promise<AiFillColumnResult> {
    const startCoord = normalizeCoord(input.startCoord);
    const endCoord = normalizeCoord(input.endCoord);
    const range = parseRange(`${startCoord}:${endCoord}`);
    if (!range) {
      throw new Error("aiFillColumn: invalid coordinate range");
    }
    const { doc, sheet } = await requireSheet(input.sheetId);
    const coords = rangeCells(range);

    const context: string[] = coords
      .map((c) => cellValue(doc, sheet, c))
      .filter((v): v is string | number => v !== null)
      .map((v) => String(v));

    const emptyCoords = coords.filter((c) => cellValue(doc, sheet, c) === null);
    const values: Record<string, CellValue> = {};

    for (const c of emptyCoords) {
      const prompt =
        `${input.instruction}. Existing sequence: ${context.join(", ") || "(none)"}. ` +
        `Return only the next value for the cell.`;
      let result: CellValue;
      try {
        result = (await ctx.ai.generateText({ prompt })).trim();
      } catch {
        result = AI_ERROR;
      }
      const cell = ensureCell(doc, sheet, c);
      cell.value = result;
      cell.updatedAt = new Date().toISOString();
      context.push(String(result));
      values[c] = result;
    }

    bumpUpdatedAt(doc);
    await ctx.storage.set(sheetKey(input.sheetId), doc);
    await ctx.hooks.emit("calc:cellUpdated", {
      sheetId: input.sheetId,
      coords: emptyCoords,
    });

    return { sheetId: input.sheetId, filled: emptyCoords, values };
  }

  /* ---------------- skill registration ---------------- */

  ctx.skills.register(
    "createSheet",
    async (payload) => {
      const { title, rowCount, colCount } = (payload ?? {}) as {
        title?: unknown;
        rowCount?: unknown;
        colCount?: unknown;
      };
      if (title !== undefined && typeof title !== "string") {
        throw new Error("createSheet expects { title?: string }");
      }
      return createSheet({
        title,
        rowCount: typeof rowCount === "number" ? rowCount : undefined,
        colCount: typeof colCount === "number" ? colCount : undefined,
      });
    },
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register("listSheets", async () => listSheets(), { localOnly: true, httpExposed: true });

  ctx.skills.register(
    "getSheet",
    async (payload) => {
      const { sheetId } = (payload ?? {}) as { sheetId?: unknown };
      if (typeof sheetId !== "string") {
        throw new Error("getSheet expects { sheetId: string }");
      }
      return getSheet(sheetId);
    },
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "updateCell",
    async (payload) => {
      const { sheetId, coord, value, formula, format } = (payload ?? {}) as {
        sheetId?: unknown;
        coord?: unknown;
        value?: unknown;
        formula?: unknown;
        format?: unknown;
      };
      if (typeof sheetId !== "string" || typeof coord !== "string") {
        throw new Error("updateCell expects { sheetId: string, coord: string }");
      }
      return updateCell({
        sheetId,
        coord,
        value: value as CellValue | undefined,
        formula: typeof formula === "string" ? formula : undefined,
        format:
          typeof format === "object" && format !== null
            ? (format as Record<string, unknown>)
            : undefined,
      });
    },
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "updateCells",
    async (payload) => {
      const { sheetId, updates } = (payload ?? {}) as {
        sheetId?: unknown;
        updates?: unknown;
      };
      if (typeof sheetId !== "string" || !Array.isArray(updates)) {
        throw new Error(
          "updateCells expects { sheetId: string, updates: BulkUpdate[] }",
        );
      }
      return updateCells({
        sheetId,
        updates: updates as BulkUpdate[],
      });
    },
    { localOnly: true, httpExposed: true },
  );

  for (const kind of ["insertRows", "deleteRows", "insertCols", "deleteCols"] as const) {
    ctx.skills.register(
      kind,
      async (payload) => {
        const { sheetId, at, count } = (payload ?? {}) as {
          sheetId?: unknown;
          at?: unknown;
          count?: unknown;
        };
        if (
          typeof sheetId !== "string" ||
          typeof at !== "number" ||
          typeof count !== "number"
        ) {
          throw new Error(`${kind} expects { sheetId: string, at: number, count: number }`);
        }
        return structuralEdit({ sheetId, at, count }, kind);
      },
      { localOnly: true, httpExposed: true },
    );
  }

  ctx.skills.register(
    "evaluateAIFormula",
    async (payload) => {
      const { sheetId, coord } = (payload ?? {}) as {
        sheetId?: unknown;
        coord?: unknown;
      };
      if (typeof sheetId !== "string" || typeof coord !== "string") {
        throw new Error(
          "evaluateAIFormula expects { sheetId: string, coord: string }",
        );
      }
      return evaluateAIFormula({ sheetId, coord });
    },
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "embedObject",
    async (payload) => {
      const { sheetId, coord, targetObjectId, targetClass } = (payload ?? {}) as {
        sheetId?: unknown;
        coord?: unknown;
        targetObjectId?: unknown;
        targetClass?: unknown;
      };
      if (
        typeof sheetId !== "string" ||
        typeof coord !== "string" ||
        typeof targetObjectId !== "string" ||
        typeof targetClass !== "string"
      ) {
        throw new Error(
          "embedObject expects { sheetId: string, coord: string, targetObjectId: string, targetClass: string }",
        );
      }
      return embedObject({ sheetId, coord, targetObjectId, targetClass });
    },
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "aiFillColumn",
    async (payload) => {
      const { sheetId, startCoord, endCoord, instruction } = (payload ?? {}) as {
        sheetId?: unknown;
        startCoord?: unknown;
        endCoord?: unknown;
        instruction?: unknown;
      };
      if (
        typeof sheetId !== "string" ||
        typeof startCoord !== "string" ||
        typeof endCoord !== "string" ||
        typeof instruction !== "string"
      ) {
        throw new Error(
          "aiFillColumn expects { sheetId: string, startCoord: string, endCoord: string, instruction: string }",
        );
      }
      return aiFillColumn({ sheetId, startCoord, endCoord, instruction });
    },
    { localOnly: true, httpExposed: true },
  );

  return {
    createSheet,
    getSheet,
    listSheets,
    updateCell,
    updateCells,
    insertRows: (i) => structuralEdit(i, "insertRows"),
    deleteRows: (i) => structuralEdit(i, "deleteRows"),
    insertCols: (i) => structuralEdit(i, "insertCols"),
    deleteCols: (i) => structuralEdit(i, "deleteCols"),
    evaluateAIFormula,
    embedObject,
    aiFillColumn,
  };
}
