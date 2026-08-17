export type PluginKind = "network-provider" | "storage-plugin" | "generic";

/**
 * Describes an optional bundled web UI for a plugin. Served as a static
 * document; the desktop shell renders it inside a sandboxed iframe and talks
 * to the plugin's skills through the postMessage bridge.
 */
export interface PluginManifestUI {
  /** Path to the UI entry document, relative to the plugin root. */
  entry: string;
  defaultWidth?: number;
  defaultHeight?: number;
}

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
  /** Optional bundled web UI (see {@link PluginManifestUI}). */
  ui?: PluginManifestUI;
}
