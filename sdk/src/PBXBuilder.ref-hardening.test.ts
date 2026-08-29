import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REF_DEPTH,
  PBXBuilder,
  PBXCycleDetectedError,
  PBXMaxDepthExceededError,
  addObject,
  createDocument,
  linkObject,
  resolveRef,
  resolveRefChain,
  rootObject,
  setBrokenRefReporter,
  type PBXDocument,
  type PBXObject,
} from "./pbx";

/**
 * Point `obj` at a `$ref` proxy chain of `proxyCount` objects, terminated by a
 * real (non-proxy) leaf object. Returns the final leaf object.
 */
function buildProxyChain(doc: PBXDocument, proxyCount: number): PBXObject {
  let prev = rootObject(doc)!;
  for (let i = 0; i < proxyCount - 1; i++) {
    const id = addObject(doc, "P2P.Proxy", { $ref: "" });
    prev.$ref = id;
    prev = doc.$objects[id] as PBXObject;
  }
  const leafId = addObject(doc, "P2P.End", { payload: "done" });
  prev.$ref = leafId;
  return doc.$objects[leafId] as PBXObject;
}

test("resolveRefChain resolves a normal ref (no proxy) in a single hop", () => {
  const doc = createDocument("P2P.Root");
  const target = addObject(doc, "P2P.Leaf", { value: 1 });
  const resolved = resolveRefChain(doc, linkObject(doc, target));
  assert.equal(resolved?.$id, target);
  assert.equal(resolved?.value, 1);
});

test("direct cycle: A $ref -> A throws PBXCycleDetectedError", () => {
  const doc = createDocument("P2P.Proxy");
  const root = rootObject(doc)!;
  root.$ref = root.$id;

  assert.throws(() => resolveRefChain(doc, doc.$top.root), PBXCycleDetectedError);
});

test("indirect cycle: A -> B -> C -> A throws PBXCycleDetectedError", () => {
  const doc = createDocument("P2P.Proxy");
  const a = rootObject(doc)!;
  const bId = addObject(doc, "P2P.Proxy", { $ref: "" });
  const cId = addObject(doc, "P2P.Proxy", { $ref: "" });
  a.$ref = bId;
  doc.$objects[bId].$ref = cId;
  doc.$objects[cId].$ref = a.$id;

  assert.throws(() => resolveRefChain(doc, doc.$top.root), PBXCycleDetectedError);
});

test("PBXCycleDetectedError carries the $id that closed the cycle", () => {
  const doc = createDocument("P2P.Proxy");
  const root = rootObject(doc)!;
  root.$ref = root.$id;

  try {
    resolveRefChain(doc, doc.$top.root);
    assert.fail("expected PBXCycleDetectedError");
  } catch (err) {
    assert.ok(err instanceof PBXCycleDetectedError);
    assert.equal(err.objectId, root.$id);
    assert.match(err.message, new RegExp(root.$id));
    assert.match(err.message, /cycle/i);
  }
});

test("max depth: a 17-link $ref chain throws PBXMaxDepthExceededError", () => {
  const doc = createDocument("P2P.Proxy");
  buildProxyChain(doc, MAX_REF_DEPTH + 1);

  assert.throws(
    () => resolveRefChain(doc, doc.$top.root),
    PBXMaxDepthExceededError,
  );
});

test("PBXMaxDepthExceededError carries maxDepth", () => {
  const doc = createDocument("P2P.Proxy");
  buildProxyChain(doc, MAX_REF_DEPTH + 1);

  try {
    resolveRefChain(doc, doc.$top.root);
    assert.fail("expected PBXMaxDepthExceededError");
  } catch (err) {
    assert.ok(err instanceof PBXMaxDepthExceededError);
    assert.equal(err.maxDepth, MAX_REF_DEPTH);
    assert.equal(MAX_REF_DEPTH, 16);
  }
});

test("a chain of exactly MAX_REF_DEPTH links resolves (boundary is inclusive)", () => {
  const doc = createDocument("P2P.Proxy");
  const leaf = buildProxyChain(doc, MAX_REF_DEPTH);

  const resolved = resolveRefChain(doc, doc.$top.root);
  assert.equal(resolved, leaf);
  assert.equal(resolved?.payload, "done");
});

