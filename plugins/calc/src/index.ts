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
  REF_ERROR,
  evaluateMath,
  parseCoord,
  parseFormula,
  parseRange,
  rangeCells,
  type CellValue,
  type Formula,
} from "./formula";

/**
 * AI Grid & Sheet — a generative spreadsheet on the PBX/OLE standard.
 *
 * A workbook is a `P2P.Spreadsheet` root linking to `P2P.Sheet` children;
 * each sheet maps A1-style coordinates to `P2P.Cell` objects via `$ref`
 * pointers. Cells hold a raw `value`, an optional `formula` (`=SUM(...)`,
 * `=AVERAGE(...)` or `=AI(...)`), and an optional OLE `embeddedObject` link to
 * any other PBX object (a Smart Note, a Canvas image, …).
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
  evaluateAIFormula(input: EvaluateAIFormulaInput): Promise<PBXObject>;
  embedObject(input: EmbedObjectInput): Promise<PBXObject>;
  aiFillColumn(input: AiFillColumnInput): Promise<AiFillColumnResult>;
}

const SHEET_KEY_PREFIX = "sheet:";
const SPREADSHEET_CLASS = "P2P.Spreadsheet";
const SHEET_CLASS = "P2P.Sheet";
const CELL_CLASS = "P2P.Cell";
const EMBEDDED_CLASS = "P2P.EmbeddedObject";

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
    if (!ref) {
      return null;
    }
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
    if (existing) {
      return existing;
    }
    const cellId = addObject(doc, CELL_CLASS, {
      coord,
      value: null,
      formula: null,
      embeddedObject: null,
    });
    const cells = (sheet.cells ?? {}) as Record<string, PBXReference>;
    cells[coord] = linkObject(doc, cellId);
    sheet.cells = cells;
    return doc.$objects[cellId];
  }

  function evaluateMathFormula(
    doc: PBXDocument,
    sheet: PBXObject,
    formula: Formula,
  ): CellValue {
    if (formula.kind === "ai") {
      return null;
    }
    const range = parseRange(formula.range);
    if (!range) {
      return REF_ERROR;
    }
    return evaluateMath(
      formula.kind,
      rangeCells(range).map((c) => cellValue(doc, sheet, c)),
    );
  }

  function bumpUpdatedAt(doc: PBXDocument): void {
    const root = rootObject(doc);
    if (root) {
      root.updatedAt = new Date().toISOString();
    }
  }

  async function createSheet(input: CreateSheetInput): Promise<PBXDocument> {
    const title = (input.title ?? "").trim() || "Untitled sheet";
    const rowCount = input.rowCount ?? 100;
    const colCount = input.colCount ?? 26;
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
      if (!isPBXDocument(doc)) {
        continue;
      }
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
      const parsed = parseFormula(input.formula);
      if (parsed && parsed.kind !== "ai") {
        cell.value = evaluateMathFormula(doc, sheet, parsed);
      } else {
        // AI (or unrecognised) formula: leave the value pending/empty until
        // `calc.evaluateAIFormula` runs.
        cell.value = null;
      }
    } else if (input.value !== undefined) {
      cell.formula = null;
      cell.value = input.value;
    }
    if (input.format !== undefined) {
      cell.format = input.format;
    }
    cell.updatedAt = new Date().toISOString();

    bumpUpdatedAt(doc);
    await ctx.storage.set(sheetKey(input.sheetId), doc);
    await ctx.hooks.emit("calc:cellUpdated", {
      sheetId: input.sheetId,
      coord,
    });
    return cell;
  }

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
      typeof cell.formula === "string" ? parseFormula(cell.formula) : null;
    if (!parsed || parsed.kind !== "ai") {
      throw new Error(`evaluateAIFormula: cell "${coord}" has no AI formula`);
    }

    const refCell = cellAt(doc, sheet, parsed.ref);
    const refValue = refCell ? cellValue(doc, sheet, parsed.ref) : REF_ERROR;

    try {
      cell.value = await ctx.ai.generateText({
        prompt: `${parsed.prompt}: ${refValue}`,
      });
    } catch {
      cell.value = AI_ERROR;
    }
    cell.updatedAt = new Date().toISOString();

    bumpUpdatedAt(doc);
    await ctx.storage.set(sheetKey(input.sheetId), doc);
    await ctx.hooks.emit("calc:cellUpdated", {
      sheetId: input.sheetId,
      coord,
    });
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
    { localOnly: true },
  );

  ctx.skills.register(
    "listSheets",
    async () => listSheets(),
    { localOnly: true },
  );

  ctx.skills.register(
    "getSheet",
    async (payload) => {
      const { sheetId } = (payload ?? {}) as { sheetId?: unknown };
      if (typeof sheetId !== "string") {
        throw new Error("getSheet expects { sheetId: string }");
      }
      return getSheet(sheetId);
    },
    { localOnly: true },
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
    { localOnly: true },
  );

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
    { localOnly: true },
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
    { localOnly: true },
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
    { localOnly: true },
  );

  return {
    createSheet,
    getSheet,
    listSheets,
    updateCell,
    evaluateAIFormula,
    embedObject,
    aiFillColumn,
  };
}
