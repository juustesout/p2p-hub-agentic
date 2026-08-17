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

interface NotepadApi {
  createNote(input: {
    title: string;
    content: string;
  }): Promise<PBXDocument>;
  getNote(noteId: string): Promise<PBXDocument | null>;
  listNotes(): Promise<PBXDocument[]>;
  aiTransformBlock(input: {
    noteId: string;
    blockId: string;
    instruction: string;
  }): Promise<PBXObject>;
  embedObject(input: {
    noteId: string;
    targetObjectId: string;
    targetClass: string;
  }): Promise<PBXDocument>;
}

async function loadNotepad(): Promise<{
  notepad: NotepadApi;
  storageManager: StorageManager;
  hooks: HookRegistry;
  broker: TaskBroker;
  dataDir: string;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "notepad-data-"));
  const storageManager = new StorageManager(dataDir);
  const hooks = new HookRegistry();
  const broker = new TaskBroker();
  const notepad = (await loadPlugin(
    pluginDir,
    storageManager,
    hooks,
    broker,
  )) as NotepadApi;
  return { notepad, storageManager, hooks, broker, dataDir };
}

test("createNote builds a P2P.SmartNote document with a linked text block", async () => {
  const { notepad, hooks, dataDir } = await loadNotepad();
  const created: unknown[] = [];
  hooks.on("notepad:noteCreated", (p) => {
    created.push(p);
  });

  const doc = await notepad.createNote({
    title: "Meeting",
    content: "Discuss the PBX standard",
  });

  const root = rootObject(doc)!;
  assert.equal(root.$class, "P2P.SmartNote");
  assert.equal(root.title, "Meeting");
  assert.equal(typeof root.createdAt, "string");

  const block = resolveRef(doc, (root.blocks as PBXReference[])[0])!;
  assert.equal(block.$class, "P2P.TextBlock");
  assert.equal(block.text, "Discuss the PBX standard");
  assert.equal(block.type, "markdown");

  // Persisted under `note:<id>` and retrievable.
  const stored = await notepad.getNote(root.$id);
  assert.ok(stored);
  assert.equal(stored.$objects[block.$id].text, "Discuss the PBX standard");

  assert.equal(created.length, 1);

  // Isolation: on-disk file holds only this plugin's own keys.
  const raw = await fs.readFile(path.join(dataDir, "notepad.json"), "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [`note:${root.$id}`]);
});

test("createNote rejects an empty title", async () => {
  const { notepad } = await loadNotepad();
  await assert.rejects(
    notepad.createNote({ title: "   ", content: "x" }),
    /title must not be empty/,
  );
});

test("aiTransformBlock rewrites a block through ctx.ai and emits noteUpdated", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "notepad-data-"));
  const storageManager = new StorageManager(dataDir);
  const hooks = new HookRegistry();
  const updated: unknown[] = [];
  hooks.on("notepad:noteUpdated", (p) => {
    updated.push(p);
  });

  // Local AI endpoint (no key required) with a stubbed transport so the
  // request never leaves the process.
  const vault = new VaultManager({ dataDir, masterKey: "test-master-key" });
  await vault.setSecret("ai.baseUrl", "http://localhost:11434");

  const calls: Array<{ system?: string; prompt?: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: unknown) => {
    const body = JSON.parse(
      String((init as { body?: unknown } | undefined)?.body ?? "{}"),
    ) as { messages?: Array<{ role: string; content?: string }> };
    calls.push({
      system: body.messages?.[0]?.content,
      prompt: body.messages?.[1]?.content,
    });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "MEETING SUMMARY" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const notepad = (await loadPlugin(
      pluginDir,
      storageManager,
      hooks,
      new TaskBroker(),
      vault,
    )) as NotepadApi;

    const doc = await notepad.createNote({
      title: "Notes",
      content: "raw block text",
    });
    const root = rootObject(doc)!;
    const block = resolveRef(doc, (root.blocks as PBXReference[])[0])!;

    const transformed = await notepad.aiTransformBlock({
      noteId: root.$id,
      blockId: block.$id,
      instruction: "Summarize this",
    });

    assert.equal(transformed.text, "MEETING SUMMARY");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].system, "raw block text");
    assert.equal(calls[0].prompt, "Summarize this");

    const stored = await notepad.getNote(root.$id);
    assert.equal(stored?.$objects[block.$id].text, "MEETING SUMMARY");
    assert.equal(updated.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("aiTransformBlock rejects a missing note", async () => {
  const { notepad } = await loadNotepad();
  await assert.rejects(
    notepad.aiTransformBlock({
      noteId: "nope",
      blockId: "block",
      instruction: "Summarize",
    }),
    /not found/,
  );
});

test("embedObject links an external object via OLE and resolveRef resolves it", async () => {
  const { notepad, hooks } = await loadNotepad();
  const updated: unknown[] = [];
  hooks.on("notepad:noteUpdated", (p) => {
    updated.push(p);
  });

  const doc = await notepad.createNote({ title: "Design", content: "sketch" });
  const noteId = rootObject(doc)!.$id;

  const result = await notepad.embedObject({
    noteId,
    targetObjectId: "canvas-123",
    targetClass: "P2P.CanvasImage",
  });

  const embeddedRefs = rootObject(result)!.embedded as PBXReference[];
  assert.equal(embeddedRefs.length, 1);

  const embedded = resolveRef(result, embeddedRefs[0])!;
  assert.equal(embedded.$class, "P2P.EmbeddedObject");
  assert.equal(embedded.targetId, "canvas-123");
  assert.equal(embedded.targetClass, "P2P.CanvasImage");

  // OLE validation: the root -> embedded link resolves to the imported node.
  assert.equal(resolveRef(result, embeddedRefs[0]), embedded);

  // Second embed accumulates and both persist.
  await notepad.embedObject({
    noteId,
    targetObjectId: "sheet-A1",
    targetClass: "P2P.Cell",
  });
  const stored = await notepad.getNote(noteId);
  const storedRefs = rootObject(stored!)!.embedded as PBXReference[];
  assert.equal(storedRefs.length, 2);
  assert.equal(updated.length, 2);
});

test("embedObject rejects a missing note", async () => {
  const { notepad } = await loadNotepad();
  await assert.rejects(
    notepad.embedObject({
      noteId: "nope",
      targetObjectId: "x",
      targetClass: "P2P.Cell",
    }),
    /not found/,
  );
});

test("listNotes returns every stored note document", async () => {
  const { notepad } = await loadNotepad();
  await notepad.createNote({ title: "A", content: "one" });
  await notepad.createNote({ title: "B", content: "two" });

  const notes = await notepad.listNotes();
  assert.equal(notes.length, 2);
  const titles = notes.map((n) => rootObject(n)!.title).sort();
  assert.deepEqual(titles, ["A", "B"]);
});

test("skills are registered in the notepad namespace and local-only by default", async () => {
  const { broker } = await loadNotepad();
  const names = broker.listSkills().map((s) => s.skill).sort();
  assert.deepEqual(names, [
    "notepad.aiTransformBlock",
    "notepad.createNote",
    "notepad.embedObject",
    "notepad.getNote",
    "notepad.listNotes",
  ]);
  for (const entry of broker.listSkills()) {
    assert.equal(entry.localOnly, true);
  }
});
