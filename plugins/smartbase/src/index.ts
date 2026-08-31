import type { PluginContext } from "@p2p-hub/core";
import {
  MAX_KEY_COUNT,
  addObject,
  createDocument,
  isPBXDocument,
  isPlainObject,
  linkObject,
  matchesRecord,
  resolveRef,
  rootObject,
  validateFilter,
  validateKeyCount,
  validateObjectDepth,
  type FieldValue,
  type PBXDocument,
  type PBXObject,
  type PBXReference,
  type QueryFilter,
} from "@p2p-hub/sdk";

/**
 * SmartBase — an Airtable-like structured-data plugin on the PBX/OLE standard.
 *
 * A database is a `P2P.Database` document whose root links `P2P.Table` children
 * (each with a typed `schema`), and each table links `P2P.Record` children whose
 * `fields` are validated against the table schema on every insert/update.
 *
 * The only way to read data is `smartbase.query`, which evaluates a
 * **structured** JSON filter object (a MongoDB-flavoured `{ op, value }` shape).
 * There is deliberately no SQL/text parsing and no `eval`/`new Function` here:
 * a filter value is always compared literally, never interpreted. Query is a
 * full linear scan over a table's records (fine for now; see the note in the
 * handoff about the non-optimized large-table path).
 *
 * Every skill is `localOnly` — nothing is reachable over the network or the
 * HTTP bridge. This plugin reads/writes only its own `ctx.storage`.
 */

export type FieldType = "string" | "number" | "boolean" | "date";

export interface SchemaField {
  name: string;
  type: FieldType;
}

export interface TableSchema {
  fields: SchemaField[];
  /**
   * Opt-in (deny-by-default): when `true`, record mutations on this table emit
   * local domain events (`<sanitizedTableName>:created|updated|deleted`) onto
   * the host's local event bus. Default `false` — a table must explicitly
   * claim "my mutation events may go on the bus", mirroring how a plugin
   * declares `exposedEvents` for remote topics. A next plugin that subscribes
   * to the bus never silently inherits access to this table's data.
   */
  emitEvents?: boolean;
}

export interface CreateDatabaseInput {
  title: string;
}

export interface CreateTableInput {
  databaseId: string;
  name: string;
  schema: TableSchema;
}

export interface InsertRecordInput {
  databaseId: string;
  tableId: string;
  fields: Record<string, unknown>;
}

export interface UpdateRecordInput {
  databaseId: string;
  tableId: string;
  recordId: string;
  fields: Record<string, unknown>;
}

export interface DeleteRecordInput {
  databaseId: string;
  tableId: string;
  recordId: string;
}

export interface QueryInput {
  databaseId: string;
  tableId: string;
  filter?: QueryFilter;
  limit?: number;
}

export interface CreateDatabaseResult {
  databaseId: string;
  title: string;
}

export interface CreateTableResult {
  tableId: string;
  name: string;
  schema: TableSchema;
}

export interface RecordView {
  recordId: string;
  fields: Record<string, FieldValue>;
}

export interface QueryResult {
  records: RecordView[];
  /** True when more records matched than `limit` allowed to be returned. */
  truncated: boolean;
}

export interface ListTableResult {
  tableId: string;
  name: string;
  schema: TableSchema;
}

export interface SmartbasePlugin {
  createDatabase(input: CreateDatabaseInput): Promise<CreateDatabaseResult>;
  createTable(input: CreateTableInput): Promise<CreateTableResult>;
  insertRecord(input: InsertRecordInput): Promise<RecordView>;
  updateRecord(input: UpdateRecordInput): Promise<RecordView>;
  deleteRecord(input: DeleteRecordInput): Promise<{ recordId: string; deleted: boolean }>;
  query(input: QueryInput): Promise<QueryResult>;
  listTables(databaseId: string): Promise<ListTableResult[]>;
  getSchema(databaseId: string, tableId: string): Promise<TableSchema | null>;
}

const DATABASE_CLASS = "P2P.Database";
const TABLE_CLASS = "P2P.Table";
const RECORD_CLASS = "P2P.Record";
const DB_KEY_PREFIX = "db:";

