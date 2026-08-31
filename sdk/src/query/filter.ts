/**
 * Shared structured filter DSL — extracted from the `smartbase` plugin so a
 * second consumer (the PAL workflow engine) evaluates `where:` conditions with
 * the *exact same* evaluator, never a new parser (CLAUDE.md / Brief 5: "0%
 * nieuwe parser code").
 *
 * The shape is a MongoDB-flavoured `{ op, value }` filter per field, keyed by
 * field name: `{ amount: { op: "gt", value: 100 } }`. There is deliberately no
 * SQL/text parsing and no `eval`/`new Function` — a filter value is always
 * compared literally, never interpreted. A record matches only when *every*
 * field filter holds (AND semantics).
 */

import {
  isPlainObject,
  validateKeyCount,
  validateObjectDepth,
} from "../boundary-guard";

export type FieldValue = string | number | boolean;

export type FieldFilter =
  | { op: "eq" | "neq"; value: string | number | boolean }
  | { op: "gt" | "gte" | "lt" | "lte"; value: number }
  | { op: "contains"; value: string };

/** AND of all field filters: a record matches only if every filter holds. */
export type QueryFilter = Record<string, FieldFilter>;

export type FilterOp = FieldFilter["op"];

/** Every operator the DSL accepts. A filter with any other `op` is rejected. */
export const FILTER_OPS: ReadonlySet<FilterOp> = new Set<FilterOp>([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
]);

/**
 * Normalize (and type-check) a single field filter. Throws on an unknown op or
 * a value whose type the op cannot compare — fail-closed: a malformed filter
 * is rejected loudly, never partially evaluated.
 */
function normalizeFieldFilter(
  field: string,
  ff: Record<string, unknown>,
): FieldFilter {
  const rawOp = ff.op;
  if (typeof rawOp !== "string" || !FILTER_OPS.has(rawOp as FilterOp)) {
    throw new Error(`filter field "${field}" has invalid op ${JSON.stringify(rawOp)}`);
  }
  const op = rawOp as FilterOp;
  const value = ff.value;
  if (op === "eq" || op === "neq") {
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new Error(
        `filter field "${field}" op "${op}" requires a string, number or boolean value`,
      );
    }
    return { op, value };
  }
  if (op === "contains") {
    if (typeof value !== "string") {
      throw new Error(`filter field "${field}" op "contains" requires a string value`);
    }
    return { op, value };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`filter field "${field}" op "${op}" requires a number value`);
  }
  return { op, value };
}

/**
 * Validate and normalize an untrusted filter. `undefined`/`null` read as an
 * empty filter (matches everything). Depth and key-count are bounded via the
 * shared boundary-guard primitives, so a pathological deep filter cannot
 * blow the stack downstream.
 */
export function validateFilter(filter: unknown): QueryFilter {
  if (filter === undefined || filter === null) {
    return {};
  }
  if (!isPlainObject(filter)) {
    throw new Error("filter must be an object");
  }
  validateObjectDepth(filter);
  validateKeyCount(filter);
  const out: QueryFilter = {};
  for (const [field, ff] of Object.entries(filter)) {
    if (!isPlainObject(ff)) {
      throw new Error(`filter field "${field}" must be an object`);
    }
    out[field] = normalizeFieldFilter(field, ff);
  }
  return out;
}

/** Whether a single record value satisfies one field filter. */
export function matchesFieldFilter(
  recordValue: FieldValue,
  ff: FieldFilter,
): boolean {
  switch (ff.op) {
    case "eq":
      return recordValue === ff.value;
    case "neq":
      return recordValue !== ff.value;
    case "gt":
      return typeof recordValue === "number" && recordValue > ff.value;
    case "gte":
      return typeof recordValue === "number" && recordValue >= ff.value;
    case "lt":
      return typeof recordValue === "number" && recordValue < ff.value;
    case "lte":
      return typeof recordValue === "number" && recordValue <= ff.value;
    case "contains":
      if (typeof recordValue !== "string") {
        return false;
      }
      return recordValue.toLowerCase().includes(ff.value.toLowerCase());
  }
}

/**
 * Whether a flat field map satisfies an AND-of-field-filters query. A filter
 * field that is absent from the record, or a type mismatch on a compared
 * field, is a non-match (fail-closed — never "empty matches everything").
 */
export function matchesRecord(
  fields: Record<string, FieldValue>,
  filter: QueryFilter,
): boolean {
  for (const [field, ff] of Object.entries(filter)) {
    if (!(field in fields)) {
      return false;
    }
    if (!matchesFieldFilter(fields[field], ff)) {
      return false;
    }
  }
  return true;
}
