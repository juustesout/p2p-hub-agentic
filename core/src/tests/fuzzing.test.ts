import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  InvalidManifestError,
  loadManifest,
} from "../plugin-loader/plugin-loader";
import {
  MAX_PBX_DEPTH,
  PBXDeserializationError,
  PBXRecursionDepthExceededError,
  addObject,
  createDocument,
  deserialize,
  isPBXDocument,
  linkObject,
  resolveRef,
  rootObject,
  setBrokenRefReporter,
  walkPBXObjects,
  type PBXDocument,
} from "@p2p-hub/sdk";

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
  "{}[]\":,.-_/\\abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n\t$#!?()";

function randomString(rng: () => number, maxLen = 64): string {
  const len = Math.floor(rng() * maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  }
  return out;
}

function randomJson(rng: () => number, depth = 0): unknown {
  if (depth > 3 || rng() < 0.2) {
    const scalars: unknown[] = [
      null,
      rng() < 0.5,
      Math.floor(rng() * 1000),
      randomString(rng, 20),
    ];
    return scalars[Math.floor(rng() * scalars.length)];
  }
  if (rng() < 0.5) {
    const arr: unknown[] = [];
    const n = Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) arr.push(randomJson(rng, depth + 1));
    return arr;
  }
  const obj: Record<string, unknown> = {};
  const n = Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) obj[randomString(rng, 8)] = randomJson(rng, depth + 1);
  return obj;
}

test("deserialize never crashes on random garbage (string fuzz)", () => {
  const rng = mulberry32(0x12345678);
  for (let i = 0; i < 5000; i++) {
    const raw = randomString(rng, 128);
    try {
      const doc = deserialize(raw);
      assert.ok(isPBXDocument(doc), "successful deserialize must yield a document");
    } catch (err) {
      assert.ok(
        err instanceof PBXDeserializationError,
        `unexpected error for ${JSON.stringify(raw)}: ` +
          `${(err as Error).constructor.name}: ${(err as Error).message}`,
      );
    }
  }
});

test("deserialize never crashes on random structured JSON (object fuzz)", () => {
  const rng = mulberry32(0xdeadbeef);
  for (let i = 0; i < 5000; i++) {
    let raw: string;
    try {
      raw = JSON.stringify(randomJson(rng));
    } catch {
      continue;
    }
    try {
      const doc = deserialize(raw);
      assert.ok(isPBXDocument(doc), "successful deserialize must yield a document");
    } catch (err) {
      assert.ok(
        err instanceof PBXDeserializationError,
        `unexpected error for ${JSON.stringify(raw)}: ` +
          `${(err as Error).constructor.name}: ${(err as Error).message}`,
      );
    }
  }
});

test("deserialize rejects a $objects entry that is not a PBX object", () => {
  assert.throws(
    () =>
      deserialize('{"$top":{"root":{"$ref":"x"}},"$objects":{"x":42}}'),
    PBXDeserializationError,
  );
  assert.throws(
    () =>
      deserialize('{"$top":{"root":{"$ref":"x"}},"$objects":{"x":{"$id":"x"}}}'),
    PBXDeserializationError,
  );
});

test("loadManifest never crashes on random garbage (file fuzz)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fuzz-manifest-"));
  const manifestPath = path.join(root, "manifest.json");
  const rng = mulberry32(0x9e3779b9);
  for (let i = 0; i < 1000; i++) {
    await fs.writeFile(manifestPath, randomString(rng, 128));
    try {
      await loadManifest(root);
    } catch (err) {
      assert.ok(
        err instanceof InvalidManifestError,
        `unexpected error: ${(err as Error).constructor.name}: ${(err as Error).message}`,
      );
    }
  }
});

test("walkPBXObjects visits reachable objects once and stops at depth", () => {
  const doc = createDocument("P2P.Node");
  const root = rootObject(doc)!;
  const child = addObject(doc, "P2P.Node");
  root.next = linkObject(doc, child);

  const visited: string[] = [];
  walkPBXObjects(doc, (obj, depth) => {
    visited.push(`${obj.$id}@${depth}`);
  });
  assert.equal(visited.length, 2);
  assert.ok(visited[0].startsWith(root.$id));
  assert.ok(visited[1].startsWith(`${child}@1`));
});

test("walkPBXObjects throws PBXRecursionDepthExceededError on a deep ref chain", () => {
  const doc = createDocument("P2P.Node");
  const root = rootObject(doc)!;
  let prevId = root.$id;
  for (let i = 0; i < MAX_PBX_DEPTH + 5; i++) {
    const id = addObject(doc, "P2P.Node");
    doc.$objects[prevId].next = linkObject(doc, id);
    prevId = id;
  }
  assert.throws(
    () => walkPBXObjects(doc, () => {}),
    PBXRecursionDepthExceededError,
  );
});

test("resolveRef reports dangling references via setBrokenRefReporter", () => {
  const doc = createDocument("P2P.Note");
  const reported: string[] = [];
  setBrokenRefReporter((ref) => reported.push(ref));
  try {
    assert.equal(resolveRef(doc, { $ref: "missing-id" }), null);
    assert.deepEqual(reported, ["missing-id"]);
  } finally {
    setBrokenRefReporter(null);
  }
});

test("resolveRef tolerates a malformed $objects map without crashing", () => {
  const doc = {
    $top: { root: { $ref: "x" } },
    $objects: null,
  } as unknown as PBXDocument;
  assert.equal(resolveRef(doc, { $ref: "x" }), null);

  const docArray = {
    $top: { root: { $ref: "x" } },
    $objects: { x: 42 },
  } as unknown as PBXDocument;
  assert.equal(resolveRef(docArray, { $ref: "x" }), null);
});
