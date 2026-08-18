import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIV0_ERROR,
  NAME_ERROR,
  NUM_ERROR,
  REF_ERROR,
  VALUE_ERROR,
  coordToLabel,
  evaluateExpression,
  isAIFormula,
  isErrorValue,
  parseCoord,
  parseExpression,
  rewriteRefs,
  stringifyExpression,
  type CellResolver,
  type Expr,
  type RefNode,
} from "./formula";

function evalStr(formula: string, cells: Record<string, unknown> = {}): unknown {
  const ast = parseExpression(formula);
  assert.ok(ast, `expected to parse: ${formula}`);
  const resolve: CellResolver = (coord) => {
    const key = coord.toUpperCase();
    return Object.prototype.hasOwnProperty.call(cells, key)
      ? (cells[key] as never)
      : null;
  };
  return evaluateExpression(ast!, resolve);
}

/* ------------------------------------------------------------------ */
/* Coordinates                                                          */
/* ------------------------------------------------------------------ */

test("parseCoord handles multi-letter columns", () => {
  assert.deepEqual(parseCoord("A1"), { col: 0, row: 0 });
  assert.deepEqual(parseCoord("Z1"), { col: 25, row: 0 });
  assert.deepEqual(parseCoord("AA1"), { col: 26, row: 0 });
  assert.deepEqual(parseCoord("AB12"), { col: 27, row: 11 });
  assert.equal(parseCoord("1A"), null);
  assert.equal(parseCoord(""), null);
});

/* ------------------------------------------------------------------ */
/* Arithmetic & precedence                                              */
/* ------------------------------------------------------------------ */

test("arithmetic operators evaluate with spreadsheet semantics", () => {
  assert.equal(evalStr("=1+2"), 3);
  assert.equal(evalStr("=1+2*3"), 7);
  assert.equal(evalStr("=(1+2)*3"), 9);
  assert.equal(evalStr("=10/4"), 2.5);
  assert.equal(evalStr("=2^10"), 1024);
  assert.equal(evalStr("=7%"), 0.07);
  assert.equal(evalStr("=50*10%"), 5);
  assert.equal(evalStr("=-5+2"), -3);
  assert.equal(evalStr("=+5"), 5);
});

test("division by zero yields #DIV/0!", () => {
  assert.equal(evalStr("=1/0"), DIV0_ERROR);
  assert.equal(evalStr("=MOD(5,0)"), DIV0_ERROR);
});

test("string concatenation with &", () => {
  assert.equal(evalStr('="hello"&" "&"world"'), "hello world");
  assert.equal(evalStr("=1&2"), "12");
});

test("comparison operators coerce numbers vs strings", () => {
  assert.equal(evalStr("=1<2"), true);
  assert.equal(evalStr("=2<=2"), true);
  assert.equal(evalStr("=2>2"), false);
  assert.equal(evalStr("=2>=3"), false);
  assert.equal(evalStr('="a"="a"'), true);
  assert.equal(evalStr('="a"<>"b"'), true);
});

test("unary minus binds tighter than exponent (Excel semantics)", () => {
  assert.equal(evalStr("=-2^2"), 4);
});

/* ------------------------------------------------------------------ */
/* Cell & range references                                              */
/* ------------------------------------------------------------------ */

test("cell references resolve through the resolver", () => {
  assert.equal(evalStr("=A1", { A1: 42 }), 42);
  assert.equal(evalStr("=A1+B2", { A1: 10, B2: 5 }), 15);
  assert.equal(evalStr("=A1", {}), null);
});

test("absolute references parse and evaluate the same way", () => {
  assert.equal(evalStr("=$A$1", { A1: 7 }), 7);
  assert.equal(evalStr("=$A1", { A1: 7 }), 7);
  assert.equal(evalStr("=A$1", { A1: 7 }), 7);
});

test("range functions sum/average/min/max/count", () => {
  const cells = { A1: 1, A2: 2, A3: 3, A4: "x", A5: null };
  assert.equal(evalStr("=SUM(A1:A5)", cells), 6);
  assert.equal(evalStr("=AVERAGE(A1:A3)", cells), 2);
  assert.equal(evalStr("=MIN(A1:A3)", cells), 1);
  assert.equal(evalStr("=MAX(A1:A3)", cells), 3);
  assert.equal(evalStr("=COUNT(A1:A5)", cells), 3);
  assert.equal(evalStr("=COUNTA(A1:A5)", cells), 4);
});

test("SUM accepts multiple arguments", () => {
  assert.equal(evalStr("=SUM(1,2,3)"), 6);
  assert.equal(evalStr("=SUM(A1,10)", { A1: 5 }), 15);
});

test("empty average is #DIV/0!", () => {
  assert.equal(evalStr("=AVERAGE(A1:A3)", {}), DIV0_ERROR);
});

test("errors propagate through range functions", () => {
  assert.equal(evalStr("=SUM(A1:A2)", { A1: 1, A2: DIV0_ERROR }), DIV0_ERROR);
});

