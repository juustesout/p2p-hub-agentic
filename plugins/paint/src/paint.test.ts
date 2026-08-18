import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  HookRegistry,
  StorageManager,
  TaskBroker,
  VaultManager,
  loadPlugin,
} from "@p2p-hub/core";
import {
  resolveRef,
  rootObject,
  type PBXDocument,
  type PBXObject,
  type PBXReference,
} from "@p2p-hub/sdk";

const pluginDir = path.resolve(__dirname, "..");
const notepadDir = path.resolve(__dirname, "../../notepad");

interface PaintApi {
  createCanvas(input: {
    title: string;
    width?: number;
    height?: number;
  }): Promise<PBXDocument>;
  getCanvas(canvasId: string): Promise<PBXDocument | null>;
  listCanvases(): Promise<PBXDocument[]>;
  addLayer(input: {
    canvasId: string;
    kind: "raster" | "vector";
    data: string;
    visible?: boolean;
    opacity?: number;
  }): Promise<PBXObject>;
  updateLayer(input: {
    canvasId: string;
    layerId: string;
    data?: string;
    visible?: boolean;
    opacity?: number;
  }): Promise<PBXObject>;
  deleteLayer(input: {
    canvasId: string;
    layerId: string;
  }): Promise<PBXDocument>;
  aiGenerateImage(input: {
    canvasId: string;
    prompt: string;
    size?: "256x256" | "512x512" | "1024x1024";
  }): Promise<PBXObject>;
  embedObject(input: {
    canvasId: string;
    targetObjectId: string;
    targetClass: string;
  }): Promise<PBXDocument>;
  exportPNG(canvasId: string): Promise<{
    dataUrl: string;
    mime: string;
    width: number;
    height: number;
  }>;
}

interface NotepadApi {
  createNote(input: { title: string; content: string }): Promise<PBXDocument>;
  embedObject(input: {
    noteId: string;
    targetObjectId: string;
    targetClass: string;
  }): Promise<PBXDocument>;
}

async function loadPaint() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "paint-data-"));
  const storageManager = new StorageManager(dataDir);
  const hooks = new HookRegistry();
  const broker = new TaskBroker();
  const vault = new VaultManager({ dataDir, masterKey: "test-master-key" });
  const paint = (await loadPlugin(
    pluginDir,
    storageManager,
    hooks,
    broker,
    vault,
  )) as PaintApi;
  return { paint, storageManager, hooks, broker, vault, dataDir };
}

