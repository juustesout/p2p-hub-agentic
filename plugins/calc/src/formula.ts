/**
 * dreamsheet formula engine — the pure, side-effect-free core of the calc
 * plugin. This module is intentionally dependency-free so it can be compiled
 * to CommonJS for the Node plugin *and* to ES modules for the browser UI.
 *
 * It provides:
 *   - A1-style coordinate / range helpers (parseCoord, coordToLabel, ...)
 *   - A full expression lexer + recursive-descent parser
 *   - A spreadsheet evaluator (arithmetic, comparison, `&`, %, ^, functions,
 *     cell/range references with absolute markers, error propagation)
 *
 * AI formulas (`=AI(...)`) are recognised but never executed here — network/AI
 * work happens in the plugin skill through `ctx.ai`, keeping this module
 * deterministic and trivially unit-testable.
 */

/** A raw scalar a cell can hold. */
export type CellValue = string | number | boolean | null;

/* ------------------------------------------------------------------ */
/* Error tokens                                                         */
/* ------------------------------------------------------------------ */

export const REF_ERROR = "#REF!";
export const AI_ERROR = "#AI_ERR";
export const DIV0_ERROR = "#DIV/0!";
export const VALUE_ERROR = "#VALUE!";
export const NAME_ERROR = "#NAME?";
export const CYCLE_ERROR = "#CYCLE!";
export const NUM_ERROR = "#NUM!";
export const ERROR_ERROR = "#ERROR!";

export function isErrorValue(value: CellValue): boolean {
  return typeof value === "string" && value.startsWith("#") && value.endsWith("!");
}

/** True if a string looks like a numeric literal. */
export function isNumeric(str: string): boolean {
  const s = str.trim();
  if (s === "") return false;
  return !Number.isNaN(Number(s));
}

function isEmpty(value: CellValue): boolean {
  return value === null || value === undefined || value === "";
}

function toText(value: CellValue): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function toBoolean(value: CellValue): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = String(value).toLowerCase();
  if (s === "false") return false;
  return true;
}

function toNumber(value: CellValue): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const s = value.trim();
  if (s === "") return 0;
  const n = Number(s);
  return Number.isNaN(n) ? NaN : n;
}

/* ------------------------------------------------------------------ */
/* Coordinates                                                          */
/* ------------------------------------------------------------------ */

export interface CellCoord {
  col: number;
  row: number;
}

const COORD_RE = /^([A-Za-z]+)(\d+)$/;