/* ------------------------------------------------------------------ */
/* Functions                                                            */
/* ------------------------------------------------------------------ */

test("scalar functions IF / ROUND / ABS / SQRT / INT / MOD", () => {
  assert.equal(evalStr("=IF(1>0,100,200)"), 100);
  assert.equal(evalStr("=IF(0,100,200)"), 200);
  assert.equal(evalStr("=ROUND(3.14159,2)"), 3.14);
  assert.equal(evalStr("=ROUND(3.14159)"), 3);
  assert.equal(evalStr("=ABS(-5)"), 5);
  assert.equal(evalStr("=SQRT(16)"), 4);
  assert.equal(evalStr("=SQRT(-1)"), NUM_ERROR);
  assert.equal(evalStr("=INT(3.9)"), 3);
  assert.equal(evalStr("=MOD(7,3)"), 1);
});

test("text functions UPPER / LOWER / TRIM / LEN / CONCAT", () => {
  assert.equal(evalStr('=UPPER("abc")'), "ABC");
  assert.equal(evalStr('=LOWER("ABC")'), "abc");
  assert.equal(evalStr('=TRIM("  a   b  ")'), "a b");
  assert.equal(evalStr('=LEN("hello")'), 5);
  assert.equal(evalStr('=CONCAT("a","b","c")'), "abc");
});

test("unknown functions yield #NAME?", () => {
  assert.equal(evalStr("=FOO(A1)"), NAME_ERROR);
});

test("type mismatches yield #VALUE!", () => {
  assert.equal(evalStr('="abc"+1'), VALUE_ERROR);
});

/* ------------------------------------------------------------------ */
/* AI detection                                                        */
/* ------------------------------------------------------------------ */

test("isAIFormula recognises =AI(...) calls", () => {
  const ast = parseExpression('=AI("Summarize", A1)');
  assert.ok(ast);
  assert.equal(isAIFormula(ast!), true);
  assert.equal(isAIFormula(parseExpression("=SUM(A1:A2)")!), false);
});

test("evaluating an AI formula returns null (plugin handles it)", () => {
  assert.equal(evalStr('=AI("x", A1)', { A1: "data" }), null);
});

/* ------------------------------------------------------------------ */
/* Error tokens                                                        */
/* ------------------------------------------------------------------ */

test("isErrorValue recognises error strings", () => {
  assert.equal(isErrorValue("#DIV/0!"), true);
  assert.equal(isErrorValue("#REF!"), true);
  assert.equal(isErrorValue("nope"), false);
  assert.equal(isErrorValue(42 as never), false);
});

/* ------------------------------------------------------------------ */
/* Serialization round-trip                                             */
/* ------------------------------------------------------------------ */

test("stringifyExpression is idempotent and re-parses", () => {
  const bodies = [
    "1+2*3",
    "SUM(A1:A3)",
    "IF(A1>0,B1,C1)",
    'A1&"-"&B1',
    "ROUND(A1/B1,2)",
    "$A$1+$B2+C$3",
    "50*10%",
  ];
  for (const body of bodies) {
    const ast = parseExpression(`=${body}`);
    assert.ok(ast, `expected to parse: ${body}`);
    const s1 = stringifyExpression(ast!);
    const ast2 = parseExpression(`=${s1}`);
    assert.ok(ast2, `expected to re-parse: ${s1}`);
    assert.equal(stringifyExpression(ast2!), s1, "serialization is idempotent");
  }
  // Canonical forms.
  assert.equal(stringifyExpression(parseExpression("=1+2*3")!), "(1+(2*3))");
  assert.equal(stringifyExpression(parseExpression("=SUM(A1:A3)")!), "SUM(A1:A3)");
  assert.equal(stringifyExpression(parseExpression("=$A$1")!), "$A$1");
});

/* ------------------------------------------------------------------ */
/* Reference rewriting (structural edits)                               */
/* ------------------------------------------------------------------ */

test("rewriteRefs shifts relative rows on insert", () => {
  const ast = parseExpression("=SUM(A1:A3)")!;
  const mutated = rewriteRefs(ast, (ref: RefNode) => {
    if (ref.rowAbs) return ref;
    const p = parseCoord(ref.coord)!;
    return {
      coord: coordToLabel(p.col, p.row + 1),
      colAbs: ref.colAbs,
      rowAbs: ref.rowAbs,
    };
  });
  assert.equal(stringifyExpression(mutated), "SUM(A2:A4)");
});

test("rewriteRefs respects absolute markers", () => {
  const ast = parseExpression("=$A$1+A2")!;
  const mutated = rewriteRefs(ast, (ref: RefNode) => {
    if (ref.rowAbs) return ref;
    return { ...ref, coord: ref.coord.replace(/\d+/, (d) => String(Number(d) + 5)) };
  });
  assert.equal(stringifyExpression(mutated), "($A$1+A7)");
});