function stubImageFetch(b64: string | null): {
  restore: () => void;
  prompts: string[];
} {
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: unknown) => {
    const body = JSON.parse(
      String((init as { body?: unknown } | undefined)?.body ?? "{}"),
    ) as { prompt?: string; size?: string };
    prompts.push(body.prompt ?? "");
    return new Response(
      JSON.stringify({ data: b64 ? [{ b64_json: b64 }] : [] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    prompts,
  };
}

test("createCanvas builds a P2P.Canvas document with empty layers", async () => {
  const { paint, hooks, dataDir } = await loadPaint();
  const created: unknown[] = [];
  hooks.on("paint:canvasCreated", (p) => {
    created.push(p);
  });

  const doc = await paint.createCanvas({ title: "Sketch", width: 640, height: 480 });

  const root = rootObject(doc)!;
  assert.equal(root.$class, "P2P.Canvas");
  assert.equal(root.title, "Sketch");
  assert.equal(root.width, 640);
  assert.equal(root.height, 480);
  assert.deepEqual(root.layers, []);
  assert.deepEqual(root.embedded, []);
  assert.equal(created.length, 1);

  // Persisted under `canvas:<id>` and retrievable.
  const stored = await paint.getCanvas(root.$id);
  assert.ok(stored);
  assert.equal(stored.$objects[root.$id].title, "Sketch");

  // Isolation: on-disk file holds only this plugin's own keys.
  const raw = await fs.readFile(path.join(dataDir, "paint.json"), "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [`canvas:${root.$id}`]);
});

test("createCanvas rejects an empty title and defaults dimensions", async () => {
  const { paint } = await loadPaint();
  await assert.rejects(
    paint.createCanvas({ title: "   " }),
    /title must not be empty/,
  );
  const doc = await paint.createCanvas({ title: "Defaults" });
  const root = rootObject(doc)!;
  assert.equal(root.width, 800);
  assert.equal(root.height, 600);
});

test("addLayer links a P2P.Layer and updateLayer mutates it", async () => {
  const { paint, hooks } = await loadPaint();
  const added: unknown[] = [];
  const updated: unknown[] = [];
  hooks.on("paint:layerAdded", (p) => {
    added.push(p);
  });
  hooks.on("paint:layerUpdated", (p) => {
    updated.push(p);
  });

  const doc = await paint.createCanvas({ title: "Layers" });
  const canvasId = rootObject(doc)!.$id;

  const layer = await paint.addLayer({
    canvasId,
    kind: "vector",
    data: "<svg><rect width='10' height='10'/></svg>",
    opacity: 0.5,
  });
  assert.equal(layer.$class, "P2P.Layer");
  assert.equal(layer.kind, "vector");
  assert.equal(layer.visible, true);
  assert.equal(layer.opacity, 0.5);

  const stored = await paint.getCanvas(canvasId);
  const ref = (rootObject(stored!)!.layers as PBXReference[])[0];
  const resolved = resolveRef(stored!, ref)!;
  assert.equal(resolved.$id, layer.$id);

  const mutated = await paint.updateLayer({
    canvasId,
    layerId: layer.$id,
    visible: false,
    opacity: 0.2,
  });
  assert.equal(mutated.visible, false);
  assert.equal(mutated.opacity, 0.2);
  assert.equal(added.length, 1);
  assert.equal(updated.length, 1);
});

test("deleteLayer unlinks and removes the layer object", async () => {
  const { paint } = await loadPaint();
  const doc = await paint.createCanvas({ title: "Del" });
  const canvasId = rootObject(doc)!.$id;
  const layer = await paint.addLayer({ canvasId, kind: "raster", data: "AAAA" });

  const result = await paint.deleteLayer({ canvasId, layerId: layer.$id });
  const root = rootObject(result)!;
  assert.deepEqual(root.layers, []);
  assert.equal(result.$objects[layer.$id], undefined);

  await assert.rejects(
    paint.deleteLayer({ canvasId, layerId: layer.$id }),
    /not found/,
  );
});

test("aiGenerateImage routes through ctx.ai.generateImage and adds a raster layer", async () => {
  const { paint, hooks, vault } = await loadPaint();
  await vault.setSecret("ai.baseUrl", "http://localhost:11434");
  const stub = stubImageFetch("aGVsbG8="); // base64 "hello"
  const added: unknown[] = [];
  hooks.on("paint:layerAdded", (p) => {
    added.push(p);
  });

  try {
    const doc = await paint.createCanvas({ title: "Gen" });
    const canvasId = rootObject(doc)!.$id;

    const layer = await paint.aiGenerateImage({
      canvasId,
      prompt: "a red square",
      size: "256x256",
    });

    assert.equal(layer.$class, "P2P.Layer");
    assert.equal(layer.kind, "raster");
    assert.equal(layer.data, "aGVsbG8=");
    assert.equal(layer.dataKind, "base64");
    assert.equal(layer.prompt, "a red square");
    assert.deepEqual(stub.prompts, ["a red square"]);
    assert.equal(added.length, 1);

    const stored = await paint.getCanvas(canvasId);
    const ref = (rootObject(stored!)!.layers as PBXReference[])[0];
    assert.equal(resolveRef(stored!, ref)!.data, "aGVsbG8=");
  } finally {
    stub.restore();
  }
});

test("aiGenerateImage returns a clean error when generation fails", async () => {
  const { paint, vault } = await loadPaint();
  await vault.setSecret("ai.baseUrl", "http://localhost:11434");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const doc = await paint.createCanvas({ title: "Gen" });
    const canvasId = rootObject(doc)!.$id;
    await assert.rejects(
      paint.aiGenerateImage({ canvasId, prompt: "anything" }),
      /generation failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("embedObject links an external object via OLE and resolves it", async () => {
  const { paint, hooks } = await loadPaint();
  const embedded: unknown[] = [];
  hooks.on("paint:objectEmbedded", (p) => {
    embedded.push(p);
  });

  const doc = await paint.createCanvas({ title: "Embed" });
  const canvasId = rootObject(doc)!.$id;

  const result = await paint.embedObject({
    canvasId,
    targetObjectId: "note-123",
    targetClass: "P2P.SmartNote",
  });

  const embeddedRefs = rootObject(result)!.embedded as PBXReference[];
  assert.equal(embeddedRefs.length, 1);
  const node = resolveRef(result, embeddedRefs[0])!;
  assert.equal(node.$class, "P2P.EmbeddedObject");
  assert.equal(node.targetId, "note-123");
  assert.equal(node.targetClass, "P2P.SmartNote");
  assert.equal(embedded.length, 1);
});

test("exportPNG flattens a single raster layer to a PNG data URL", async () => {
  const { paint } = await loadPaint();
  const doc = await paint.createCanvas({ title: "Export", width: 100, height: 80 });
  const canvasId = rootObject(doc)!.$id;
  await paint.addLayer({ canvasId, kind: "raster", data: "QUJD" });

  const result = await paint.exportPNG(canvasId);
  assert.equal(result.mime, "image/png");
  assert.equal(result.dataUrl, "data:image/png;base64,QUJD");
  assert.equal(result.width, 100);
  assert.equal(result.height, 80);
});

test("exportPNG composites visible layers into an SVG data URL", async () => {
  const { paint } = await loadPaint();
  const doc = await paint.createCanvas({ title: "Export" });
  const canvasId = rootObject(doc)!.$id;
  const vector = await paint.addLayer({ canvasId, kind: "vector", data: "<rect id='a'/>" });
  const hidden = await paint.addLayer({ canvasId, kind: "raster", data: "QUJD", visible: false });

  const result = await paint.exportPNG(canvasId);
  assert.equal(result.mime, "image/svg+xml");
  const svg = Buffer.from(result.dataUrl.split(",")[1], "base64").toString("utf8");
  assert.match(svg, /<rect id='a'\/>/);
  // The hidden layer must not appear in the flattened output.
  assert.doesNotMatch(svg, /QUJD/);

  // Toggling visibility flips the flatten back to a single-raster PNG.
  await paint.updateLayer({ canvasId, layerId: hidden.$id, visible: true });
  await paint.updateLayer({ canvasId, layerId: vector.$id, visible: false });
  const png = await paint.exportPNG(canvasId);
  assert.equal(png.mime, "image/png");
  assert.equal(png.dataUrl, "data:image/png;base64,QUJD");
});

test("listCanvases returns every stored canvas document", async () => {
  const { paint } = await loadPaint();
  await paint.createCanvas({ title: "A" });
  await paint.createCanvas({ title: "B" });

  const canvases = await paint.listCanvases();
  assert.equal(canvases.length, 2);
  const titles = canvases.map((c) => rootObject(c)!.title).sort();
  assert.deepEqual(titles, ["A", "B"]);
});

test("skills are registered in the paint namespace and local-only by default", async () => {
  const { broker } = await loadPaint();
  const names = broker.listSkills().map((s) => s.skill).sort();
  assert.deepEqual(names, [
    "paint.addLayer",
    "paint.aiGenerateImage",
    "paint.createCanvas",
    "paint.deleteLayer",
    "paint.embedObject",
    "paint.exportPNG",
    "paint.getCanvas",
    "paint.listCanvases",
    "paint.updateLayer",
  ]);
  for (const entry of broker.listSkills()) {
    assert.equal(entry.localOnly, true);
    assert.equal(entry.httpExposed, true);
  }
});

test("OLE embedding works across plugins: notepad embeds a canvas layer and vice versa", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "paint-ole-"));
  const storageManager = new StorageManager(dataDir);
  const hooks = new HookRegistry();
  const broker = new TaskBroker();
  const vault = new VaultManager({ dataDir, masterKey: "test-master-key" });

  const paint = (await loadPlugin(pluginDir, storageManager, hooks, broker, vault)) as PaintApi;
  const notepad = (await loadPlugin(notepadDir, storageManager, hooks, broker, vault)) as NotepadApi;

  // A canvas with one layer.
  const canvasDoc = await paint.createCanvas({ title: "Art" });
  const canvasId = rootObject(canvasDoc)!.$id;
  const layer = await paint.addLayer({ canvasId, kind: "raster", data: "QUJD" });

  // A notepad note.
  const noteDoc = await notepad.createNote({ title: "Idea", content: "sketch" });
  const noteId = rootObject(noteDoc)!.$id;

  // notepad embeds the canvas layer.
  const noteWithEmbed = await notepad.embedObject({
    noteId,
    targetObjectId: layer.$id,
    targetClass: "P2P.Layer",
  });
  const noteEmbed = resolveRef(
    noteWithEmbed,
    (rootObject(noteWithEmbed)!.embedded as PBXReference[])[0],
  )!;
  assert.equal(noteEmbed.$class, "P2P.EmbeddedObject");
  assert.equal(noteEmbed.targetId, layer.$id);
  assert.equal(noteEmbed.targetClass, "P2P.Layer");

  // paint embeds the note back.
  const canvasWithEmbed = await paint.embedObject({
    canvasId,
    targetObjectId: noteId,
    targetClass: "P2P.SmartNote",
  });
  const canvasEmbed = resolveRef(
    canvasWithEmbed,
    (rootObject(canvasWithEmbed)!.embedded as PBXReference[])[0],
  )!;
  assert.equal(canvasEmbed.targetId, noteId);
  assert.equal(canvasEmbed.targetClass, "P2P.SmartNote");

  // Both documents persist independently under their own key prefixes.
  const rawPaint = await fs.readFile(path.join(dataDir, "paint.json"), "utf8");
  const rawNotepad = await fs.readFile(path.join(dataDir, "notepad.json"), "utf8");
  assert.ok(JSON.parse(rawPaint)[`canvas:${canvasId}`]);
  assert.ok(JSON.parse(rawNotepad)[`note:${noteId}`]);
});
