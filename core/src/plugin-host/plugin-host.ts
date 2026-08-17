import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { StorageManager } from "../storage/storage-manager";
import { HookRegistry } from "../hooks/hook-registry";
import { TaskBroker } from "../task-broker/task-broker";
import { loadManifest, loadPlugin } from "../plugin-loader/plugin-loader";

export interface PluginHostOptions {
  pluginsDir: string;
  dataDir: string;
}

/**
 * Orchestrates every installed plugin: scans `pluginsDir`, loads each
 * subdirectory containing a `manifest.json` through `loadPlugin`, sharing a
 * single {@link StorageManager} and {@link HookRegistry} across the whole
 * host.
 *
 * Load order is simply the (alphabetically sorted) subdirectory order. There
 * is no dependency resolution between plugins in this stage — a later plugin
 * that needs an earlier one must rely on the `core:ready` action, which is
 * emitted after every plugin has been activated.
 */
export class PluginHost {
  private readonly storages: StorageManager;
  private readonly hooks: HookRegistry;
  private readonly broker: TaskBroker;
  private readonly activated = new Map<string, unknown>();

  constructor(private readonly options: PluginHostOptions) {
    this.storages = new StorageManager(options.dataDir);
    this.hooks = new HookRegistry();
    this.broker = new TaskBroker();
  }

  /**
   * Load all plugins sequentially. A plugin directory without a valid
   * manifest (or one whose entry/activation fails) is logged and skipped; it
   * never blocks the rest of the boot. After the loop, `core:ready` is
   * emitted so plugins can run post-boot work without guessing load order.
   */
  async boot(): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.options.pluginsDir, {
        withFileTypes: true,
      });
    } catch (err) {
      throw new Error(
        `[plugin-host] cannot read plugins dir "${this.options.pluginsDir}": ` +
          `${(err as Error).message}`,
      );
    }

    const subdirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const name of subdirs) {
      const pluginDir = path.join(this.options.pluginsDir, name);

      let manifestId: string;
      try {
        manifestId = (await loadManifest(pluginDir)).id;
      } catch (err) {
        console.error(`[plugin-host] skipping "${name}": ${(err as Error).message}`);
        continue;
      }

      try {
        const instance = await loadPlugin(
          pluginDir,
          this.storages,
          this.hooks,
          this.broker,
        );
        this.activated.set(manifestId, instance);
      } catch (err) {
        console.error(
          `[plugin-host] failed to activate "${manifestId}": ${(err as Error).message}`,
        );
      }
    }

    await this.hooks.emit("core:ready", null);
  }

  getActivated(pluginId: string): unknown {
    return this.activated.get(pluginId);
  }

  hookRegistry(): HookRegistry {
    return this.hooks;
  }

  storageManager(): StorageManager {
    return this.storages;
  }

  taskBroker(): TaskBroker {
    return this.broker;
  }
}
