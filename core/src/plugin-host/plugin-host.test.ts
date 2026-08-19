import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginHost } from "./plugin-host";

async function makeTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "plugin-host-"));
}

async function writePlugin(
  root: string,
  name: string,
  manifest: Record<string, unknown> | null,
  entrySource: string,
): Promise<void> {
  const dir = path.join(root, "plugins", name);
  await fs.mkdir(dir, { recursive: true });
  if (manifest) {
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  }
  await fs.writeFile(path.join(dir, "index.mjs"), entrySource);
}

test("boot activates all valid plugins", async () => {
  const root = await makeTmpRoot();
  await writePlugin(
    root,
    "alpha",
    { id: "alpha", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() { return { name: "alpha" }; }`,
  );
  await writePlugin(
    root,
    "beta",
    { id: "beta", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() { return { name: "beta" }; }`,
  );

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
  });
  await host.boot();

  assert.deepEqual(host.getActivated("alpha"), { name: "alpha" });
  assert.deepEqual(host.getActivated("beta"), { name: "beta" });
});

test("a broken plugin does not block boot of the others", async () => {
  const root = await makeTmpRoot();
  await writePlugin(
    root,
    "good",
    { id: "good", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() { return { ok: true }; }`,
  );
  const brokenDir = path.join(root, "plugins", "broken");
  await fs.mkdir(brokenDir, { recursive: true });

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
  });

  try {
    await host.boot();
  } finally {
    console.error = original;
  }

  assert.deepEqual(host.getActivated("good"), { ok: true });
  assert.equal(host.getActivated("broken"), undefined);
  assert.ok(
    errors.some((message) => message.includes("broken")),
    "expected an error log mentioning the broken plugin",
  );
});

test("a plugin with a corrupt storage file is skipped, others still boot", async () => {
  const root = await makeTmpRoot();
  await writePlugin(
    root,
    "good",
    { id: "good", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() { return { ok: true }; }`,
  );
  await writePlugin(
    root,
    "corrupt",
    { id: "corrupt", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default async function activate(ctx) {
       await ctx.storage.get("k");
       return { ok: true };
     }`,
  );

  // Corrupt the "corrupt" plugin's storage file before boot.
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.writeFile(path.join(root, "data", "corrupt.json"), "{ not valid", "utf8");

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
  });

  try {
    await host.boot();
  } finally {
    console.error = original;
  }

  assert.deepEqual(host.getActivated("good"), { ok: true });
  assert.equal(host.getActivated("corrupt"), undefined);
  assert.ok(
    errors.some((message) => message.includes("corrupt")),
    "expected an error log mentioning the corrupt-storage plugin",
  );
});

test("a corrupt vault does not block local-only boot", async () => {
  const root = await makeTmpRoot();
  await writePlugin(
    root,
    "good",
    { id: "good", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() { return { ok: true }; }`,
  );

  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.writeFile(path.join(root, "data", "vault.json"), "{ not valid", "utf8");

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
  });
  await host.boot();

  assert.deepEqual(host.getActivated("good"), { ok: true });
});

test("a corrupt vault fails networking loudly but still boots plugins", async () => {
  const root = await makeTmpRoot();
  await writePlugin(
    root,
    "good",
    { id: "good", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() { return { ok: true }; }`,
  );

  await fs.mkdir(path.join(root, "data"), { recursive: true });
  await fs.writeFile(path.join(root, "data", "vault.json"), "{ not valid", "utf8");

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
    enableNetworking: true,
  });

  try {
    await host.boot();
  } finally {
    console.error = original;
  }

  assert.deepEqual(host.getActivated("good"), { ok: true });
  assert.equal(host.networkRegistry().selectActive(), null);
  assert.ok(
    errors.some((message) => message.includes("networking")),
    "expected a log noting the networking failure",
  );
});

test("core:ready is emitted only after all plugins are activated", async () => {
  const root = await makeTmpRoot();
  await writePlugin(
    root,
    "alpha",
    { id: "alpha", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() { return { name: "alpha" }; }`,
  );
  await writePlugin(
    root,
    "beta",
    { id: "beta", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() { return { name: "beta" }; }`,
  );

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
  });

  const seen: string[] = [];
  host.hookRegistry().on("core:ready", () => {
    seen.push(`alpha:${host.getActivated("alpha") !== undefined}`);
    seen.push(`beta:${host.getActivated("beta") !== undefined}`);
  });

  await host.boot();

  assert.deepEqual(seen, ["alpha:true", "beta:true"]);
});
