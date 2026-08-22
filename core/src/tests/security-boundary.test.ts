import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CHAT_TEXT_LENGTH,
  MAX_KEY_COUNT,
  MAX_OBJECT_DEPTH,
  MAX_PAYLOAD_BYTES,
  ObjectDepthExceededError,
  PayloadTooLargeError,
  KeyCountExceededError,
  containsUnsafeContent,
  sanitizeMarkdown,
  sanitizeText,
  sanitizeUrl,
  stripHtml,
  validateKeyCount,
  validateObjectDepth,
  validateJsonNestingDepth,
  validatePayloadSize,
  validateTextLength,
} from "@p2p-hub/sdk";
import {
  InvalidActionPayloadError,
  validateActionPayload,
} from "../security/action-validator";

/** Build a value nested `n` levels deep: `nest(2)` === `{ child: { child: "leaf" } }`. */
function nest(n: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < n; i++) {
    value = { child: value };
  }
  return value;
}

// ---------------------------------------------------------------------------
// Size / depth boundaries
// ---------------------------------------------------------------------------

test("validatePayloadSize rejects payloads over 256KB", () => {
  const max = "a".repeat(MAX_PAYLOAD_BYTES);
  assert.doesNotThrow(() => validatePayloadSize(max));
  const over = "a".repeat(MAX_PAYLOAD_BYTES + 1);
  assert.throws(() => validatePayloadSize(over), PayloadTooLargeError);
});

test("validatePayloadSize measures UTF-8 bytes, not characters", () => {
  // 100k two-byte characters = 200k bytes.
  const text = "\u00e9".repeat(100_000);
  assert.doesNotThrow(() => validatePayloadSize(text));
  const over = "\u00e9".repeat(140_000);
  assert.throws(() => validatePayloadSize(over), PayloadTooLargeError);
});

test("validateObjectDepth accepts depth 10 and rejects depth 11", () => {
  assert.doesNotThrow(() => validateObjectDepth(nest(MAX_OBJECT_DEPTH)));
  assert.throws(
    () => validateObjectDepth(nest(MAX_OBJECT_DEPTH + 1)),
    ObjectDepthExceededError,
  );
});

test("validateObjectDepth rejects a cyclic structure without overflowing", () => {
  const cycle: Record<string, unknown> = { name: "x" };
  cycle.self = cycle;
  assert.throws(() => validateObjectDepth(cycle), ObjectDepthExceededError);
});

/** Build a JSON string with `n` nested arrays around a scalar. */
function deepJsonString(n: number): string {
  return "[".repeat(n) + "1" + "]".repeat(n);
}

test("validateJsonNestingDepth rejects over-deep JSON strings before parsing", () => {
  // 100k levels is ~200KB — within MAX_PAYLOAD_BYTES, but far past the V8
  // JSON.parse recursion limit.
  const bomb = deepJsonString(100_000);
  assert.throws(() => validateJsonNestingDepth(bomb), ObjectDepthExceededError);
  assert.throws(() => validateJsonNestingDepth(deepJsonString(11)), ObjectDepthExceededError);
});

test("validateJsonNestingDepth accepts JSON at the depth limit", () => {
  assert.doesNotThrow(() => validateJsonNestingDepth(deepJsonString(MAX_OBJECT_DEPTH)));
  assert.doesNotThrow(() =>
    validateJsonNestingDepth('{"a":[1,{"b":[2,{"c":null}]}]}'),
  );
});

test("validateJsonNestingDepth ignores brackets inside strings and escapes", () => {
  const bracketsInString = JSON.stringify({ text: "[[[[[[[[[[[[[[[[", n: 1 });
  assert.doesNotThrow(() => validateJsonNestingDepth(bracketsInString));

  const escapedQuotes = JSON.stringify({ text: 'a\\"b\\"c[[]]' });
  assert.doesNotThrow(() => validateJsonNestingDepth(escapedQuotes));
});

test("deep JSON is rejected before post-parse recursion can overflow", () => {
  const bomb = deepJsonString(100_000);
  // JSON.parse in current V8 is iterative and does not throw on this input,
  // but JSON.stringify (and other recursive consumers) overflow the call
  // stack on such a graph. The guard rejects the string before any of those
  // paths can run.
  assert.throws(
    () => {
      validateJsonNestingDepth(bomb);
      JSON.parse(bomb);
      JSON.stringify(JSON.parse(bomb));
    },
    ObjectDepthExceededError,
  );
});

