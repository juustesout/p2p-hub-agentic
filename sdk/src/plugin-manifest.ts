export type PluginKind = "network-provider" | "storage-plugin" | "generic";

/**
 * Metadata describing a plugin. Stored as `manifest.json` in the plugin root.
 *
 * Permission convention:
 * - `storage:own` is always implicitly allowed and need not be listed;
 * - `storage:read:<pluginId>` and `storage:write:<pluginId>` grant
 *   cross-plugin access to another plugin's storage.
 */
export interface PluginManifest {
  /** Unique id, e.g. "calendar". */
  id: string;
  version: string;
  kind: PluginKind;
  permissions: string[];
  /** Module path, relative to the plugin root. */
  entry: string;
  /** Optional human-readable name. */
  name?: string;
  /**
   * Hook events this plugin opts in to exposing to remote peers. Empty by
   * default — internal hooks are never bridged to the network unless a plugin
   * explicitly lists them here.
   */
  exposedEvents?: string[];
}
