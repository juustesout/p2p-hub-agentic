import type { PluginContext } from "@p2p-hub/core";
import {
  addObject,
  createDocument,
  linkObject,
  resolveRef,
  rootObject,
  type PBXDocument,
  type PBXObject,
  type PBXReference,
} from "@p2p-hub/sdk";

/**
 * AI Smart Note — the reference application for the PBX/OLE document standard.
 *
 * Every note is a {@link PBXDocument}: a `P2P.SmartNote` root that links to
 * `P2P.TextBlock` children via `$ref` pointers, and can embed external objects
 * (an AI Canvas image, a spreadsheet cell, …) through OLE `$ref` links. All
 * contents are typed, UUID-indexed PBX objects — never ad-hoc JSON.
 */

export interface CreateNoteInput {
  title: string;
  content: string;
}

export interface AiTransformBlockInput {
  noteId: string;
  blockId: string;
  instruction: string;
}

export interface EmbedObjectInput {
  noteId: string;
  targetObjectId: string;
  targetClass: string;
}

export interface NotepadPlugin {
  createNote(input: CreateNoteInput): Promise<PBXDocument>;
  getNote(noteId: string): Promise<PBXDocument | null>;
  listNotes(): Promise<PBXDocument[]>;
  aiTransformBlock(input: AiTransformBlockInput): Promise<PBXObject>;
  embedObject(input: EmbedObjectInput): Promise<PBXDocument>;
}

const NOTE_KEY_PREFIX = "note:";
const TEXT_BLOCK_CLASS = "P2P.TextBlock";
const EMBEDDED_CLASS = "P2P.EmbeddedObject";

function noteKey(noteId: string): string {
  return `${NOTE_KEY_PREFIX}${noteId}`;
}

function isPBXDocument(value: unknown): value is PBXDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as PBXDocument).$top === "object" &&
    typeof (value as PBXDocument).$objects === "object"
  );
}