test("validateKeyCount enforces MAX_KEY_COUNT per object", () => {
  const ok: Record<string, unknown> = {};
  for (let i = 0; i < MAX_KEY_COUNT; i++) {
    ok[`k${i}`] = i;
  }
  assert.doesNotThrow(() => validateKeyCount(ok));

  const tooMany: Record<string, unknown> = {};
  for (let i = 0; i < MAX_KEY_COUNT + 1; i++) {
    tooMany[`k${i}`] = i;
  }
  assert.throws(() => validateKeyCount(tooMany), KeyCountExceededError);
});

test("validateTextLength enforces MAX_CHAT_TEXT_LENGTH", () => {
  assert.doesNotThrow(() => validateTextLength("x".repeat(MAX_CHAT_TEXT_LENGTH)));
  assert.throws(
    () => validateTextLength("x".repeat(MAX_CHAT_TEXT_LENGTH + 1)),
    PayloadTooLargeError,
  );
});

// ---------------------------------------------------------------------------
// XSS / injection sanitization
// ---------------------------------------------------------------------------

test("sanitizeText strips <script> blocks including their content", () => {
  assert.equal(sanitizeText("<script>alert(1)</script>"), "");
  assert.equal(sanitizeText("a<script>alert(1)</script>b"), "ab");
});

test("sanitizeText strips <img> with inline event handlers", () => {
  assert.equal(sanitizeText("<img src=x onerror=alert(1)>"), "");
  assert.equal(sanitizeText("hi<img src=x onerror=alert(1)>bye"), "hibye");
});

test("sanitizeText removes iframe/object/embed entirely", () => {
  assert.equal(sanitizeText('<iframe src="x"></iframe>'), "");
  assert.equal(sanitizeText('<object data="x"></object>'), "");
  assert.equal(sanitizeText('<embed src="x">'), "");
});

test("sanitizeText preserves plain text between ordinary tags", () => {
  assert.equal(sanitizeText("hello <b>world</b>"), "hello world");
  assert.equal(sanitizeText("2 < 3 is true"), "2 < 3 is true");
});

test("sanitizeUrl neutralizes dangerous schemes", () => {
  assert.equal(sanitizeUrl("javascript:void(0)"), "about:blank");
  assert.equal(sanitizeUrl("JAVASCRIPT:alert(1)"), "about:blank");
  assert.equal(sanitizeUrl("vbscript:msgbox(1)"), "about:blank");
  assert.equal(sanitizeUrl("data:text/html,<script>"), "about:blank");
  assert.equal(sanitizeUrl("java\nscript:alert(1)"), "about:blank");
  assert.equal(sanitizeUrl("https://example.com"), "https://example.com");
  assert.equal(sanitizeUrl("mailto:a@b.c"), "mailto:a@b.c");
});

test("sanitizeMarkdown strips inline HTML but keeps formatting", () => {
  assert.equal(
    sanitizeMarkdown("**bold** and *italic* and <script>alert(1)</script>"),
    "**bold** and *italic* and ",
  );
  assert.equal(sanitizeMarkdown("- item one\n- item two"), "- item one\n- item two");
});

test("sanitizeMarkdown neutralizes javascript: links", () => {
  assert.equal(
    sanitizeMarkdown("[click](javascript:void(0))"),
    "[click](about:blank)",
  );
  assert.equal(sanitizeMarkdown("[x](https://ok.com)"), "[x](https://ok.com)");
  assert.equal(sanitizeMarkdown("![pic](javascript:alert(1))"), "![pic](about:blank)");
});

test("stripHtml removes comments and quoted-attribute tags", () => {
  assert.equal(stripHtml("<!-- secret -->text"), "text");
  assert.equal(stripHtml('<a href="a>b" title="x">t</a>'), "t");
});

test("containsUnsafeContent flags tags and schemes, not ordinary text", () => {
  assert.equal(containsUnsafeContent("<script>x</script>"), true);
  assert.equal(containsUnsafeContent("javascript:alert(1)"), true);
  assert.equal(containsUnsafeContent("data:text/html"), true);
  assert.equal(containsUnsafeContent("plain text"), false);
  assert.equal(containsUnsafeContent("metadata: not a scheme"), false);
});

