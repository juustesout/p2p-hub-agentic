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
 * AI Canvas — a generative drawing app on the PBX/OLE document standard.
 *
 * Every canvas is a {@link PBXDocument}: a `P2P.Canvas` root that links to
 * `P2P.Layer` children via `$ref` pointers. Layers are either raster (base64
 * PNG or a remote URL) or vector (SVG markup). External objects — a notepad
 * note, a calc cell — can be embedded through OLE `$ref` links, and a canvas
 * layer can in turn be embedded elsewhere, without any plugin inventing its
 * own object model.
 *
 * AI access goes exclusively through `ctx.ai` (image generation via the
 * existing `CoreAIProvider.generateImage`); this plugin never reads a raw
 * vault key.
 */

export interface CreateCanvasInput {
  title: string;
  width?: number;
  height?: number;
}

export interface AddLayerInput {
  canvasId: string;
  kind: "raster" | "vector";
  data: string;
  visible?: boolean;
  opacity?: number;
}

export interface UpdateLayerInput {
  canvasId: string;
  layerId: string;
  data?: string;
  visible?: boolean;
  opacity?: number;
}

export interface DeleteLayerInput {
  canvasId: string;
  layerId: string;
}

export interface AiGenerateImageInput {
  canvasId: string;
  prompt: string;
  size?: "256x256" | "512x512" | "1024x1024";
}

export interface EmbedObjectInput {
  canvasId: string;
  targetObjectId: string;
  targetClass: string;
}

export interface ExportPNGResult {
  dataUrl: string;
  mime: "image/png" | "image/svg+xml";
  width: number;
  height: number;
}

export interface PaintPlugin {
  createCanvas(input: CreateCanvasInput): Promise<PBXDocument>;
  getCanvas(canvasId: string): Promise<PBXDocument | null>;
  listCanvases(): Promise<PBXDocument[]>;
  addLayer(input: AddLayerInput): Promise<PBXObject>;
  updateLayer(input: UpdateLayerInput): Promise<PBXObject>;
  deleteLayer(input: DeleteLayerInput): Promise<PBXDocument>;
  aiGenerateImage(input: AiGenerateImageInput): Promise<PBXObject>;
  embedObject(input: EmbedObjectInput): Promise<PBXDocument>;
  exportPNG(canvasId: string): Promise<ExportPNGResult>;
}

const CANVAS_KEY_PREFIX = "canvas:";
const ROOT_CLASS = "P2P.Canvas";
const LAYER_CLASS = "P2P.Layer";
const EMBEDDED_CLASS = "P2P.EmbeddedObject";

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;