export default function activate(ctx: PluginContext): NotepadPlugin {
  async function getNote(noteId: string): Promise<PBXDocument | null> {
    const value = await ctx.storage.get(noteKey(noteId));
    return isPBXDocument(value) ? value : null;
  }

  async function listNotes(): Promise<PBXDocument[]> {
    const keys = await ctx.storage.list(NOTE_KEY_PREFIX);
    const notes: PBXDocument[] = [];
    for (const key of keys) {
      const value = await ctx.storage.get(key);
      if (isPBXDocument(value)) {
        notes.push(value);
      }
    }
    return notes;
  }

  async function createNote(input: CreateNoteInput): Promise<PBXDocument> {
    const title = (input.title ?? "").trim();
    if (!title) {
      throw new Error("createNote: title must not be empty");
    }
    const now = new Date().toISOString();

    const doc = createDocument("P2P.SmartNote", {
      title,
      createdAt: now,
      updatedAt: now,
    });
    const root = rootObject(doc)!;

    const blockId = addObject(doc, TEXT_BLOCK_CLASS, {
      text: input.content ?? "",
      type: "markdown",
    });
    root.blocks = [linkObject(doc, blockId)];

    const noteId = root.$id;
    await ctx.storage.set(noteKey(noteId), doc);
    await ctx.hooks.emit("notepad:noteCreated", { noteId, title });
    return doc;
  }

  async function aiTransformBlock(
    input: AiTransformBlockInput,
  ): Promise<PBXObject> {
    const { noteId, blockId, instruction } = input;
    if (!noteId || !blockId || !instruction.trim()) {
      throw new Error(
        "aiTransformBlock: noteId, blockId and instruction are required",
      );
    }

    const doc = await getNote(noteId);
    if (!doc) {
      throw new Error(`aiTransformBlock: note "${noteId}" not found`);
    }

    const block = doc.$objects[blockId];
    if (!block) {
      throw new Error(
        `aiTransformBlock: block "${blockId}" not found in note "${noteId}"`,
      );
    }
    if (typeof block.text !== "string") {
      throw new Error(`aiTransformBlock: block "${blockId}" has no text`);
    }

    // AI access goes exclusively through ctx.ai — never a raw vault key.
    const rewritten = await ctx.ai.generateText({
      prompt: instruction,
      system: block.text,
    });

    block.text = rewritten;
    block.updatedAt = new Date().toISOString();

    const root = rootObject(doc);
    if (root) {
      root.updatedAt = new Date().toISOString();
    }

    await ctx.storage.set(noteKey(noteId), doc);
    await ctx.hooks.emit("notepad:noteUpdated", { noteId, blockId });
    return block;
  }

  async function embedObject(input: EmbedObjectInput): Promise<PBXDocument> {
    const { noteId, targetObjectId, targetClass } = input;
    if (!noteId || !targetObjectId || !targetClass) {
      throw new Error(
        "embedObject: noteId, targetObjectId and targetClass are required",
      );
    }

    const doc = await getNote(noteId);
    if (!doc) {
      throw new Error(`embedObject: note "${noteId}" not found`);
    }

    // Import the external object as a typed PBX node, then link it via OLE.
    const embedId = addObject(doc, EMBEDDED_CLASS, {
      targetClass,
      targetId: targetObjectId,
      embeddedAt: new Date().toISOString(),
    });

    const root = rootObject(doc)!;
    const embedded = Array.isArray(root.embedded)
      ? (root.embedded as PBXReference[])
      : [];
    embedded.push(linkObject(doc, embedId));
    root.embedded = embedded;
    root.updatedAt = new Date().toISOString();

    await ctx.storage.set(noteKey(noteId), doc);
    await ctx.hooks.emit("notepad:noteUpdated", {
      noteId,
      embeddedObjectId: embedId,
    });
    return doc;
  }

  ctx.skills.register(
    "createNote",
    async (payload) => {
      const { title, content } = (payload ?? {}) as {
        title?: unknown;
        content?: unknown;
      };
      if (typeof title !== "string" || typeof content !== "string") {
        throw new Error("createNote expects { title: string, content: string }");
      }
      return createNote({ title, content });
    },
    { localOnly: true },
  );

  ctx.skills.register(
    "listNotes",
    async () => listNotes(),
    { localOnly: true },
  );

  ctx.skills.register(
    "getNote",
    async (payload) => {
      const { noteId } = (payload ?? {}) as { noteId?: unknown };
      if (typeof noteId !== "string") {
        throw new Error("getNote expects { noteId: string }");
      }
      return getNote(noteId);
    },
    { localOnly: true },
  );

  ctx.skills.register(
    "aiTransformBlock",
    async (payload) => {
      const { noteId, blockId, instruction } = (payload ?? {}) as {
        noteId?: unknown;
        blockId?: unknown;
        instruction?: unknown;
      };
      if (
        typeof noteId !== "string" ||
        typeof blockId !== "string" ||
        typeof instruction !== "string"
      ) {
        throw new Error(
          "aiTransformBlock expects { noteId: string, blockId: string, instruction: string }",
        );
      }
      return aiTransformBlock({ noteId, blockId, instruction });
    },
    { localOnly: true },
  );

  ctx.skills.register(
    "embedObject",
    async (payload) => {
      const { noteId, targetObjectId, targetClass } = (payload ?? {}) as {
        noteId?: unknown;
        targetObjectId?: unknown;
        targetClass?: unknown;
      };
      if (
        typeof noteId !== "string" ||
        typeof targetObjectId !== "string" ||
        typeof targetClass !== "string"
      ) {
        throw new Error(
          "embedObject expects { noteId: string, targetObjectId: string, targetClass: string }",
        );
      }
      return embedObject({ noteId, targetObjectId, targetClass });
    },
    { localOnly: true },
  );

  return {
    createNote,
    getNote,
    listNotes,
    aiTransformBlock,
    embedObject,
  };
}