// ---------------------------------------------------------------------------
// Action card validation
// ---------------------------------------------------------------------------

test("validateActionPayload accepts a clean action card", () => {
  const result = validateActionPayload({
    actionId: "chess.invite",
    type: "invitation",
    title: "Game",
    data: { roomId: "123" },
  });
  assert.deepEqual(result, {
    actionId: "chess.invite",
    type: "invitation",
    title: "Game",
    data: { roomId: "123" },
  });
});

test("validateActionPayload strips unknown top-level keys", () => {
  const result = validateActionPayload({
    actionId: "chess.invite",
    type: "invitation",
    title: "Game",
    extra: "dropped",
    onClick: "dropped too",
  });
  assert.deepEqual(result, {
    actionId: "chess.invite",
    type: "invitation",
    title: "Game",
  });
});

test("validateActionPayload rejects injected script content", () => {
  assert.throws(
    () =>
      validateActionPayload({
        actionId: "chess.invite",
        type: "invitation",
        title: '<img src=x onerror=alert(1)>',
      }),
    InvalidActionPayloadError,
  );
  assert.throws(
    () =>
      validateActionPayload({
        actionId: "chess.invite",
        type: "invitation",
        title: "Game",
        data: { roomId: '<script>alert(1)</script>' },
      }),
    InvalidActionPayloadError,
  );
  assert.throws(
    () =>
      validateActionPayload({
        actionId: "chess.invite",
        type: "invitation",
        title: "Game",
        data: { url: "javascript:void(0)" },
      }),
    InvalidActionPayloadError,
  );
});

test("validateActionPayload rejects malformed shapes", () => {
  assert.throws(() => validateActionPayload(null), InvalidActionPayloadError);
  assert.throws(() => validateActionPayload([]), InvalidActionPayloadError);
  assert.throws(
    () => validateActionPayload({ type: "invitation", title: "x" }),
    InvalidActionPayloadError,
  );
  assert.throws(
    () => validateActionPayload({ actionId: 42, type: "invitation", title: "x" }),
    InvalidActionPayloadError,
  );
  assert.throws(
    () =>
      validateActionPayload({
        actionId: "bad action!",
        type: "invitation",
        title: "x",
      }),
    InvalidActionPayloadError,
  );
  assert.throws(
    () =>
      validateActionPayload({
        actionId: "chess.invite",
        type: "invitation",
        title: "x",
        data: "not-an-object",
      }),
    InvalidActionPayloadError,
  );
});

test("validateActionPayload rejects prototype-polluting keys", () => {
  const payload = JSON.parse(
    '{"actionId":"chess.invite","type":"invitation","title":"x","__proto__":{"polluted":true}}',
  );
  assert.throws(() => validateActionPayload(payload), InvalidActionPayloadError);
  assert.throws(
    () =>
      validateActionPayload({
        actionId: "chess.invite",
        type: "invitation",
        title: "x",
        data: { constructor: "evil" },
      }),
    InvalidActionPayloadError,
  );
});

test("validateActionPayload rejects non-data values in data", () => {
  assert.throws(
    () =>
      validateActionPayload({
        actionId: "chess.invite",
        type: "invitation",
        title: "x",
        data: { fn: () => "code" },
      }),
    InvalidActionPayloadError,
  );
});

test("validateActionPayload enforces size, count and depth limits", () => {
  const base = { actionId: "chess.invite", type: "invitation", title: "x" };

  assert.throws(
    () => validateActionPayload({ ...base, data: { s: "a".repeat(10_001) } }),
    InvalidActionPayloadError,
    "data string over the 10k cap",
  );

  assert.throws(
    () => validateActionPayload({ ...base, data: { items: Array(501).fill("x") } }),
    InvalidActionPayloadError,
    "data array over the 500-item cap",
  );

  const tooManyKeys = Object.fromEntries(
    Array.from({ length: 501 }, (_, i) => [`k${i}`, 1]),
  );
  assert.throws(
    () => validateActionPayload({ ...base, data: tooManyKeys }),
    InvalidActionPayloadError,
    "data object over the 500-key cap",
  );

  let deep: unknown = 1;
  for (let i = 0; i < 10; i++) {
    deep = [deep];
  }
  assert.throws(
    () => validateActionPayload({ ...base, data: { deep } }),
    InvalidActionPayloadError,
    "data nested past MAX_OBJECT_DEPTH",
  );
});

