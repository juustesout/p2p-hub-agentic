/**
 * PBX object-graph document engine.
 *
 * A lightweight, TypeScript-native implementation of the PBX document format
 * (inspired by https://github.com/juustesout/pbx): every document is a flat,
 * UUID-indexed dictionary of typed objects (`$objects`) plus a single entry
 * point (`$top.root`). Objects reference each other through `{ $ref: id }`
 * pointers, which is what enables Object Linking & Embedding (OLE) across the
 * P2P ecosystem — a note can embed a canvas image, a sheet cell can embed a
 * note, and so on, without any plugin inventing its own object model.
 */

/**
 * A single typed object in the graph. `$id` and `$class` are reserved; all
 * remaining keys are free-form properties (or embedded `{ $ref }` links).
 */
export interface PBXObject {
  /** UUID v4. */
  $id: string;
  /** Fully-qualified class, e.g. `"P2P.SmartNote"`, `"P2P.TextBlock"`. */
  $class: string;
  /** Optional schema/format version of this object's class. */
  $version?: string;
  [key: string]: unknown;
}

/**
 * An OLE pointer to another object in `$objects`.
 */
export interface PBXReference {
  $ref: string;
}

/**
 * The root of a PBX document. Per the PBX standard there are exactly two
 * top-level fields: `$top` (the entry point) and `$objects` (the graph).
 */
export interface PBXDocument {
  $top: {
    root: PBXReference;
  };
  $objects: Record<string, PBXObject>;
}

/** Reserved structural keys that callers may not set via `data`. */
const RESERVED_KEYS = new Set(["$id", "$class", "$version"]);

function stripReserved(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!data) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!RESERVED_KEYS.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Generate a random UUID v4. Uses `crypto.randomUUID` when available (Node 19+
 * and browsers), falling back to an RFC 4122 implementation built on
 * `Math.random`.
 */
export function uuidV4(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (globalCrypto?.randomUUID) {
    return globalCrypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Type guard for `{ $ref: string }` pointers. */
export function isPBXReference(value: unknown): value is PBXReference {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).$ref === "string"
  );
}

/** Type guard for PBX objects (must carry string `$id` and `$class`). */
export function isPBXObject(value: unknown): value is PBXObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.$id === "string" && typeof obj.$class === "string";
}

/** Type guard for a well-formed PBX document. */
export function isPBXDocument(value: unknown): value is PBXDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const doc = value as Record<string, unknown>;
  const top = doc.$top;
  const objects = doc.$objects;
  if (typeof top !== "object" || top === null || Array.isArray(top)) {
    return false;
  }
  const root = (top as Record<string, unknown>).root;
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    return false;
  }
  if (typeof (root as Record<string, unknown>).$ref !== "string") {
    return false;
  }
  return (
    typeof objects === "object" &&
    objects !== null &&
    !Array.isArray(objects)
  );
}

/**
 * Create a new document whose root object has the given class. `rootData`
 * becomes the root's properties (reserved structural keys are ignored).
 */
export function createDocument(
  rootClass: string,
  rootData?: Record<string, unknown>,
): PBXDocument {
  const rootId = uuidV4();
  const root: PBXObject = {
    $id: rootId,
    $class: rootClass,
    ...stripReserved(rootData),
  };
  return {
    $top: { root: { $ref: rootId } },
    $objects: { [rootId]: root },
  };
}

/**
 * Add an object of the given class to `doc.$objects` and return its new UUID.
 */
export function addObject(
  doc: PBXDocument,
  pbxClass: string,
  data: Record<string, unknown> = {},
): string {
  const id = uuidV4();
  doc.$objects[id] = { $id: id, $class: pbxClass, ...stripReserved(data) };
  return id;
}

/**
 * Create an OLE `{ $ref }` pointer to `targetId`. The target need not exist in
 * this document yet — embedding an object that lives in another plugin's graph
 * is a supported pattern (resolveRef will simply return `null` until it is
 * present).
 */
export function linkObject(doc: PBXDocument, targetId: string): PBXReference {
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new Error("linkObject expects a non-empty target UUID");
  }
  return { $ref: targetId };
}

/**
 * Resolve an OLE pointer to its object. Returns `null` for a missing or
 * dangling reference rather than throwing.
 */
export function resolveRef(
  doc: PBXDocument,
  ref: PBXReference | null | undefined,
): PBXObject | null {
  if (!isPBXReference(ref)) {
    return null;
  }
  return doc.$objects[ref.$ref] ?? null;
}

/** Resolve the root object of a document (never null for a valid document). */
export function rootObject(doc: PBXDocument): PBXObject | null {
  return resolveRef(doc, doc.$top.root);
}

/** Serialize a document to a valid PBX/JSON string. */
export function serialize(doc: PBXDocument): string {
  return JSON.stringify(doc, null, 2);
}

/** Deserialize a PBX/JSON string, validating the resulting document. */
export function deserialize(raw: string): PBXDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("deserialize: input is not valid JSON");
  }
  if (!isPBXDocument(parsed)) {
    throw new Error("deserialize: input is not a valid PBX document");
  }
  return parsed;
}

/**
 * Convenience helper bundling the PBX document operations. Methods are pure
 * and stateless; the standalone functions above are the canonical
 * implementation.
 */
export class PBXBuilder {
  createDocument(
    rootClass: string,
    rootData?: Record<string, unknown>,
  ): PBXDocument {
    return createDocument(rootClass, rootData);
  }

  addObject(
    doc: PBXDocument,
    pbxClass: string,
    data?: Record<string, unknown>,
  ): string {
    return addObject(doc, pbxClass, data);
  }

  linkObject(doc: PBXDocument, targetId: string): PBXReference {
    return linkObject(doc, targetId);
  }

  resolveRef(
    doc: PBXDocument,
    ref: PBXReference | null | undefined,
  ): PBXObject | null {
    return resolveRef(doc, ref);
  }

  serialize(doc: PBXDocument): string {
    return serialize(doc);
  }

  deserialize(raw: string): PBXDocument {
    return deserialize(raw);
  }
}
