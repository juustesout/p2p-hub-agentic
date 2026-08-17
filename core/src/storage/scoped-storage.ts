import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * A key-value store isolated to a single plugin. All data for a plugin is
 * backed by one JSON file on disk: `<dataDir>/<pluginId>.json`.
 *
 * Keys are plain strings stored as JSON object keys — they are never used to
 * build filesystem paths, so a key like `"../other-plugin/secret"` stays a
 * literal key inside this plugin's own file.
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
    try {
      const raw = await fs.readFile(this.filePath(), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw err;
    }
  }

  private async writeAll(data: Record<string, unknown>): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.filePath(), JSON.stringify(data, null, 2), "utf8");
  }

  async get(key: string): Promise<unknown> {
    const data = await this.readAll();
    return data[key];
  }

  async set(key: string, value: unknown): Promise<void> {
    const data = await this.readAll();
    data[key] = value;
    await this.writeAll(data);
  }

  async delete(key: string): Promise<void> {
    const data = await this.readAll();
    delete data[key];
    await this.writeAll(data);
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