function canvasKey(canvasId: string): string {
  return `${CANVAS_KEY_PREFIX}${canvasId}`;
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

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export default function activate(ctx: PluginContext): PaintPlugin {
  async function getCanvas(canvasId: string): Promise<PBXDocument | null> {
    const value = await ctx.storage.get(canvasKey(canvasId));
    return isPBXDocument(value) ? value : null;
  }

  async function requireCanvas(canvasId: string): Promise<PBXDocument> {
    const doc = await getCanvas(canvasId);
    if (!doc) {
      throw new Error(`canvas "${canvasId}" not found`);
    }
    return doc;
  }

  async function listCanvases(): Promise<PBXDocument[]> {
    const keys = await ctx.storage.list(CANVAS_KEY_PREFIX);
    const canvases: PBXDocument[] = [];
    for (const key of keys) {
      const value = await ctx.storage.get(key);
      if (isPBXDocument(value)) {
        canvases.push(value);
      }
    }
    return canvases;
  }

  function bumpUpdatedAt(doc: PBXDocument): void {
    const root = rootObject(doc);
    if (root) {
      root.updatedAt = new Date().toISOString();
    }
  }

  async function createCanvas(input: CreateCanvasInput): Promise<PBXDocument> {
    const title = (input.title ?? "").trim();
    if (!title) {
      throw new Error("createCanvas: title must not be empty");
    }
    const now = new Date().toISOString();
    const width =
      typeof input.width === "number" && input.width > 0
        ? input.width
        : DEFAULT_WIDTH;
    const height =
      typeof input.height === "number" && input.height > 0
        ? input.height
        : DEFAULT_HEIGHT;

    const doc = createDocument(ROOT_CLASS, {
      title,
      width,
      height,
      createdAt: now,
      updatedAt: now,
    });
    const root = rootObject(doc)!;
    root.layers = [];
    root.embedded = [];

    const canvasId = root.$id;
    await ctx.storage.set(canvasKey(canvasId), doc);
    await ctx.hooks.emit("paint:canvasCreated", { canvasId, title });
    return doc;
  }

  async function addLayer(input: AddLayerInput): Promise<PBXObject> {
    const { canvasId, kind } = input;
    if (!canvasId || (kind !== "raster" && kind !== "vector")) {
      throw new Error("addLayer: canvasId and kind ('raster' | 'vector') are required");
    }
    if (typeof input.data !== "string") {
      throw new Error("addLayer: data must be a string");
    }
    const doc = await requireCanvas(canvasId);

    const layerId = addObject(doc, LAYER_CLASS, {
      kind,
      data: input.data,
      visible: input.visible ?? true,
      opacity: typeof input.opacity === "number" ? input.opacity : 1,
      createdAt: new Date().toISOString(),
    });

    const root = rootObject(doc)!;
    const layers = Array.isArray(root.layers) ? (root.layers as PBXReference[]) : [];
    layers.push(linkObject(doc, layerId));
    root.layers = layers;

    bumpUpdatedAt(doc);
    await ctx.storage.set(canvasKey(canvasId), doc);
    await ctx.hooks.emit("paint:layerAdded", { canvasId, layerId });
    return doc.$objects[layerId];
  }

  async function updateLayer(input: UpdateLayerInput): Promise<PBXObject> {
    const { canvasId, layerId } = input;
    const doc = await requireCanvas(canvasId);

    const layer = doc.$objects[layerId];
    if (!layer || layer.$class !== LAYER_CLASS) {
      throw new Error(`updateLayer: layer "${layerId}" not found in canvas "${canvasId}"`);
    }

    if (typeof input.data === "string") layer.data = input.data;
    if (typeof input.visible === "boolean") layer.visible = input.visible;
    if (typeof input.opacity === "number") layer.opacity = input.opacity;
    layer.updatedAt = new Date().toISOString();

    bumpUpdatedAt(doc);
    await ctx.storage.set(canvasKey(canvasId), doc);
    await ctx.hooks.emit("paint:layerUpdated", { canvasId, layerId });
    return layer;
  }

  async function deleteLayer(input: DeleteLayerInput): Promise<PBXDocument> {
    const { canvasId, layerId } = input;
    const doc = await requireCanvas(canvasId);
    const root = rootObject(doc)!;

    const layers = Array.isArray(root.layers) ? (root.layers as PBXReference[]) : [];
    const filtered = layers.filter((ref) => ref.$ref !== layerId);
    if (filtered.length === layers.length) {
      throw new Error(`deleteLayer: layer "${layerId}" not found in canvas "${canvasId}"`);
    }
    root.layers = filtered;
    delete doc.$objects[layerId];

    bumpUpdatedAt(doc);
    await ctx.storage.set(canvasKey(canvasId), doc);
    await ctx.hooks.emit("paint:layerDeleted", { canvasId, layerId });
    return doc;
  }

  async function aiGenerateImage(input: AiGenerateImageInput): Promise<PBXObject> {
    const { canvasId, prompt, size } = input;
    if (!canvasId || typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("aiGenerateImage: canvasId and a non-empty prompt are required");
    }
    const doc = await requireCanvas(canvasId);

    // AI access goes exclusively through ctx.ai — never a raw vault key.
    const generateImage = ctx.ai.generateImage;
    if (typeof generateImage !== "function") {
      throw new Error("aiGenerateImage: image generation is not available");
    }

    let result: { url?: string; base64?: string };
    try {
      result = await generateImage({ prompt: prompt.trim(), size });
    } catch (err) {
      throw new Error(
        `aiGenerateImage: generation failed — ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      );
    }

    const data = result.base64 ?? result.url ?? "";
    if (!data) {
      throw new Error("aiGenerateImage: no image data returned");
    }

    const layerId = addObject(doc, LAYER_CLASS, {
      kind: "raster",
      data,
      dataKind: result.base64 ? "base64" : "url",
      visible: true,
      opacity: 1,
      prompt: prompt.trim(),
      generatedAt: new Date().toISOString(),
    });

    const root = rootObject(doc)!;
    const layers = Array.isArray(root.layers) ? (root.layers as PBXReference[]) : [];
    layers.push(linkObject(doc, layerId));
    root.layers = layers;

    bumpUpdatedAt(doc);
    await ctx.storage.set(canvasKey(canvasId), doc);
    await ctx.hooks.emit("paint:layerAdded", { canvasId, layerId, source: "ai" });
    return doc.$objects[layerId];
  }

  async function embedObject(input: EmbedObjectInput): Promise<PBXDocument> {
    const { canvasId, targetObjectId, targetClass } = input;
    if (!canvasId || !targetObjectId || !targetClass) {
      throw new Error("embedObject: canvasId, targetObjectId and targetClass are required");
    }

    const doc = await requireCanvas(canvasId);

    // Import the external object as a typed PBX node, then link it via OLE.
    const embedId = addObject(doc, EMBEDDED_CLASS, {
      targetClass,
      targetId: targetObjectId,
      embeddedAt: new Date().toISOString(),
    });

    const root = rootObject(doc)!;
    const embedded = Array.isArray(root.embedded) ? (root.embedded as PBXReference[]) : [];
    embedded.push(linkObject(doc, embedId));
    root.embedded = embedded;

    bumpUpdatedAt(doc);
    await ctx.storage.set(canvasKey(canvasId), doc);
    await ctx.hooks.emit("paint:objectEmbedded", {
      canvasId,
      embeddedObjectId: embedId,
    });
    return doc;
  }

  async function exportPNG(canvasId: string): Promise<ExportPNGResult> {
    const doc = await requireCanvas(canvasId);
    const root = rootObject(doc)!;
    const width = typeof root.width === "number" ? root.width : DEFAULT_WIDTH;
    const height = typeof root.height === "number" ? root.height : DEFAULT_HEIGHT;

    const layerRefs = Array.isArray(root.layers) ? (root.layers as PBXReference[]) : [];
    const visible = layerRefs
      .map((ref) => resolveRef(doc, ref))
      .filter((layer): layer is PBXObject => layer !== null && layer.visible !== false);

    // Single visible raster layer carrying base64 PNG data exports directly.
    if (visible.length === 1) {
      const only = visible[0];
      if (only.kind === "raster" && only.dataKind !== "url") {
        return {
          dataUrl: `data:image/png;base64,${String(only.data)}`,
          mime: "image/png",
          width,
          height,
        };
      }
    }

    // Otherwise flatten every visible layer (bottom → top) into a single
    // self-contained SVG. Raster layers are embedded as <image> elements,
    // vector layers inlined, opacity honoured per layer.
    const body = visible
      .map((layer, index) => {
        const opacity =
          typeof layer.opacity === "number" ? layer.opacity : 1;
        if (layer.kind === "vector") {
          return `<g opacity="${opacity}">${String(layer.data ?? "")}</g>`;
        }
        const href =
          layer.dataKind === "url"
            ? String(layer.data)
            : `data:image/png;base64,${String(layer.data)}`;
        return `<image href="${href}" width="${width}" height="${height}" opacity="${opacity}" preserveAspectRatio="xMidYMid slice"/>`;
      })
      .join("\n");

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `${body}</svg>`;

    return { dataUrl: svgDataUrl(svg), mime: "image/svg+xml", width, height };
  }

  /* ---------------- skill registration ---------------- */

  ctx.skills.register(
    "createCanvas",
    async (payload) => {
      const { title, width, height } = (payload ?? {}) as {
        title?: unknown;
        width?: unknown;
        height?: unknown;
      };
      if (typeof title !== "string") {
        throw new Error("createCanvas expects { title: string }");
      }
      return createCanvas({
        title,
        width: typeof width === "number" ? width : undefined,
        height: typeof height === "number" ? height : undefined,
      });
    },
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "listCanvases",
    async () => listCanvases(),
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "getCanvas",
    async (payload) => {
      const { canvasId } = (payload ?? {}) as { canvasId?: unknown };
      if (typeof canvasId !== "string") {
        throw new Error("getCanvas expects { canvasId: string }");
      }
      return getCanvas(canvasId);
    },
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "addLayer",
    async (payload) => {
      const { canvasId, kind, data, visible, opacity } = (payload ?? {}) as {
        canvasId?: unknown;
        kind?: unknown;
        data?: unknown;
        visible?: unknown;
        opacity?: unknown;
      };
      if (typeof canvasId !== "string" || typeof data !== "string") {
        throw new Error("addLayer expects { canvasId: string, data: string }");
      }
      if (kind !== "raster" && kind !== "vector") {
        throw new Error("addLayer expects kind 'raster' or 'vector'");
      }
      return addLayer({
        canvasId,
        kind,
        data,
        visible: typeof visible === "boolean" ? visible : undefined,
        opacity: typeof opacity === "number" ? opacity : undefined,
      });
    },
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "updateLayer",
    async (payload) => {
      const { canvasId, layerId, data, visible, opacity } = (payload ?? {}) as {
        canvasId?: unknown;
        layerId?: unknown;
        data?: unknown;
        visible?: unknown;
        opacity?: unknown;
      };
      if (typeof canvasId !== "string" || typeof layerId !== "string") {
        throw new Error("updateLayer expects { canvasId: string, layerId: string }");
      }
      return updateLayer({
        canvasId,
        layerId,
        data: typeof data === "string" ? data : undefined,
        visible: typeof visible === "boolean" ? visible : undefined,
        opacity: typeof opacity === "number" ? opacity : undefined,
      });
    },
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "deleteLayer",
    async (payload) => {
      const { canvasId, layerId } = (payload ?? {}) as {
        canvasId?: unknown;
        layerId?: unknown;
      };
      if (typeof canvasId !== "string" || typeof layerId !== "string") {
        throw new Error("deleteLayer expects { canvasId: string, layerId: string }");
      }
      return deleteLayer({ canvasId, layerId });
    },
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "aiGenerateImage",
    async (payload) => {
      const { canvasId, prompt, size } = (payload ?? {}) as {
        canvasId?: unknown;
        prompt?: unknown;
        size?: unknown;
      };
      if (typeof canvasId !== "string" || typeof prompt !== "string") {
        throw new Error("aiGenerateImage expects { canvasId: string, prompt: string }");
      }
      return aiGenerateImage({
        canvasId,
        prompt,
        size: size === "256x256" || size === "512x512" || size === "1024x1024" ? size : undefined,
      });
    },
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "embedObject",
    async (payload) => {
      const { canvasId, targetObjectId, targetClass } = (payload ?? {}) as {
        canvasId?: unknown;
        targetObjectId?: unknown;
        targetClass?: unknown;
      };
      if (
        typeof canvasId !== "string" ||
        typeof targetObjectId !== "string" ||
        typeof targetClass !== "string"
      ) {
        throw new Error(
          "embedObject expects { canvasId: string, targetObjectId: string, targetClass: string }",
        );
      }
      return embedObject({ canvasId, targetObjectId, targetClass });
    },
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "exportPNG",
    async (payload) => {
      const { canvasId } = (payload ?? {}) as { canvasId?: unknown };
      if (typeof canvasId !== "string") {
        throw new Error("exportPNG expects { canvasId: string }");
      }
      return exportPNG(canvasId);
    },
    { localOnly: true, httpExposed: true },
  );

  return {
    createCanvas,
    getCanvas,
    listCanvases,
    addLayer,
    updateLayer,
    deleteLayer,
    aiGenerateImage,
    embedObject,
    exportPNG,
  };
}
