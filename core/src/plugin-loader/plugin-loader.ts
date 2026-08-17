import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginManifest } from "@p2p-hub/sdk";
import type { StorageManager } from "../storage/storage-manager";
import type { PluginContext } from "./plugin-context";

/**
 * Read and validate `manifest.json` from a plugin directory.
 */
export async function loadManifest(pluginDir: string): Promise<PluginManifest> {
  const manifestPath = path.join(pluginDir, "manifest.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read plugin manifest at ${manifestPath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid plugin manifest at ${manifestPath}: not valid JSON`);
  }

  validateManifest(parsed, manifestPath);
  return parsed;
}

function validateManifest(
  value: unknown,
  manifestPath: string,
): asserts value is PluginManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid plugin manifest at ${manifestPath}: expected an object`);
  }
  const manifest = value as Record<string, unknown>;

  if (typeof manifest.id !== "string" || manifest.id.length === 0) {
    throw new Error(`invalid plugin manifest at ${manifestPath}: missing or empty "id"`);
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(
      `invalid plugin manifest at ${manifestPath}: missing or empty "version"`,
    );
  }
  if (
    manifest.kind !== "network-provider" &&
    manifest.kind !== "storage-plugin" &&
    manifest.kind !== "generic"
  ) {
    throw new Error(
      `invalid plugin manifest at ${manifestPath}: "kind" must be one of ` +
        `"network-provider", "storage-plugin", "generic"`,
    );
  }
  if (
    !Array.isArray(manifest.permissions) ||
    !manifest.permissions.every((p) => typeof p === "string")
  ) {
    throw new Error(
      `invalid plugin manifest at ${manifestPath}: "permissions" must be an array of strings`,
    );
  }
  if (typeof manifest.entry !== "string" || manifest.entry.length === 0) {
    throw new Error(
      `invalid plugin manifest at ${manifestPath}: missing or empty "entry"`,
    );
  }
}

/**
 * Load a plugin: read its manifest, build a permission-checking
 * {@link PluginContext}, import its entry module and call the default export
 * as `activate(ctx)`. Returns whatever `activate` returns.
 */
export async function loadPlugin(
  pluginDir: string,
  storageManager: StorageManager,
): Promise<unknown> {
  const manifest = await loadManifest(pluginDir);
  const own = storageManager.getOrCreate(manifest.id);

  const context: PluginContext = {
    storage: {
      get: (key) => own.get(key),
      set: (key, value) => own.set(key, value),
      delete: (key) => own.delete(key),
      list: (prefix) => own.list(prefix),
    },
    readStorageOf: (otherPluginId) => {
      if (!manifest.permissions.includes(`storage:read:${otherPluginId}`)) {
        return null;
      }
      const other = storageManager.getOrCreate(otherPluginId);
      return {
        get: (key) => other.get(key),
        list: (prefix) => other.list(prefix),
      };
    },
  };

  const entryPath = path.resolve(pluginDir, manifest.entry);
  const module = await importEntry(pathToFileURL(entryPath).href);
  const activate = resolveActivate(module);

  if (typeof activate !== "function") {
    throw new Error(
      `plugin "${manifest.id}" does not export a default activate function`,
    );
  }
  return (activate as (ctx: PluginContext) => unknown)(context);
}

// tsc transpiles `import()` to `require()` under `module: commonjs`, which
// cannot load ESM entry points (or file:// URLs). Route the load through a
// `new Function` wrapper so the dynamic import survives as a genuine import().
const importEntry = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<Record<string, unknown>>;

function resolveActivate(module: Record<string, unknown>): unknown {
  let candidate: unknown = module.default ?? module;
  // tsc compiles `export default function activate` to CommonJS
  // `exports.default = activate`, which dynamic import() surfaces as
  // `{ default: { default: activate } }`. Unwrap that extra level.
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as Record<string, unknown>).default === "function"
  ) {
    candidate = (candidate as Record<string, unknown>).default;
  }
  return candidate;
}