/** Effective `limit` when the caller omits one or passes a non-number. */
export const DEFAULT_QUERY_LIMIT = 100;
/** Hard ceiling on `limit` — an accidental `limit: 1000000` returns this many. */
export const MAX_QUERY_LIMIT = 500;

const FIELD_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean", "date"]);

function dbKey(databaseId: string): string {
  return `${DB_KEY_PREFIX}${databaseId}`;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export default function activate(ctx: PluginContext): SmartbasePlugin {
  async function getDatabase(databaseId: string): Promise<PBXDocument | null> {
    const value = await ctx.storage.get(dbKey(databaseId));
    if (!isPBXDocument(value)) {
      return null;
    }
    const root = rootObject(value);
    if (!root || root.$class !== DATABASE_CLASS) {
      return null;
    }
    return value;
  }

  async function saveDatabase(databaseId: string, doc: PBXDocument): Promise<void> {
    const root = rootObject(doc);
    if (root) {
      root.updatedAt = new Date().toISOString();
    }
    await ctx.storage.set(dbKey(databaseId), doc);
  }

  function tableRefs(doc: PBXDocument): PBXReference[] {
    const refs = rootObject(doc)?.tables;
    return Array.isArray(refs) ? (refs as PBXReference[]) : [];
  }

  function findTable(doc: PBXDocument, tableId: string): PBXObject | null {
    for (const ref of tableRefs(doc)) {
      const obj = resolveRef(doc, ref);
      if (obj && obj.$id === tableId) {
        return obj;
      }
    }
    return null;
  }

  function recordRefs(table: PBXObject): PBXReference[] {
    const refs = table.records;
    return Array.isArray(refs) ? (refs as PBXReference[]) : [];
  }

  function listRecordObjects(doc: PBXDocument, table: PBXObject): PBXObject[] {
    const out: PBXObject[] = [];
    for (const ref of recordRefs(table)) {
      const obj = resolveRef(doc, ref);
      if (obj) {
        out.push(obj);
      }
    }
    return out;
  }

  function findRecord(doc: PBXDocument, table: PBXObject, recordId: string): PBXObject | null {
    for (const ref of recordRefs(table)) {
      const obj = resolveRef(doc, ref);
      if (obj && obj.$id === recordId) {
        return obj;
      }
    }
    return null;
  }

  /**
   * Validate a table schema: `fields` must be an array of `{ name, type }` with
   * a known type and no duplicate names. Returns a normalized copy.
   */
  function validateSchema(schema: unknown): TableSchema {
    if (!isPlainObject(schema) || !Array.isArray(schema.fields)) {
      throw new Error("schema must be { fields: Array<{ name, type }> }");
    }
    const fields = schema.fields;
    if (fields.length > MAX_KEY_COUNT) {
      throw new Error(`schema may define at most ${MAX_KEY_COUNT} fields`);
    }
    const seen = new Set<string>();
    const out: SchemaField[] = [];
    for (const raw of fields) {
      if (!isPlainObject(raw)) {
        throw new Error("each schema field must be an object");
      }
      const name = requireString(raw.name, "schema field name").trim();
      if (!name) {
        throw new Error("schema field name must be a non-empty string");
      }
      if (seen.has(name)) {
        throw new Error(`schema has duplicate field "${name}"`);
      }
      seen.add(name);
      const type = raw.type;
      if (typeof type !== "string" || !FIELD_TYPES.has(type)) {
        throw new Error(`schema field "${name}" has invalid type "${String(type)}"`);
      }
      out.push({ name, type: type as FieldType });
    }
    const emitEvents = (schema as { emitEvents?: unknown }).emitEvents;
    if (emitEvents !== undefined && typeof emitEvents !== "boolean") {
      throw new Error("schema.emitEvents must be a boolean when present");
    }
    return { fields: out, ...(emitEvents === true ? { emitEvents: true } : {}) };
  }

  /** Read a stored table's schema back, re-validating defensively. */
  function schemaOf(table: PBXObject): TableSchema {
    const raw = table.schema;
    if (!isPlainObject(raw) || !Array.isArray(raw.fields)) {
      return { fields: [] };
    }
    const out: SchemaField[] = [];
    for (const f of raw.fields) {
      if (
        isPlainObject(f) &&
        typeof f.name === "string" &&
        typeof f.type === "string" &&
        FIELD_TYPES.has(f.type)
      ) {
        out.push({ name: f.name, type: f.type as FieldType });
      }
    }
    return {
      fields: out,
      ...(raw.emitEvents === true ? { emitEvents: true } : {}),
    };
  }

  function checkValue(name: string, type: FieldType, value: unknown): FieldValue {
    switch (type) {
      case "string":
        if (typeof value !== "string") {
          throw new Error(`field "${name}" must be a string`);
        }
        return value;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`field "${name}" must be a number`);
        }
        return value;
      case "boolean":
        if (typeof value !== "boolean") {
          throw new Error(`field "${name}" must be a boolean`);
        }
        return value;
      case "date":
        if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
          throw new Error(`field "${name}" must be an ISO 8601 date string`);
        }
        return value;
    }
  }

  /**
   * Validate a record `fields` patch against the table schema: every key must
   * be a known field and every value must match its declared type. Unknown keys
   * are rejected — there is no free-form write path outside the schema.
   * Reuses the SDK boundary-guard key-count/depth checks on this externally
   * shaped data.
   */
  function validateFields(fields: unknown, schema: TableSchema): Record<string, FieldValue> {
    if (!isPlainObject(fields)) {
      throw new Error("fields must be an object");
    }
    validateObjectDepth(fields);
    validateKeyCount(fields);
    const byName = new Map(schema.fields.map((f) => [f.name, f.type]));
    const out: Record<string, FieldValue> = {};
    for (const [name, value] of Object.entries(fields)) {
      const type = byName.get(name);
      if (!type) {
        throw new Error(`unknown field "${name}"`);
      }
      out[name] = checkValue(name, type, value);
    }
    return out;
  }

  function resolveLimit(limit: unknown): number {
    if (typeof limit === "number" && Number.isFinite(limit) && limit >= 1) {
      return Math.min(Math.floor(limit), MAX_QUERY_LIMIT);
    }
    return DEFAULT_QUERY_LIMIT;
  }

  function recordFields(rec: PBXObject): Record<string, FieldValue> {
    const f = rec.fields;
    if (!isPlainObject(f)) {
      return {};
    }
    const out: Record<string, FieldValue> = {};
    for (const [key, value] of Object.entries(f)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        out[key] = value;
      }
    }
    return out;
  }

  async function loadTable(
    databaseId: string,
    tableId: string,
    op: string,
  ): Promise<{ doc: PBXDocument; table: PBXObject; schema: TableSchema }> {
    const doc = await getDatabase(databaseId);
    if (!doc) {
      throw new Error(`${op}: database "${databaseId}" not found`);
    }
    const table = findTable(doc, tableId);
    if (!table) {
      throw new Error(`${op}: table "${tableId}" not found`);
    }
    return { doc, table, schema: schemaOf(table) };
  }

  async function createDatabase(input: CreateDatabaseInput): Promise<CreateDatabaseResult> {
    const title = ((input as CreateDatabaseInput | null)?.title ?? "").trim();
    if (!title) {
      throw new Error("createDatabase: title must be a non-empty string");
    }
    const now = new Date().toISOString();
    const doc = createDocument(DATABASE_CLASS, {
      title,
      createdAt: now,
      updatedAt: now,
      tables: [],
    });
    const root = rootObject(doc)!;
    await ctx.storage.set(dbKey(root.$id), doc);
    return { databaseId: root.$id, title };
  }

  async function createTable(input: CreateTableInput): Promise<CreateTableResult> {
    const databaseId = requireString(
      (input as CreateTableInput | null)?.databaseId,
      "createTable: databaseId",
    );
    const name = ((input as CreateTableInput | null)?.name ?? "").trim();
    if (!name) {
      throw new Error("createTable: name must be a non-empty string");
    }
    const schema = validateSchema((input as CreateTableInput | null)?.schema);

    const doc = await getDatabase(databaseId);
    if (!doc) {
      throw new Error(`createTable: database "${databaseId}" not found`);
    }

    const tableId = addObject(doc, TABLE_CLASS, { name, schema, records: [] });
    const refs = tableRefs(doc);
    refs.push(linkObject(doc, tableId));
    const root = rootObject(doc);
    if (root) {
      root.tables = refs;
    }

    await saveDatabase(databaseId, doc);
    return { tableId, name, schema };
  }

  /**
   * Sanitize a table name into a single topic segment for the local domain
   * event bus (Brief 6). The bus topic grammar is `segment[:segment]{1,3}`
   * with segments of `[A-Za-z0-9_][A-Za-z0-9_.-]*`; a table name is caller
   * data, so every character outside that alphabet is mapped to `_` and a
   * leading `.`/`-` is normalized to a leading `_`. This is what stops a
   * hostile name from smuggling a `:` delimiter or a `*` wildcard into the
   * topic (CLAUDE.md principle #2). Returns `null` when nothing usable remains
   * (an all-empty name), in which case no event is emitted — a storage
   * mutation never fails because of an un-publishable event.
   */
  function tableEventSegment(table: PBXObject): string | null {
    const raw = typeof table.name === "string" ? table.name : "";
    const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, "_");
    if (cleaned.length === 0) {
      return null;
    }
    return /^[A-Za-z0-9_]/.test(cleaned) ? cleaned : `_${cleaned}`;
  }

  /**
   * Emit a local domain event after a successful record mutation — but only
   * for a table that explicitly opted in via `schema.emitEvents` (deny-by-
   * default, like `exposedEvents`). The topic is
   * `<sanitizedTableName>:<event>` (`invoice:created`, `invoice:updated`,
   * `invoice:deleted`) — the canonical `:`-delimited form the local bus and the
   * PAL engine subscribe to. The payload mirrors the returned view and carries
   * no object references, only scalars/plain data, so it is acyclic and
   * JSON-serializable by construction. A failed publish (no wired bus, a
   * revoked `events:publish` permission, a malformed topic) is caught and
   * logged: the record is already durably written, and a side-channel event
   * must never roll a mutation back.
   */
  async function emitTableEvent(
    table: PBXObject,
    event: "created" | "updated" | "deleted",
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!schemaOf(table).emitEvents) {
      return;
    }
    const segment = tableEventSegment(table);
    if (!segment) {
      return;
    }
    try {
      await ctx.localEvents.publish(`${segment}:${event}`, payload);
    } catch (err) {
      console.warn(
        `[smartbase] could not publish local event ${segment}:${event}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function insertRecord(input: InsertRecordInput): Promise<RecordView> {    const databaseId = requireString(
      (input as InsertRecordInput | null)?.databaseId,
      "insertRecord: databaseId",
    );
    const tableId = requireString(
      (input as InsertRecordInput | null)?.tableId,
      "insertRecord: tableId",
    );
    const { doc, table, schema } = await loadTable(databaseId, tableId, "insertRecord");
    const fields = validateFields((input as InsertRecordInput | null)?.fields, schema);

    const recordId = addObject(doc, RECORD_CLASS, { fields });
    const refs = recordRefs(table);
    refs.push(linkObject(doc, recordId));
    table.records = refs;

    await saveDatabase(databaseId, doc);
    await emitTableEvent(table, "created", {
      databaseId,
      tableId,
      recordId,
      fields,
    });
    return { recordId, fields };
  }

  async function updateRecord(input: UpdateRecordInput): Promise<RecordView> {
    const databaseId = requireString(
      (input as UpdateRecordInput | null)?.databaseId,
      "updateRecord: databaseId",
    );
    const tableId = requireString(
      (input as UpdateRecordInput | null)?.tableId,
      "updateRecord: tableId",
    );
    const recordId = requireString(
      (input as UpdateRecordInput | null)?.recordId,
      "updateRecord: recordId",
    );
    const { doc, table, schema } = await loadTable(databaseId, tableId, "updateRecord");
    const record = findRecord(doc, table, recordId);
    if (!record) {
      throw new Error(`updateRecord: record "${recordId}" not found`);
    }

    const patch = validateFields((input as UpdateRecordInput | null)?.fields, schema);
    const merged: Record<string, FieldValue> = { ...recordFields(record), ...patch };
    record.fields = merged;

    await saveDatabase(databaseId, doc);
    await emitTableEvent(table, "updated", {
      databaseId,
      tableId,
      recordId,
      fields: merged,
    });
    return { recordId, fields: merged };
  }

  async function deleteRecord(
    input: DeleteRecordInput,
  ): Promise<{ recordId: string; deleted: boolean }> {
    const databaseId = requireString(
      (input as DeleteRecordInput | null)?.databaseId,
      "deleteRecord: databaseId",
    );
    const tableId = requireString(
      (input as DeleteRecordInput | null)?.tableId,
      "deleteRecord: tableId",
    );
    const recordId = requireString(
      (input as DeleteRecordInput | null)?.recordId,
      "deleteRecord: recordId",
    );
    const { doc, table } = await loadTable(databaseId, tableId, "deleteRecord");

    const refs = recordRefs(table);
    const index = refs.findIndex((ref) => ref.$ref === recordId);
    if (index === -1) {
      throw new Error(`deleteRecord: record "${recordId}" not found`);
    }
    refs.splice(index, 1);
    table.records = refs;
    delete doc.$objects[recordId];

    await saveDatabase(databaseId, doc);
    await emitTableEvent(table, "deleted", {
      databaseId,
      tableId,
      recordId,
    });
    return { recordId, deleted: true };
  }

  async function query(input: QueryInput): Promise<QueryResult> {
    const databaseId = requireString(
      (input as QueryInput | null)?.databaseId,
      "query: databaseId",
    );
    const tableId = requireString((input as QueryInput | null)?.tableId, "query: tableId");
    const filter = validateFilter((input as QueryInput | null)?.filter);
    const limit = resolveLimit((input as QueryInput | null)?.limit);

    const { doc, table } = await loadTable(databaseId, tableId, "query");

    const records: RecordView[] = [];
    let truncated = false;
    for (const record of listRecordObjects(doc, table)) {
      const fields = recordFields(record);
      if (!matchesRecord(fields, filter)) {
        continue;
      }
      if (records.length < limit) {
        records.push({ recordId: record.$id, fields });
      } else {
        truncated = true;
      }
    }

    return { records, truncated };
  }

  async function listTables(databaseId: string): Promise<ListTableResult[]> {
    const doc = await getDatabase(databaseId);
    if (!doc) {
      return [];
    }
    const out: ListTableResult[] = [];
    for (const ref of tableRefs(doc)) {
      const table = resolveRef(doc, ref);
      if (table) {
        out.push({
          tableId: table.$id,
          name: typeof table.name === "string" ? table.name : "",
          schema: schemaOf(table),
        });
      }
    }
    return out;
  }

  async function getSchema(databaseId: string, tableId: string): Promise<TableSchema | null> {
    const doc = await getDatabase(databaseId);
    if (!doc) {
      return null;
    }
    const table = findTable(doc, tableId);
    return table ? schemaOf(table) : null;
  }

  ctx.skills.register(
    "createDatabase",
    async (payload) => createDatabase(payload as CreateDatabaseInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "createTable",
    async (payload) => createTable(payload as CreateTableInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "insertRecord",
    async (payload) => insertRecord(payload as InsertRecordInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "updateRecord",
    async (payload) => updateRecord(payload as UpdateRecordInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "deleteRecord",
    async (payload) => deleteRecord(payload as DeleteRecordInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "query",
    async (payload) => query(payload as QueryInput),
    { localOnly: true },
  );

  ctx.skills.register(
    "listTables",
    async (payload) => {
      const { databaseId } = (payload ?? {}) as { databaseId?: unknown };
      if (typeof databaseId !== "string") {
        throw new Error("listTables expects { databaseId: string }");
      }
      return listTables(databaseId);
    },
    { localOnly: true },
  );

  ctx.skills.register(
    "getSchema",
    async (payload) => {
      const { databaseId, tableId } = (payload ?? {}) as {
        databaseId?: unknown;
        tableId?: unknown;
      };
      if (typeof databaseId !== "string" || typeof tableId !== "string") {
        throw new Error("getSchema expects { databaseId: string, tableId: string }");
      }
      return getSchema(databaseId, tableId);
    },
    { localOnly: true },
  );

  return {
    createDatabase,
    createTable,
    insertRecord,
    updateRecord,
    deleteRecord,
    query,
    listTables,
    getSchema,
  };
}