test("valid refs: multiple independent refs to the same sub-object resolve identically", () => {
  const doc = createDocument("P2P.Root");
  const shared = addObject(doc, "P2P.Shared", { value: 42 });
  const root = rootObject(doc)!;
  root.first = linkObject(doc, shared);
  root.second = linkObject(doc, shared);

  const viaFirst = resolveRefChain(doc, root.first as { $ref: string });
  const viaSecond = resolveRefChain(doc, root.second as { $ref: string });

  assert.ok(viaFirst);
  assert.equal(viaFirst, viaSecond);
  assert.equal(viaFirst.$id, shared);
  assert.equal(viaFirst.value, 42);
});

test("valid refs: a legit two-hop chain resolves through an intermediate proxy", () => {
  const doc = createDocument("P2P.Proxy");
  const root = rootObject(doc)!;
  const midId = addObject(doc, "P2P.Proxy", { $ref: "" });
  const endId = addObject(doc, "P2P.End", { value: "leaf" });
  root.$ref = midId;
  doc.$objects[midId].$ref = endId;

  const resolved = resolveRefChain(doc, doc.$top.root);
  assert.equal(resolved?.$id, endId);
  assert.equal(resolved?.value, "leaf");
});

test("resolveRef stays single-hop; resolveRefChain is the cycle-safe follower", () => {
  const doc = createDocument("P2P.Proxy");
  const root = rootObject(doc)!;
  const endId = addObject(doc, "P2P.End", { value: "leaf" });
  root.$ref = endId;

  assert.equal(resolveRef(doc, doc.$top.root), root);
  assert.equal(resolveRefChain(doc, doc.$top.root)?.$id, endId);
});

test("dangling refs resolve to null (never throw) and are reported", () => {
  const doc = createDocument("P2P.Root");
  const reported: string[] = [];
  setBrokenRefReporter((ref) => reported.push(ref));
  try {
    assert.equal(resolveRefChain(doc, { $ref: "missing-id" }), null);
    assert.deepEqual(reported, ["missing-id"]);
  } finally {
    setBrokenRefReporter(null);
  }
  assert.equal(resolveRefChain(doc, null), null);
  assert.equal(resolveRefChain(doc, undefined), null);
});

test("malformed $objects never crash the chain resolver", () => {
  const bad = {
    $top: { root: { $ref: "x" } },
    $objects: null,
  } as unknown as PBXDocument;
  assert.equal(resolveRefChain(bad, { $ref: "x" }), null);

  const badEntry = {
    $top: { root: { $ref: "x" } },
    $objects: { x: 42 },
  } as unknown as PBXDocument;
  assert.equal(resolveRefChain(badEntry, { $ref: "x" }), null);
});

test("maxDepth option overrides the default limit", () => {
  const doc = createDocument("P2P.Proxy");
  const root = rootObject(doc)!;
  const midId = addObject(doc, "P2P.Proxy", { $ref: "" });
  const endId = addObject(doc, "P2P.End", { value: "leaf" });
  root.$ref = midId;
  doc.$objects[midId].$ref = endId;

  assert.throws(
    () => resolveRefChain(doc, doc.$top.root, { maxDepth: 1 }),
    PBXMaxDepthExceededError,
  );
  assert.equal(resolveRefChain(doc, doc.$top.root)?.$id, endId);
});

test("PBX errors are ordinary catchable Errors (TaskBroker boundary contract)", () => {
  const doc = createDocument("P2P.Proxy");
  const root = rootObject(doc)!;
  root.$ref = root.$id;

  let boundary: { status: string; error: string } | null = null;
  try {
    resolveRefChain(doc, doc.$top.root);
  } catch (err) {
    boundary = {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  assert.ok(boundary);
  assert.equal(boundary.status, "error");
  assert.match(boundary.error, /cycle/i);
});

test("PBXBuilder.resolveRefChain mirrors the standalone function", () => {
  const builder = new PBXBuilder();
  const doc = builder.createDocument("P2P.Proxy");
  const root = rootObject(doc)!;
  const endId = builder.addObject(doc, "P2P.End", { value: "leaf" });
  root.$ref = endId;

  assert.equal(builder.resolveRefChain(doc, doc.$top.root)?.$id, endId);

  const cyclic = builder.createDocument("P2P.Proxy");
  const cycRoot = rootObject(cyclic)!;
  cycRoot.$ref = cycRoot.$id;
  assert.throws(
    () => builder.resolveRefChain(cyclic, cyclic.$top.root),
    PBXCycleDetectedError,
  );
});

test("a 17-link chain never loops: resolution terminates with the typed error", () => {
  const doc = createDocument("P2P.Proxy");
  buildProxyChain(doc, MAX_REF_DEPTH + 1);

  let error: unknown;
  try {
    resolveRefChain(doc, doc.$top.root);
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof PBXMaxDepthExceededError, "must throw, not loop");
});
