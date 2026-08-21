import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  PluginManifest,
  NetworkPeer,
  TaskRequest,
  TaskResult,
  ContactLookup,
} from "@p2p-hub/sdk";
import { HookRegistry } from "../hooks/hook-registry";
import { TaskBroker } from "../task-broker/task-broker";
import { CoreAIProvider } from "../ai/core-ai-provider";
import { VaultManager } from "../storage/vault-manager";
import { IdentityManager } from "../identity/identity-manager";
import { NetworkRegistry } from "../network-registry";
import { DisposerBag } from "../disposable";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  withRetry,
  withTimeout,
} from "../network/retry";
import type { StorageManager } from "../storage/storage-manager";
import type { PluginContext, NetworkCapability } from "./plugin-context";
import { verifyManifestSignature, verifyPluginFiles } from "@p2p-hub/sdk";

/**
 * Raised when a plugin `manifest.json` cannot be read, parsed or validated.
 * All malformed-input paths surface as this typed error rather than a bare
 * `Error` or an uncaught parse/regex failure.
 */
export class InvalidManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidManifestError";
  }
}

/**
 * Read and validate `manifest.json` from a plugin directory.
 */
export async function loadManifest(pluginDir: string): Promise<PluginManifest> {
  const manifestPath = path.join(pluginDir, "manifest.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (err) {
    throw new InvalidManifestError(
      `cannot read plugin manifest at ${manifestPath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidManifestError(
      `invalid plugin manifest at ${manifestPath}: not valid JSON`,
    );
  }

  validateManifest(parsed, manifestPath);
  if ((parsed as { signature?: unknown }).signature !== undefined) {
    // Fase 2C: a manifest that claims a signature must prove it — any failure
    // (malformed block, wrong alg, bad key/signature format, invalid
    // signature) blocks the plugin. Unsigned manifests are handled by the
    // caller (PluginHost) as untrusted, not here.
    const verified = verifyManifestSignature(parsed);
    if (!verified.ok) {
      throw new InvalidManifestError(
        `invalid plugin manifest at ${manifestPath}: ${verified.reason}`,
      );
    }
  }
  return parsed;
}

function validateManifest(
  value: unknown,
  manifestPath: string,
): asserts value is PluginManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidManifestError(
      `invalid plugin manifest at ${manifestPath}: expected an object`,
    );
  }
  const manifest = value as Record<string, unknown>;

  if (typeof manifest.id !== "string" || manifest.id.length === 0) {
    throw new InvalidManifestError(
      `invalid plugin manifest at ${manifestPath}: missing or empty "id"`,
    );
  }
  // The id is used to build `<dataDir>/<pluginId>.json`, as the permission
  // string `storage:read:<id>`, and as the namespace prefix for every skill
  // key (`<pluginId>.<skillName>`) and hook event (`<pluginId>:`). Dots are
  // deliberately FORBIDDEN (Fase 2C): the dot is the namespace delimiter, so a
  // dotted id like "a.b" could otherwise collide with plugin "a"'s skill
  // "b.x". Restricting ids to a dot-free identifier makes the delimiter
  // unambiguous by construction — same class of fix as anchoring namespace
  // prefix checks on the delimiter itself.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(manifest.id)) {
    throw new InvalidManifestError(
      `invalid plugin manifest at ${manifestPath}: "id" must start with an ` +
        `alphanumeric and contain only alphanumerics, "_" or "-" ` +
        `(dots are reserved as the skill/event namespace delimiter)`,
    );
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new InvalidManifestError(
      `invalid plugin manifest at ${manifestPath}: missing or empty "version"`,
    );
  }
  if (
    manifest.kind !== "network-provider" &&
    manifest.kind !== "storage-plugin" &&
    manifest.kind !== "generic"
  ) {
    throw new InvalidManifestError(
      `invalid plugin manifest at ${manifestPath}: "kind" must be one of ` +
        `"network-provider", "storage-plugin", "generic"`,
    );
  }
  if (
    !Array.isArray(manifest.permissions) ||
    !manifest.permissions.every((p) => typeof p === "string")
  ) {
    throw new InvalidManifestError(
      `invalid plugin manifest at ${manifestPath}: "permissions" must be an array of strings`,
    );
  }
  if (typeof manifest.entry !== "string" || manifest.entry.length === 0) {
    throw new InvalidManifestError(
      `invalid plugin manifest at ${manifestPath}: missing or empty "entry"`,
    );
  }
  if (manifest.name !== undefined && typeof manifest.name !== "string") {
    throw new InvalidManifestError(
      `invalid plugin manifest at ${manifestPath}: "name" must be a string`,
    );
  }
  if (
    manifest.exposedEvents !== undefined &&
    (!Array.isArray(manifest.exposedEvents) ||
      !manifest.exposedEvents.every((e) => typeof e === "string"))
  ) {
    throw new InvalidManifestError(
      `invalid plugin manifest at ${manifestPath}: "exposedEvents" must be an array of strings`,
    );
  }
  if (manifest.ui !== undefined) {
    if (
      typeof manifest.ui !== "object" ||
      manifest.ui === null ||
      Array.isArray(manifest.ui)
    ) {
      throw new InvalidManifestError(
        `invalid plugin manifest at ${manifestPath}: "ui" must be an object`,
      );
    }
    const ui = manifest.ui as Record<string, unknown>;
    if (typeof ui.entry !== "string" || ui.entry.length === 0) {
      throw new InvalidManifestError(
        `invalid plugin manifest at ${manifestPath}: "ui.entry" must be a non-empty string`,
      );
    }
    if (ui.defaultWidth !== undefined && typeof ui.defaultWidth !== "number") {
      throw new InvalidManifestError(
        `invalid plugin manifest at ${manifestPath}: "ui.defaultWidth" must be a number`,
      );
    }
    if (ui.defaultHeight !== undefined && typeof ui.defaultHeight !== "number") {
      throw new InvalidManifestError(
        `invalid plugin manifest at ${manifestPath}: "ui.defaultHeight" must be a number`,
      );
    }
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
  hookRegistry: HookRegistry,
  taskBroker: TaskBroker = new TaskBroker(),
  vaultManager: VaultManager = new VaultManager(),
  identityManager: IdentityManager = new IdentityManager({ vault: vaultManager }),
  networkRegistry: NetworkRegistry | null = null,
  disposers: DisposerBag = new DisposerBag(),
  resolveTrustLookup: (() => ContactLookup | null) | null = null,
): Promise<unknown> {
  const manifest = await loadManifest(pluginDir);
  if (manifest.signature !== undefined) {
    // Fase 2C: a signed manifest is only trusted if every shipped file matches
    // its signed content hashes. A mismatch (changed code, dropped-in file)
    // means the plugin no longer is what its signer shipped — fail closed.
    const files = manifest.files ?? {};
    const verified = await verifyPluginFiles(pluginDir, files);
    if (!verified.ok) {
      throw new InvalidManifestError(
        `signed plugin "${manifest.id}" failed content verification: ` +
          `${verified.reason}`,
      );
    }
  }
  const own = storageManager.getOrCreate(manifest.id);
  const aiProvider = new CoreAIProvider({ vault: vaultManager });

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
    dataDir: storageManager.getDataDir(),
    hooks: {
      on: (event, handler, priority = 10) => {
        const subscription = hookRegistry.on(event, handler, priority);
        disposers.add(subscription);
        return subscription;
      },
      emit: async (event, payload) => {
        assertOwnNamespace(manifest.id, event, "emit");
        await hookRegistry.emit(event, payload);
      },
      registerFilter: (event, fn, priority = 10) => {
        if (
          !event.startsWith(`${manifest.id}:`) &&
          !manifest.permissions.includes(`hooks:filter:${event}`)
        ) {
          throw new Error(
            `plugin "${manifest.id}" lacks permission ` +
              `"hooks:filter:${event}" to register a cross-namespace filter`,
          );
        }
        const subscription = hookRegistry.registerFilter(event, fn, priority);
        disposers.add(subscription);
        return subscription;
      },
      applyFilters: async (event, value) => {
        assertOwnNamespace(manifest.id, event, "applyFilters");
        return hookRegistry.applyFilters(event, value);
      },
    },
    skills: {
      // The plugin supplies only the local name; we prefix it with its id, so
      // it cannot register under another plugin's namespace by construction —
      // no runtime check is needed here, unlike hooks where the plugin can
      // pass an arbitrary event string. Exposing a skill to the network
      // (localOnly: false) additionally requires an explicit manifest
      // permission, so a plugin author must make that choice deliberately.
      register: (skillName, handler, options) => {
        if (options?.localOnly === false) {
          assertNetworkSkillPermission(manifest, skillName);
        }
        const fullName = `${manifest.id}.${skillName}`;
        taskBroker.registerSkill(fullName, handler, options);
        disposers.add(() => taskBroker.unregisterSkill(fullName));
      },
      unregister: (skillName) => {
        taskBroker.unregisterSkill(`${manifest.id}.${skillName}`);
      },
    },
    ai: {
      generateText: (options) => aiProvider.generateText(options),
      generateImage: (options) => aiProvider.generateImage(options),
    },
    vault: {
      setSecret: (key, value) => {
        assertWritable(key, vaultManager.reservedPrefixes);
        return vaultManager.setSecret(key, value);
      },
      listSecretKeys: async () => {
        const keys = await vaultManager.listSecretKeys();
        return keys.filter(
          (key) => !vaultManager.reservedPrefixes.some((p) => key.startsWith(p)),
        );
      },
      deleteSecret: (key) => {
        assertWritable(key, vaultManager.reservedPrefixes);
        return vaultManager.deleteSecret(key);
      },
    },
    identity: {
      sign: (data) => identityManager.sign(data),
      verify: (publicKeyHex, data, signature) =>
        IdentityManager.verify(publicKeyHex, data, signature),
      peerId: async () => (await identityManager.getOrCreateIdentity()).peerId,
    },
    network: buildNetworkCapability(networkRegistry),
    trust: resolveTrustLookup
      ? {
          getContact: async (peerId) => {
            const lookup = resolveTrustLookup();
            return lookup ? await lookup.getContact(peerId) : null;
          },
        }
      : null,
    timers: {
      setTimeout: (handler, ms) => {
        const timer = globalThis.setTimeout(() => handler(), ms);
        const disposable = { dispose: () => clearTimeout(timer) };
        disposers.add(disposable);
        return disposable;
      },
      setInterval: (handler, ms) => {
        const timer = globalThis.setInterval(() => handler(), ms);
        const disposable = { dispose: () => clearInterval(timer) };
        disposers.add(disposable);
        return disposable;
      },
    },
    onDispose: (disposer) => {
      disposers.add(disposer);
    },
  };

  const pluginDirResolved = path.resolve(pluginDir);
  const entryPath = path.resolve(pluginDirResolved, manifest.entry);
  if (
    entryPath !== pluginDirResolved &&
    !entryPath.startsWith(pluginDirResolved + path.sep)
  ) {
    throw new Error(
      `plugin "${manifest.id}" entry "${manifest.entry}" escapes its directory`,
    );
  }
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

function assertOwnNamespace(pluginId: string, event: string, verb: string): void {
  if (!event.startsWith(`${pluginId}:`)) {
    const idx = event.indexOf(":");
    const namespace = idx === -1 ? event : event.slice(0, idx);
    throw new Error(
      `plugin "${pluginId}" cannot ${verb} on namespace "${namespace}"`,
    );
  }
}

function assertWritable(key: string, reserved: string[]): void {
  const match = reserved.find((p) => key.startsWith(p));
  if (match) {
    throw new Error(
      `vault key "${key}" is in the reserved namespace "${match}" and ` +
        `cannot be modified through the plugin vault`,
    );
  }
}

function assertNetworkSkillPermission(
  manifest: PluginManifest,
  skillName: string,
): void {
  const permission = `network:skill:${manifest.id}.${skillName}`;
  if (!manifest.permissions.includes(permission)) {
    throw new Error(
      `plugin "${manifest.id}" exposes skill "${skillName}" to the network ` +
        `but lacks permission "${permission}"`,
    );
  }
}

function buildNetworkCapability(
  registry: NetworkRegistry | null,
): NetworkCapability | null {
  if (!registry) {
    return null;
  }
  return {
    async discover(skill: string): Promise<NetworkPeer[]> {
      // Fase 1A: the provider exchanges capabilities in the authenticated
      // handshake, so `discover` filters by what a peer actually offers — mDNS
      // still leaks nothing (Fase 0C), and a peer that cannot complete the
      // handshake is never listed.
      const active = registry.selectActive();
      if (!active) {
        return [];
      }
      return active.discover(skill);
    },
    async sendTask(peerId: string, task: TaskRequest): Promise<TaskResult> {
      const active = registry.selectActive();
      if (!active) {
        return {
          taskId: task.id,
          status: "error",
          error: "no active network provider",
        };
      }
      const peers = active.listPeers ? active.listPeers() : [];
      const target = peers.find((peer) => peer.peerId === peerId);
      if (!target) {
        return {
          taskId: task.id,
          status: "error",
          error: `peer "${peerId}" is not currently reachable`,
        };
      }
      // Bound the remote call and retry transient connection drops so a silent
      // peer fails with NetworkTimeoutError instead of hanging the caller.
      try {
        return await withRetry(
          () =>
            withTimeout(
              active.sendTask(target, task),
              DEFAULT_REQUEST_TIMEOUT_MS,
            ),
          { maxRetries: 3, initialDelayMs: 200, factor: 2 },
        );
      } catch (err) {
        // Uphold the "never throws" contract: surface a non-transient
        // transport failure as an error result, not a rejected promise.
        return {
          taskId: task.id,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

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
