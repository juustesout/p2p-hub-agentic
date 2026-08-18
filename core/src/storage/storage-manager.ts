import { ScopedStorage } from "./scoped-storage";
import type { StorageWarningHandler } from "./backup";

/**
 * Owns one {@link ScopedStorage} per plugin id.
 */
export class StorageManager {
  private readonly storages = new Map<string, ScopedStorage>();

  constructor(
    private readonly dataDir: string,
    private readonly onWarning?: StorageWarningHandler,
  ) {}

  getOrCreate(pluginId: string): ScopedStorage {
    let storage = this.storages.get(pluginId);
    if (!storage) {
      storage = new ScopedStorage(pluginId, this.dataDir, this.onWarning);
      this.storages.set(pluginId, storage);
    }
    return storage;
  }
}
