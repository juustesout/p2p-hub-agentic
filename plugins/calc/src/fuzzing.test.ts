import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FormulaSyntaxError,
  MAX_FORMULA_DEPTH,
  MAX_FORMULA_TOKENS,
  VALUE_ERROR,
  evaluateExpression,
  parseExpression,
  type CellResolver,
  type CellValue,
} from "./formula";

/** Deterministic PRNG (mulberry32) so the fuzz suite is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET =
  "{}[]\":,.-_/\\abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n\t$#!?()=&<>^%";

function randomString(rng: () => number, maxLen = 64): string {
  const len = Math.floor(rng() * maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  }
  return out;
}

const resolve: CellResolver = () => null;

function isCellValue(value: unknown): value is CellValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

test("parseExpression/evaluateExpression never crash on random garbage", () => {
  const rng = mulberry32(0xabcdef01);
  for (let i = 0; i < 20000; i++) {
    const raw = randomString(rng, 160);
    let ast;
    try {
      ast = parseExpression(raw);
    } catch (err) {
      assert.ok(
        err instanceof FormulaSyntaxError,
        `unexpected parse error for ${JSON.stringify(raw)}: ` +
          `${(err as Error).constructor.name}: ${(err as Error).message}`,
      );
      continue;
    }
    if (!ast) continue;
    let value: CellValue;
    try {
      value = evaluateExpression(ast, resolve);
    } catch (err) {
      assert.fail(
        `evaluateExpression threw for ${JSON.stringify(raw)}: ${(err as Error).message}`,
      );
    }
    assert.ok(isCellValue(value), `unexpected result type for ${JSON.stringify(raw)}`);
  }
});

test("deeply nested parentheses are rejected, not a stack overflow", () => {
  const depth = MAX_FORMULA_DEPTH + 50;
  const raw = "=" + "(".repeat(depth) + "1" + ")".repeat(depth);
  assert.throws(() => parseExpression(raw), FormulaSyntaxError);
});

test("deeply nested unary operators are rejected, not a stack overflow", () => {
  const depth = MAX_FORMULA_DEPTH + 50;
  const raw = "=" + "-".repeat(depth) + "1";
  assert.throws(() => parseExpression(raw), FormulaSyntaxError);
});

test("a pathological operator chain is capped by the token limit", () => {
  const raw = "=" + "1+".repeat(MAX_FORMULA_TOKENS) + "1";
  assert.throws(() => parseExpression(raw), FormulaSyntaxError);
});

test("zero-argument text functions degrade to #VALUE! instead of crashing", () => {
  for (const body of ["UPPER()", "LOWER()", "TRIM()", "LEN()"]) {
    const ast = parseExpression(`=${body}`);
    assert.ok(ast, `expected to parse: ${body}`);
    assert.equal(evaluateExpression(ast!, resolve), VALUE_ERROR, body);
  }
});
