import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import type { PluginManifest } from "@p2p-hub/sdk";
import { StorageManager } from "../storage/storage-manager";
import { HookRegistry } from "../hooks/hook-registry";
import { TaskBroker } from "../task-broker/task-broker";
import { VaultManager } from "../storage/vault-manager";
import { IdentityManager } from "../identity/identity-manager";
import { NetworkRegistry } from "../network-registry";
import { NetworkLightProvider } from "@p2p-hub/network-light";
import { loadManifest, loadPlugin } from "../plugin-loader/plugin-loader";
import { wireNetworkToBroker } from "../task-broker/wire-network";

export interface PluginHostOptions {
  pluginsDir: string;
  dataDir: string;
  /** Master passphrase for the encrypted vault. Falls back to env/DEV. */
  masterKey?: string;
  /**
   * Start the network-light transport during {@link PluginHost.boot}. Defaults
   * to `false` (deny-by-default): a host that only runs local plugins must
   * never broadcast presence or expose network skills unless it opts in.
   */
  enableNetworking?: boolean;
  /** Port for the network-light transport. Defaults to 0 (ephemeral). */
  networkPort?: number;
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
  private readonly vault: VaultManager;
  private readonly identity: IdentityManager;
  private readonly networks: NetworkRegistry;
  private provider: NetworkLightProvider | null = null;
  private readonly activated = new Map<string, unknown>();
  private readonly plugins: PluginManifest[] = [];

  constructor(private readonly options: PluginHostOptions) {
    this.storages = new StorageManager(options.dataDir);
    this.hooks = new HookRegistry();
    this.broker = new TaskBroker();
    this.vault = new VaultManager({
      dataDir: options.dataDir,
      masterKey: options.masterKey,
    });
    this.identity = new IdentityManager({ vault: this.vault });
    this.networks = new NetworkRegistry();
  }

  /**
   * Load all plugins sequentially. A plugin directory without a valid
   * manifest (or one whose entry/activation fails) is logged and skipped; it
   * never blocks the rest of the boot. After the loop, `core:ready` is
   * emitted so plugins can run post-boot work without guessing load order.
   */
  async boot(): Promise<void> {
    await this.identity.getOrCreateIdentity();

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

      let manifest: PluginManifest;
      try {
        manifest = await loadManifest(pluginDir);
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
          this.vault,
          this.identity,
          this.networks,
        );
        this.activated.set(manifest.id, instance);
        this.plugins.push(manifest);
      } catch (err) {
        console.error(
          `[plugin-host] failed to activate "${manifest.id}": ${(err as Error).message}`,
        );
      }
    }

    if (this.options.enableNetworking) {
      await this.startNetworking();
    }

    await this.hooks.emit("core:ready", null);
  }

  /**
   * Build, start, wire and register the network-light transport with this
   * host's identity and the currently network-exposed skills. Any failure is
   * logged and swallowed: networking is an opt-in enhancement, never a reason
   * for boot to crash — plugins that do not need the network keep working and
   * `ctx.network` retains its graceful "no active provider" behaviour.
   */
  private async startNetworking(): Promise<void> {
    try {
      const identity = await this.identity.getOrCreateIdentity();
      const remoteSkills = this.broker
        .listSkills()
        .filter((skill) => !skill.localOnly)
        .map((skill) => skill.skill);

      const provider = new NetworkLightProvider({
        port: this.options.networkPort ?? 0,
        skills: remoteSkills,
        identity,
      });
      wireNetworkToBroker(provider, this.broker);
      await provider.start();
      this.networks.register(provider);
      this.networks.selectActive();
      this.provider = provider;
    } catch (err) {
      console.error(
        `[plugin-host] networking failed to start: ${(err as Error).message}`,
      );
    }
  }

  /** Stop the network transport if it was started, releasing its sockets. */
  async stop(): Promise<void> {
    if (this.provider) {
      this.networks.unregister(this.provider.id);
      await this.provider.stop();
      this.provider = null;
    }
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

  vaultManager(): VaultManager {
    return this.vault;
  }

  /** Shared persistent {@link IdentityManager} (backed by the host vault). */
  identityManager(): IdentityManager {
    return this.identity;
  }

  /** Registry of network providers; register providers here to wire `ctx.network`. */
  networkRegistry(): NetworkRegistry {
    return this.networks;
  }

  /** Metadata for every successfully activated plugin. */
  listPlugins(): PluginManifest[] {
    return [...this.plugins];
  }
}
