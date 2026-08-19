import * as path from "node:path";
import {
  atomicWriteFile,
  readJsonFile,
  StorageCorruptionError,
} from "./atomic-write";
import { sharedWriteQueue } from "./queue";

/**
 * A key-value store isolated to a single plugin. All data for a plugin is
 * backed by one JSON file on disk: `<dataDir>/<pluginId>.json`.
 *
 * Keys are plain strings stored as JSON object keys — they are never used to
 * build filesystem paths, so a key like `"../other-plugin/secret"` stays a
 * literal key inside this plugin's own file.
 *
 * Reads go through {@link readJsonFile}: a missing file is an empty store
 * (first run), but a file that exists and cannot be parsed throws
 * {@link StorageCorruptionError} — it is never silently treated as empty.
 * Every read-modify-write cycle is serialized per file path by the shared
 * write queue, so concurrent `set`/`delete` calls cannot drop one another.
 */
export class ScopedStorage {
  constructor(
    private readonly pluginId: string,
    private readonly dataDir: string,
  ) {}

  private filePath(): string {
    return path.join(this.dataDir, `${this.pluginId}.json`);
  }

  private async readAll(): Promise<Record<string, unknown>> {
    const parsed = await readJsonFile<unknown>(this.filePath());
    if (parsed === null) {
      return {};
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    throw new StorageCorruptionError(
      this.filePath(),
      `expected a JSON object, got ${typeof parsed}`,
    );
  }

  async get(key: string): Promise<unknown> {
    const data = await this.readAll();
    return data[key];
  }

  async set(key: string, value: unknown): Promise<void> {
    await sharedWriteQueue.enqueue(this.filePath(), async () => {
      const data = await this.readAll();
      data[key] = value;
      await atomicWriteFile(this.filePath(), JSON.stringify(data, null, 2));
    });
  }

  async delete(key: string): Promise<void> {
    await sharedWriteQueue.enqueue(this.filePath(), async () => {
      const data = await this.readAll();
      delete data[key];
      await atomicWriteFile(this.filePath(), JSON.stringify(data, null, 2));
    });
  }

  async list(prefix?: string): Promise<string[]> {
    const data = await this.readAll();
    const keys = Object.keys(data);
    if (prefix === undefined) {
      return keys;
    }
    return keys.filter((key) => key.startsWith(prefix));
  }
}
