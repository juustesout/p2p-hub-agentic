/**
 * Formula engine for the AI Sheet.
 *
 * Pure, side-effect-free helpers for spreadsheet coordinates, ranges and
 * formula parsing/evaluation. AI formulas (`=AI(...)`) are *recognised* here
 * but never executed — network/AI work happens in the plugin skill through
 * `ctx.ai`, keeping this module deterministic and trivially unit-testable.
 */

/** A raw scalar a cell can hold. */
export type CellValue = string | number | boolean | null;

/** Display token for a dangling/missing cell reference. */
export const REF_ERROR = "#REF!";
/** Display token for a failed AI formula. */
export const AI_ERROR = "#AI_ERR";
/** Display token for an undefined arithmetic result (e.g. empty average). */
export const DIV0_ERROR = "#DIV/0!";

export interface CellCoord {
  /** Zero-based column index. */
  col: number;
  /** Zero-based row index. */
  row: number;
}

const COORD_RE = /^([A-Za-z]+)(\d+)$/;

/** Parse an A1-style coordinate ("B2") into zero-based `{ col, row }`. */
export function parseCoord(coord: string): CellCoord | null {
  const m = COORD_RE.exec(coord.trim());
  if (!m) {
    return null;
  }
  let col = 0;
  for (const ch of m[1].toUpperCase()) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

/** Format zero-based `{ col, row }` back into an A1-style label. */
export function coordToLabel(col: number, row: number): string {
  let c = col + 1;
  let letters = "";
  while (c > 0) {
    const rem = (c - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    c = Math.floor((c - 1) / 26);
  }
  return `${letters}${row + 1}`;
}

export interface CellRange {
  start: string;
  end: string;
}

const RANGE_RE = /^([A-Za-z]+\d+)(?::([A-Za-z]+\d+))?$/;

/** Parse "A1", "A1:A5" or "A1:B5" into a normalised `{ start, end }` range. */
export function parseRange(token: string): CellRange | null {
  const m = RANGE_RE.exec(token.trim());
  if (!m) {
    return null;
  }
  return { start: m[1], end: m[2] ?? m[1] };
}

/** Expand a range into the ordered list of A1-style labels it covers. */
export function rangeCells(range: CellRange): string[] {
  const start = parseCoord(range.start);
  const end = parseCoord(range.end);
  if (!start || !end) {
    return [];
  }
  const minCol = Math.min(start.col, end.col);
  const maxCol = Math.max(start.col, end.col);
  const minRow = Math.min(start.row, end.row);
  const maxRow = Math.max(start.row, end.row);
  const cells: string[] = [];
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      cells.push(coordToLabel(col, row));
    }
  }
  return cells;
}

export type Formula =
  | { kind: "sum"; range: string }
  | { kind: "average"; range: string }
  | { kind: "ai"; prompt: string; ref: string };

const MATH_RE = /^=(SUM|AVERAGE)\(\s*([A-Za-z]+\d+(?::[A-Za-z]+\d+)?)\s*\)$/i;
const AI_RE = /^=AI\(\s*(["'])(.*?)\1\s*,\s*([A-Za-z]+\d+)\s*\)$/i;

/**
 * Recognise a formula string. Returns `null` when the input is not a known
 * formula (it should then be treated as a literal value).
 */
export function parseFormula(raw: string): Formula | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("=")) {
    return null;
  }

  const math = MATH_RE.exec(trimmed);
  if (math) {
    const kind = math[1].toLowerCase() === "sum" ? "sum" : "average";
    return { kind, range: math[2] } as Formula;
  }

  const ai = AI_RE.exec(trimmed);
  if (ai) {
    return { kind: "ai", prompt: ai[2], ref: ai[3] };
  }

  return null;
}

function numeric(values: CellValue[]): number[] {
  return values.filter((v): v is number => typeof v === "number");
}

/**
 * Evaluate a SUM/AVERAGE formula over already-resolved cell values. Missing
 * (non-numeric) cells are ignored; an empty numeric set yields
 * {@link DIV0_ERROR} for AVERAGE and `0` for SUM.
 */
export function evaluateMath(
  kind: "sum" | "average",
  values: CellValue[],
): CellValue {
  const nums = numeric(values);
  if (kind === "sum") {
    return nums.reduce((a, b) => a + b, 0);
  }
  return nums.length === 0 ? DIV0_ERROR : nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Sum over values (convenience wrapper). */
export function sum(values: CellValue[]): number {
  return numeric(values).reduce((a, b) => a + b, 0);
}

/** Average over values; returns null when there are no numeric values. */
export function average(values: CellValue[]): number | null {
  const nums = numeric(values);
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
}