test("validateActionPayload rejects empty/oversized identifiers and title", () => {
  assert.throws(() => validateActionPayload({ actionId: "", type: "invitation", title: "x" }));
  assert.throws(() => validateActionPayload({ actionId: "a".repeat(129), type: "invitation", title: "x" }));
  assert.throws(() => validateActionPayload({ actionId: "chess.invite", type: "", title: "x" }));
  assert.throws(() => validateActionPayload({ actionId: "chess.invite", type: "in vite", title: "x" }));
  assert.throws(() => validateActionPayload({ actionId: "chess.invite", type: "a".repeat(65), title: "x" }));
  assert.throws(() => validateActionPayload({ actionId: "chess.invite", type: "invitation", title: "" }));
  assert.throws(() => validateActionPayload({ actionId: "chess.invite", type: "invitation", title: "a".repeat(501) }));
});

test("validateActionPayload rejects forbidden keys at any nesting level", () => {
  assert.throws(
    () => validateActionPayload({ actionId: "x", type: "y", title: "t", constructor: 1 }),
    InvalidActionPayloadError,
  );
  assert.throws(
    () =>
      validateActionPayload({
        actionId: "x",
        type: "y",
        title: "t",
        data: { nested: { prototype: 1 } },
      }),
    InvalidActionPayloadError,
  );
});

test("validateActionPayload accepts primitive data values and null", () => {
  const result = validateActionPayload({
    actionId: "chess.invite",
    type: "invitation",
    title: "x",
    data: { n: 5, b: true, z: null, arr: [1, "two", false] },
  });
  assert.deepEqual(result.data, { n: 5, b: true, z: null, arr: [1, "two", false] });
});

// ---------------------------------------------------------------------------
// Deterministic fuzzing: the guards must never crash on arbitrary input
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_ALPHABET =
  "<>[](){}:/\"'=!-_ abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n\t";

function randomFuzzString(rng: () => number, maxLen = 256): string {
  const len = Math.floor(rng() * maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += FUZZ_ALPHABET[Math.floor(rng() * FUZZ_ALPHABET.length)];
  }
  return out;
}

function randomFuzzJson(rng: () => number, depth = 0): unknown {
  if (depth > 4 || rng() < 0.35) {
    const scalars: unknown[] = [
      null,
      rng() < 0.5,
      Math.floor(rng() * 1000),
      randomFuzzString(rng, 24),
    ];
    return scalars[Math.floor(rng() * scalars.length)];
  }
  if (rng() < 0.5) {
    const arr: unknown[] = [];
    const n = Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) {
      arr.push(randomFuzzJson(rng, depth + 1));
    }
    return arr;
  }
  const obj: Record<string, unknown> = {};
  const n = Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    obj[randomFuzzString(rng, 8)] = randomFuzzJson(rng, depth + 1);
  }
  return obj;
}

test("sanitizeText never throws on arbitrary input", () => {
  const rng = mulberry32(0xc0ffee);
  for (let i = 0; i < 20_000; i++) {
    const input = randomFuzzString(rng, 512);
    const out = sanitizeText(input);
    assert.equal(typeof out, "string");
    assert.ok(out.length <= input.length + 1, "sanitizer must not expand input");
  }
});

test("sanitizeMarkdown never throws and never leaks a dangerous scheme", () => {
  const rng = mulberry32(0xbeef);
  for (let i = 0; i < 10_000; i++) {
    const input = randomFuzzString(rng, 256);
    const out = sanitizeMarkdown(input);
    assert.equal(typeof out, "string");
    assert.ok(!/javascript\s*:/i.test(out), "must not leak javascript: scheme");
    assert.ok(!/vbscript\s*:/i.test(out), "must not leak vbscript: scheme");
  }
});

test("validateActionPayload fails closed or succeeds, never crashes", () => {
  const rng = mulberry32(0xabcd);
  for (let i = 0; i < 20_000; i++) {
    const payload = randomFuzzJson(rng);
    try {
      const result = validateActionPayload(payload);
      assert.equal(typeof result.actionId, "string");
      assert.equal(typeof result.type, "string");
      assert.equal(typeof result.title, "string");
    } catch (err) {
      assert.ok(
        err instanceof InvalidActionPayloadError,
        `unexpected error type: ${(err as Error).name}`,
      );
    }
  }
});
