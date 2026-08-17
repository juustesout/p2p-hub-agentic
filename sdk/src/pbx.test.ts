import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PBXBuilder,
  addObject,
  createDocument,
  deserialize,
  isPBXDocument,
  isPBXObject,
  isPBXReference,
  linkObject,
  resolveRef,
  rootObject,
  serialize,
  uuidV4,
  type PBXDocument,
} from "./pbx";

test("uuidV4 returns a valid RFC 4122 version-4 UUID", () => {
  const id = uuidV4();
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(uuidV4(), uuidV4());
});

test("createDocument produces a document with only $top and $objects", () => {
  const doc = createDocument("P2P.SmartNote", { title: "Hello" });
  assert.deepEqual(Object.keys(doc).sort(), ["$objects", "$top"]);

  const root = rootObject(doc);
  assert.ok(root);
  assert.equal(root.$class, "P2P.SmartNote");
  assert.equal(root.title, "Hello");
  assert.equal(typeof root.$id, "string");

  // The root object is registered in $objects under its own id.
  assert.equal(doc.$objects[root.$id], root);
  assert.equal(doc.$top.root.$ref, root.$id);
});

test("createDocument ignores reserved structural keys in rootData", () => {
  const doc = createDocument("P2P.SmartNote", {
    $id: "forged",
    $class: "P2P.Evil",
    title: "Safe",
  });
  const root = rootObject(doc)!;
  assert.notEqual(root.$id, "forged");
  assert.equal(root.$class, "P2P.SmartNote");
  assert.equal(root.title, "Safe");
});

test("addObject registers a new object and returns its UUID", () => {
  const doc = createDocument("P2P.SmartNote");
  const blockId = addObject(doc, "P2P.TextBlock", { text: "hi" });

  assert.equal(typeof blockId, "string");
  const block = doc.$objects[blockId];
  assert.ok(isPBXObject(block));
  assert.equal(block.$class, "P2P.TextBlock");
  assert.equal(block.text, "hi");
});

test("linkObject + resolveRef round-trips a reference", () => {
  const doc = createDocument("P2P.SmartNote");
  const blockId = addObject(doc, "P2P.TextBlock", { text: "hi" });
  const ref = linkObject(doc, blockId);

  assert.ok(isPBXReference(ref));
  assert.equal(ref.$ref, blockId);

  const resolved = resolveRef(doc, ref);
  assert.ok(resolved);
  assert.equal(resolved.$id, blockId);
  assert.equal(resolved.$class, "P2P.TextBlock");
});

test("resolveRef returns null for dangling or missing references (OLE safety)", () => {
  const doc = createDocument("P2P.SmartNote");

  assert.equal(resolveRef(doc, { $ref: "does-not-exist" }), null);
  assert.equal(resolveRef(doc, null), null);
  assert.equal(resolveRef(doc, undefined), null);
  assert.equal(resolveRef(doc, { $ref: "" }), null);
});

test("OLE: a chain of nested references resolves across linked objects", () => {
  const doc = createDocument("P2P.SmartNote");
  const root = rootObject(doc)!;

  // Note -> TextBlock -> embedded CanvasImage
  const blockId = addObject(doc, "P2P.TextBlock", { text: "see image" });
  const imageId = addObject(doc, "P2P.CanvasImage", { width: 100, height: 50 });
  doc.$objects[blockId].embedded = linkObject(doc, imageId);
  root.blocks = [linkObject(doc, blockId)];

  const block = resolveRef(doc, (root.blocks as { $ref: string }[])[0])!;
  assert.equal(block.$class, "P2P.TextBlock");

  const image = resolveRef(doc, block.embedded as { $ref: string });
  assert.ok(image);
  assert.equal(image.$class, "P2P.CanvasImage");
  assert.equal(image.width, 100);
});

test("serialize/deserialize round-trips without loss", () => {
  const doc = createDocument("P2P.SmartNote", { title: "Round trip" });
  const blockId = addObject(doc, "P2P.TextBlock", { text: "persist me" });
  rootObject(doc)!.blocks = [linkObject(doc, blockId)];

  const raw = serialize(doc);
  const restored = deserialize(raw);

  assert.ok(isPBXDocument(restored));
  assert.equal(restored.$top.root.$ref, doc.$top.root.$ref);
  assert.deepEqual(Object.keys(restored.$objects), Object.keys(doc.$objects));
  assert.equal(restored.$objects[blockId].text, "persist me");
});

test("deserialize rejects non-JSON and non-PBX input", () => {
  assert.throws(() => deserialize("not json"), /not valid JSON/);
  assert.throws(() => deserialize('{"foo": 1}'), /not a valid PBX document/);
  assert.throws(() => deserialize("42"), /not a valid PBX document/);
});

test("linkObject rejects an empty target id", () => {
  const doc = createDocument("P2P.SmartNote");
  assert.throws(() => linkObject(doc, ""), /non-empty target UUID/);
});

test("PBXBuilder mirrors the standalone helpers", () => {
  const builder = new PBXBuilder();
  const doc = builder.createDocument("P2P.Sheet");
  const cellId = builder.addObject(doc, "P2P.Cell", { value: "=1+1" });
  rootObject(doc)!.cells = [builder.linkObject(doc, cellId)];

  const cell = builder.resolveRef(doc, builder.linkObject(doc, cellId));
  assert.equal(cell?.$class, "P2P.Cell");

  const restored = builder.deserialize(builder.serialize(doc)) as PBXDocument;
  assert.equal(restored.$objects[cellId].value, "=1+1");
});