export function parseCoord(coord: string): CellCoord | null {
  const m = COORD_RE.exec(coord.trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

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

export function parseRange(token: string): CellRange | null {
  const m = RANGE_RE.exec(token.trim());
  if (!m) return null;
  return { start: m[1], end: m[2] ?? m[1] };
}

export function rangeCells(range: CellRange): string[] {
  const start = parseCoord(range.start);
  const end = parseCoord(range.end);
  if (!start || !end) return [];
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

/* ------------------------------------------------------------------ */
/* Legacy recogniser (kept for backward-compatible tests)               */
/* ------------------------------------------------------------------ */

export type Formula =
  | { kind: "sum"; range: string }
  | { kind: "average"; range: string }
  | { kind: "ai"; prompt: string; ref: string };

const MATH_RE = /^=(SUM|AVERAGE)\(\s*([A-Za-z]+\d+(?::[A-Za-z]+\d+)?)\s*\)$/i;
const AI_RE = /^=AI\(\s*(["'])(.*?)\1\s*,\s*([A-Za-z]+\d+)\s*\)$/i;

export function parseFormula(raw: string): Formula | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("=")) return null;
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

export function evaluateMath(
  kind: "sum" | "average",
  values: CellValue[],
): CellValue {
  const nums = numeric(values);
  if (kind === "sum") {
    return nums.reduce((a, b) => a + b, 0);
  }
  return nums.length === 0
    ? DIV0_ERROR
    : nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function sum(values: CellValue[]): number {
  return numeric(values).reduce((a, b) => a + b, 0);
}

export function average(values: CellValue[]): number | null {
  const nums = numeric(values);
  return nums.length === 0
    ? null
    : nums.reduce((a, b) => a + b, 0) / nums.length;
}

/* ------------------------------------------------------------------ */
/* Expression AST                                                       */
/* ------------------------------------------------------------------ */

export interface RefNode {
  coord: string;
  colAbs: boolean;
  rowAbs: boolean;
}

export type Expr =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "bool"; value: boolean }
  | { type: "cell"; ref: RefNode }
  | { type: "range"; start: RefNode; end: RefNode }
  | { type: "func"; name: string; args: Expr[] }
  | { type: "binary"; op: string; left: Expr; right: Expr }
  | { type: "unary"; op: string; expr: Expr }
  | { type: "percent"; expr: Expr };

export class FormulaSyntaxError extends Error {}

/* ------------------------------------------------------------------ */
/* Lexer                                                                */
/* ------------------------------------------------------------------ */

interface Token {
  type:
    | "num"
    | "str"
    | "bool"
    | "func"
    | "ident"
    | "ref"
    | "op"
    | "percent"
    | "lparen"
    | "rparen"
    | "comma"
    | "eof";
  value: string;
}

const OPERATORS = ["<>", "<=", ">=", "+", "-", "*", "/", "^", "&", "=", "<", ">"];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let s = "";
      while (j < n && src[j] !== quote) {
        s += src[j];
        j++;
      }
      if (j >= n) throw new FormulaSyntaxError("Unterminated string");
      j++; // closing quote
      tokens.push({ type: "str", value: s });
      i = j;
      continue;
    }

    const numMatch = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (numMatch) {
      tokens.push({ type: "num", value: numMatch[0] });
      i += numMatch[0].length;
      continue;
    }

    const refMatch = /^\$?[A-Za-z]+\$?\d+(?:\s*:\s*\$?[A-Za-z]+\$?\d+)?/.exec(
      src.slice(i),
    );
    if (refMatch) {
      tokens.push({ type: "ref", value: refMatch[0].replace(/\s+/g, "") });
      i += refMatch[0].length;
      continue;
    }

    const identMatch = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (identMatch) {
      const word = identMatch[0];
      const upper = word.toUpperCase();
      if (upper === "TRUE" || upper === "FALSE") {
        tokens.push({ type: "bool", value: upper });
        i += word.length;
        continue;
      }
      let j = i + word.length;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === "(") {
        tokens.push({ type: "func", value: upper });
        i = j;
      } else {
        tokens.push({ type: "ident", value: word });
        i += word.length;
      }
      continue;
    }

    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") {
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if (OPERATORS.includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "%") {
      tokens.push({ type: "percent", value: "%" });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", value: "(" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ")" });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: "," });
      i++;
      continue;
    }

    throw new FormulaSyntaxError(`Unexpected character "${ch}"`);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Parser                                                               */
/* ------------------------------------------------------------------ */

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  parse(): Expr {
    const expr = this.parseComparison();
    if (this.peek().type !== "eof") {
      throw new FormulaSyntaxError(
        `Unexpected token "${this.peek().value || this.peek().type}"`,
      );
    }
    return expr;
  }

  private parseComparison(): Expr {
    let left = this.parseConcat();
    while (
      this.peek().type === "op" &&
      ["=", "<>", "<", ">", "<=", ">="].includes(this.peek().value)
    ) {
      const op = this.next().value;
      left = { type: "binary", op, left, right: this.parseConcat() };
    }
    return left;
  }

  private parseConcat(): Expr {
    let left = this.parseAdditive();
    while (this.peek().type === "op" && this.peek().value === "&") {
      this.next();
      left = { type: "binary", op: "&", left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (
      this.peek().type === "op" &&
      (this.peek().value === "+" || this.peek().value === "-")
    ) {
      const op = this.next().value;
      left = {
        type: "binary",
        op,
        left,
        right: this.parseMultiplicative(),
      };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parsePower();
    while (
      this.peek().type === "op" &&
      (this.peek().value === "*" || this.peek().value === "/")
    ) {
      const op = this.next().value;
      left = { type: "binary", op, left, right: this.parsePower() };
    }
    return left;
  }

  private parsePower(): Expr {
    const base = this.parseUnary();
    if (this.peek().type === "op" && this.peek().value === "^") {
      this.next();
      return { type: "binary", op: "^", left: base, right: this.parsePower() };
    }
    return base;
  }

  private parseUnary(): Expr {
    if (
      this.peek().type === "op" &&
      (this.peek().value === "-" || this.peek().value === "+")
    ) {
      const op = this.next().value;
      return { type: "unary", op, expr: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (this.peek().type === "percent") {
      this.next();
      expr = { type: "percent", expr };
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.type === "num") {
      this.next();
      return { type: "num", value: Number(t.value) };
    }
    if (t.type === "str") {
      this.next();
      return { type: "str", value: t.value };
    }
    if (t.type === "bool") {
      this.next();
      return { type: "bool", value: t.value === "TRUE" };
    }
    if (t.type === "ref") {
      this.next();
      return refNode(t.value);
    }
    if (t.type === "func") {
      this.next();
      this.expect("lparen");
      const args: Expr[] = [];
      if (this.peek().type !== "rparen") {
        args.push(this.parseComparison());
        while (this.peek().type === "comma") {
          this.next();
          args.push(this.parseComparison());
        }
      }
      this.expect("rparen");
      return { type: "func", name: t.value, args };
    }
    if (t.type === "ident") {
      this.next();
      throw new FormulaSyntaxError(`Unknown name "${t.value}"`);
    }
    if (t.type === "lparen") {
      this.next();
      const expr = this.parseComparison();
      this.expect("rparen");
      return expr;
    }
    throw new FormulaSyntaxError(
      `Unexpected token "${t.value || t.type}"`,
    );
  }

  private expect(type: Token["type"]): Token {
    const t = this.next();
    if (t.type !== type) {
      throw new FormulaSyntaxError(
        `Expected "${type}" but found "${t.value || t.type}"`,
      );
    }
    return t;
  }
}

function parseRefPart(s: string): RefNode {
  const m = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/.exec(s);
  if (!m) throw new FormulaSyntaxError(`Invalid reference "${s}"`);
  return {
    coord: m[2].toUpperCase() + m[4],
    colAbs: m[1] === "$",
    rowAbs: m[3] === "$",
  };
}

function refNode(value: string): Expr {
  const idx = value.indexOf(":");
  if (idx === -1) {
    return { type: "cell", ref: parseRefPart(value) };
  }
  return {
    type: "range",
    start: parseRefPart(value.slice(0, idx)),
    end: parseRefPart(value.slice(idx + 1)),
  };
}

/**
 * Parse a formula string into an expression AST.
 * Returns `null` when the input is not a formula (does not start with `=`).
 * Throws {@link FormulaSyntaxError} for malformed formulas.
 */
export function parseExpression(raw: string): Expr | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("=")) return null;
  const body = trimmed.slice(1).trim();
  if (body === "") return null;
  return new Parser(tokenize(body)).parse();
}

/** True if the expression is an `=AI(...)` call (handled by the plugin). */
export function isAIFormula(expr: Expr): boolean {
  return expr.type === "func" && expr.name === "AI";
}

/* ------------------------------------------------------------------ */
/* Evaluator                                                            */
/* ------------------------------------------------------------------ */

/** Resolve a single cell coordinate to its current computed value. */
export type CellResolver = (coord: string) => CellValue;

function resolveRange(node: Expr, resolve: CellResolver): CellValue[] {
  if (node.type !== "range") return [];
  const range = parseRange(`${node.start.coord}:${node.end.coord}`);
  if (!range) return [];
  return rangeCells(range).map((c) => resolve(c));
}

function firstError(values: CellValue[]): CellValue {
  for (const v of values) {
    if (isErrorValue(v)) return v;
  }
  return null;
}

function flattenArgs(args: Expr[], resolve: CellResolver): CellValue[] {
  const out: CellValue[] = [];
  for (const arg of args) {
    if (arg.type === "range") {
      out.push(...resolveRange(arg, resolve));
    } else if (arg.type === "cell") {
      out.push(resolve(arg.ref.coord));
    } else {
      out.push(evaluate(arg, resolve));
    }
  }
  return out;
}

function roundTo(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function evalFunction(node: Expr, resolve: CellResolver): CellValue {
  if (node.type !== "func") return null;
  const name = node.name;
  const args = node.args;

  if (name === "AI") return null;

  switch (name) {
    case "IF": {
      if (args.length < 2 || args.length > 3) return VALUE_ERROR;
      const cond = evaluate(args[0], resolve);
      if (toBoolean(cond)) return evaluate(args[1], resolve);
      return args.length === 3 ? evaluate(args[2], resolve) : null;
    }
    case "ROUND": {
      if (args.length < 1 || args.length > 2) return VALUE_ERROR;
      const x = toNumber(evaluate(args[0], resolve));
      if (Number.isNaN(x)) return VALUE_ERROR;
      const digits = args.length === 2 ? Math.trunc(toNumber(evaluate(args[1], resolve))) : 0;
      return roundTo(x, digits);
    }
    case "ABS": {
      if (args.length !== 1) return VALUE_ERROR;
      const x = toNumber(evaluate(args[0], resolve));
      return Number.isNaN(x) ? VALUE_ERROR : Math.abs(x);
    }
    case "SQRT": {
      if (args.length !== 1) return VALUE_ERROR;
      const x = toNumber(evaluate(args[0], resolve));
      if (Number.isNaN(x)) return VALUE_ERROR;
      return x < 0 ? NUM_ERROR : Math.sqrt(x);
    }
    case "INT": {
      if (args.length !== 1) return VALUE_ERROR;
      const x = toNumber(evaluate(args[0], resolve));
      return Number.isNaN(x) ? VALUE_ERROR : Math.trunc(x);
    }
    case "MOD": {
      if (args.length !== 2) return VALUE_ERROR;
      const a = toNumber(evaluate(args[0], resolve));
      const b = toNumber(evaluate(args[1], resolve));
      if (Number.isNaN(a) || Number.isNaN(b)) return VALUE_ERROR;
      if (b === 0) return DIV0_ERROR;
      return a - b * Math.floor(a / b);
    }
    case "CONCAT":
    case "CONCATENATE": {
      return flattenArgs(args, resolve).map(toText).join("");
    }
    case "UPPER":
      return toText(evaluate(args[0], resolve)).toUpperCase();
    case "LOWER":
      return toText(evaluate(args[0], resolve)).toLowerCase();
    case "TRIM":
      return toText(evaluate(args[0], resolve)).replace(/\s+/g, " ").trim();
    case "LEN":
      return toText(evaluate(args[0], resolve)).length;

    case "SUM":
    case "AVERAGE":
    case "MIN":
    case "MAX":
    case "COUNT":
    case "COUNTA": {
      const values = flattenArgs(args, resolve);
      return evalAggregate(name, values);
    }
    default:
      return NAME_ERROR;
  }
}

function evalAggregate(
  name: string,
  values: CellValue[],
): CellValue {
  if (name === "COUNT") {
    return values.filter((v) => typeof v === "number").length;
  }
  if (name === "COUNTA") {
    return values.filter((v) => !isEmpty(v)).length;
  }
  const err = firstError(values);
  if (err) return err;
  const nums = values.filter((v): v is number => typeof v === "number");
  switch (name) {
    case "SUM":
      return nums.reduce((a, b) => a + b, 0);
    case "AVERAGE":
      return nums.length === 0
        ? DIV0_ERROR
        : nums.reduce((a, b) => a + b, 0) / nums.length;
    case "MIN":
      return nums.length === 0 ? 0 : Math.min(...nums);
    case "MAX":
      return nums.length === 0 ? 0 : Math.max(...nums);
    default:
      return NAME_ERROR;
  }
}

function numOp(
  op: string,
  left: CellValue,
  right: CellValue,
): CellValue {
  const a = toNumber(left);
  const b = toNumber(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return VALUE_ERROR;
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? DIV0_ERROR : a / b;
    case "^":
      return Math.pow(a, b);
    default:
      return VALUE_ERROR;
  }
}

function compareOp(
  op: string,
  left: CellValue,
  right: CellValue,
): CellValue {
  const a = toNumber(left);
  const b = toNumber(right);
  if (!Number.isNaN(a) && !Number.isNaN(b)) {
    switch (op) {
      case "=":
        return a === b;
      case "<>":
        return a !== b;
      case "<":
        return a < b;
      case ">":
        return a > b;
      case "<=":
        return a <= b;
      case ">=":
        return a >= b;
    }
  }
  const sa = toText(left);
  const sb = toText(right);
  switch (op) {
    case "=":
      return sa === sb;
    case "<>":
      return sa !== sb;
    case "<":
      return sa < sb;
    case ">":
      return sa > sb;
    case "<=":
      return sa <= sb;
    case ">=":
      return sa >= sb;
  }
  return VALUE_ERROR;
}

/** Evaluate an expression AST against a cell resolver. */
export function evaluateExpression(
  expr: Expr,
  resolve: CellResolver,
): CellValue {
  return evaluate(expr, resolve);
}

function evaluate(node: Expr, resolve: CellResolver): CellValue {
  switch (node.type) {
    case "num":
      return node.value;
    case "str":
      return node.value;
    case "bool":
      return node.value;
    case "cell":
      return resolve(node.ref.coord);
    case "range": {
      const values = resolveRange(node, resolve);
      return values.length > 0 ? (values[0] ?? null) : null;
    }
    case "unary": {
      const v = toNumber(evaluate(node.expr, resolve));
      if (Number.isNaN(v)) return VALUE_ERROR;
      return node.op === "-" ? -v : v;
    }
    case "percent": {
      const v = toNumber(evaluate(node.expr, resolve));
      if (Number.isNaN(v)) return VALUE_ERROR;
      return v / 100;
    }
    case "binary": {
      const { op, left, right } = node;
      if (op === "&") {
        return toText(evaluate(left, resolve)) + toText(evaluate(right, resolve));
      }
      const l = evaluate(left, resolve);
      const r = evaluate(right, resolve);
      if (isErrorValue(l)) return l;
      if (isErrorValue(r)) return r;
      if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
        return compareOp(op, l, r);
      }
      return numOp(op, l, r);
    }
    case "func":
      return evalFunction(node, resolve);
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Reference rewriting (for row/column insert & delete)                 */
/* ------------------------------------------------------------------ */

/**
 * Rewrite an expression's cell/range references after a structural change.
 * `mutate` receives each referenced cell (with its absolute markers) and
 * returns an updated {@link RefNode}. A mutate result whose `coord` equals
 * `REF_ERROR` ("#REF!") turns that reference into a literal `#REF!` error.
 */
export function rewriteRefs(expr: Expr, mutate: (ref: RefNode) => RefNode): Expr {
  switch (expr.type) {
    case "cell": {
      const updated = mutate(expr.ref);
      if (updated.coord === REF_ERROR) {
        return { type: "str", value: REF_ERROR };
      }
      return { ...expr, ref: updated };
    }
    case "range": {
      const start = mutate(expr.start);
      const end = mutate(expr.end);
      if (start.coord === REF_ERROR || end.coord === REF_ERROR) {
        return { type: "str", value: REF_ERROR };
      }
      return { ...expr, start, end };
    }
    case "func":
      return { ...expr, args: expr.args.map((a) => rewriteRefs(a, mutate)) };
    case "binary":
      return {
        ...expr,
        left: rewriteRefs(expr.left, mutate),
        right: rewriteRefs(expr.right, mutate),
      };
    case "unary":
      return { ...expr, expr: rewriteRefs(expr.expr, mutate) };
    case "percent":
      return { ...expr, expr: rewriteRefs(expr.expr, mutate) };
    default:
      return expr;
  }
}

/* ------------------------------------------------------------------ */
/* AST serialization (for reference rewriting on structural edits)      */
/* ------------------------------------------------------------------ */

function refToString(ref: RefNode): string {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.coord);
  if (!m) return ref.coord;
  return (
    (ref.colAbs ? "$" : "") +
    m[1] +
    (ref.rowAbs ? "$" : "") +
    m[2]
  );
}

/** Serialize an expression back to a formula body (without the leading `=`). */
export function stringifyExpression(expr: Expr): string {
  switch (expr.type) {
    case "num":
      return String(expr.value);
    case "str":
      return JSON.stringify(expr.value);
    case "bool":
      return expr.value ? "TRUE" : "FALSE";
    case "cell":
      return refToString(expr.ref);
    case "range":
      return `${refToString(expr.start)}:${refToString(expr.end)}`;
    case "func":
      return `${expr.name}(${expr.args.map(stringifyExpression).join(",")})`;
    case "binary":
      return `(${stringifyExpression(expr.left)}${expr.op}${stringifyExpression(expr.right)})`;
    case "unary":
      return `(${expr.op}${stringifyExpression(expr.expr)})`;
    case "percent":
      return `${stringifyExpression(expr.expr)}%`;
    default:
      return "";
  }
}

/* ------------------------------------------------------------------ */
/* Structural shift helpers (row/column insert & delete)                */
/* ------------------------------------------------------------------ */

/**
 * Shift a coordinate by applying `shiftRow`/`shiftCol` to its indices.
 * Returns `null` when the cell is removed by the shift.
 */
export function shiftCoord(
  coord: string,
  shiftRow: (r: number) => number,
  shiftCol: (c: number) => number,
): string | null {
  const parsed = parseCoord(coord);
  if (!parsed) return null;
  const r = shiftRow(parsed.row);
  const c = shiftCol(parsed.col);
  if (r < 0 || c < 0) return null;
  return coordToLabel(c, r);
}

/**
 * Build a `rewriteRefs` mutator that shifts references according to the given
 * row/column index functions, honouring `$` absolute markers. A reference that
 * falls out of range becomes `#REF!`.
 */
export function makeRefMutator(
  shiftRow: (r: number) => number,
  shiftCol: (c: number) => number,
): (ref: RefNode) => RefNode {
  return (ref: RefNode): RefNode => {
    const parsed = parseCoord(ref.coord);
    if (!parsed) return ref;
    const r = ref.rowAbs ? parsed.row : shiftRow(parsed.row);
    const c = ref.colAbs ? parsed.col : shiftCol(parsed.col);
    if (r < 0 || c < 0) {
      return { coord: REF_ERROR, colAbs: false, rowAbs: false };
    }
    return {
      coord: coordToLabel(c, r),
      colAbs: ref.colAbs,
      rowAbs: ref.rowAbs,
    };
  };
}

/**
 * Return row/column index shift functions for a structural edit kind.
 */
export function makeShifts(
  kind: "insertRows" | "deleteRows" | "insertCols" | "deleteCols",
  at: number,
  count: number,
): { shiftRow: (r: number) => number; shiftCol: (c: number) => number } {
  switch (kind) {
    case "insertRows":
      return {
        shiftRow: (r) => (r >= at ? r + count : r),
        shiftCol: (c) => c,
      };
    case "deleteRows":
      return {
        shiftRow: (r) => (r < at ? r : r < at + count ? -1 : r - count),
        shiftCol: (c) => c,
      };
    case "insertCols":
      return {
        shiftRow: (r) => r,
        shiftCol: (c) => (c >= at ? c + count : c),
      };
    case "deleteCols":
      return {
        shiftRow: (r) => r,
        shiftCol: (c) => (c < at ? c : c < at + count ? -1 : c - count),
      };
  }
}
