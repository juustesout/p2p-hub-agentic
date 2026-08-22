import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginHost } from "./plugin-host";
import {
  collectPluginFileHashes,
  signManifest,
} from "@p2p-hub/sdk";

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

function makeSigningKey(): string {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return typeof pem === "string" ? pem : pem.toString("utf8");
}

async function signPluginDir(
  root: string,
  name: string,
  privateKeyPem: string,
): Promise<void> {
  const dir = path.join(root, "plugins", name);
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  ) as Record<string, unknown>;
  manifest.files = await collectPluginFileHashes(dir);
  manifest.signature = signManifest(manifest, privateKeyPem);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

function silenceConsole(): () => void {
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => undefined;
  console.warn = () => undefined;
  return () => {
    console.error = originalError;
    console.warn = originalWarn;
  };
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

test("ctx.trust resolves contacts late-bound across load order", async () => {
  const root = await makeTmpRoot();
  // "aaa-probe" activates before "contacts" (alphabetical), so at its own
  // activation time contacts is not yet loaded. Its lookup must still resolve
  // correctly when called after boot.
  await writePlugin(
    root,
    "aaa-probe",
    { id: "aaa-probe", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
       return {
         lookup: async (peerId) => (ctx.trust ? ctx.trust.getContact(peerId) : null),
       };
     }`,
  );
  await writePlugin(
    root,
    "contacts",
    { id: "contacts", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate() {
       return {
         getContact: async (peerId) =>
           peerId === "a".repeat(64) ? { trustState: "verified" } : null,
       };
     }`,
  );

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
  });
  await host.boot();

  const probe = host.getActivated("aaa-probe") as {
    lookup: (peerId: string) => Promise<{ trustState: string } | null>;
  };

  assert.deepEqual(await probe.lookup("a".repeat(64)), { trustState: "verified" });
  assert.equal(await probe.lookup("b".repeat(64)), null);
});

test("ctx.trust fails closed when no contacts plugin is active", async () => {
  const root = await makeTmpRoot();
  await writePlugin(
    root,
    "probe",
    { id: "probe", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
    `export default function activate(ctx) {
       return {
         lookup: async (peerId) => (ctx.trust ? ctx.trust.getContact(peerId) : null),
       };
     }`,
  );

  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
  });
  await host.boot();

  const probe = host.getActivated("probe") as {
    lookup: (peerId: string) => Promise<unknown>;
  };

  assert.equal(await probe.lookup("a".repeat(64)), null);
});

test("an unsigned plugin loads but is flagged as untrusted (Fase 2C)", async () => {
  const restore = silenceConsole();
  try {
    const root = await makeTmpRoot();
    await writePlugin(
      root,
      "unsigned-plugin",
      { id: "unsigned-plugin", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
      `export default function activate() { return { name: "unsigned" }; }`,
    );

    const host = new PluginHost({
      pluginsDir: path.join(root, "plugins"),
      dataDir: path.join(root, "data"),
    });
    await host.boot();

    assert.deepEqual(host.getActivated("unsigned-plugin"), { name: "unsigned" });
    assert.equal(host.pluginSignature("unsigned-plugin"), "unsigned");
  } finally {
    restore();
  }
});

test("requireSignedPlugins refuses unsigned plugins at boot (Fase 2C)", async () => {
  const restore = silenceConsole();
  try {
    const root = await makeTmpRoot();
    await writePlugin(
      root,
      "unsigned-blocked",
      { id: "unsigned-blocked", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
      `export default function activate() { return { name: "unsigned" }; }`,
    );
    const key = makeSigningKey();
    await writePlugin(
      root,
      "signed-ok",
      { id: "signed-ok", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
      `export default function activate() { return { name: "signed" }; }`,
    );
    await signPluginDir(root, "signed-ok", key);

    const host = new PluginHost({
      pluginsDir: path.join(root, "plugins"),
      dataDir: path.join(root, "data"),
      requireSignedPlugins: true,
    });
    await host.boot();

    // The unsigned plugin is refused entirely; the signed one loads.
    assert.equal(host.getActivated("unsigned-blocked"), undefined);
    assert.deepEqual(host.getActivated("signed-ok"), { name: "signed" });
    assert.equal(host.pluginSignature("signed-ok"), "signed");
  } finally {
    restore();
  }
});

test("a signed plugin whose code changed after signing is refused (Fase 2C)", async () => {
  const restore = silenceConsole();
  try {
    const root = await makeTmpRoot();
    const key = makeSigningKey();
    await writePlugin(
      root,
      "signed-mutated",
      { id: "signed-mutated", version: "1.0.0", kind: "generic", permissions: [], entry: "./index.mjs" },
      `export default function activate() { return { name: "clean" }; }`,
    );
    await signPluginDir(root, "signed-mutated", key);
    await fs.writeFile(
      path.join(root, "plugins", "signed-mutated", "index.mjs"),
      `export default function activate() { throw new Error("evil"); }`,
    );

    const host = new PluginHost({
      pluginsDir: path.join(root, "plugins"),
      dataDir: path.join(root, "data"),
    });
    await host.boot();

    assert.equal(host.getActivated("signed-mutated"), undefined);
    assert.equal(host.pluginSignature("signed-mutated"), undefined);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// A1/Slice 2 — the host wires its child-identity registry as the broker's
// agent gate and passes the operator's approval gate through.
// ---------------------------------------------------------------------------

test("A1: a derived child is recognised as an agent by the host's broker and escalated", async () => {
  const root = await makeTmpRoot();
  await fs.mkdir(path.join(root, "plugins"), { recursive: true });
  const approvals: Array<{ taskId: string; skill: string; agentLabel: string; peerId: string }> = [];
  const host = new PluginHost({
    pluginsDir: path.join(root, "plugins"),
    dataDir: path.join(root, "data"),
    taskApprovalGate: {
      approveAgentTask: async (request) => {
        approvals.push(request);
        return true;
      },
    },
  });
  await host.boot();

  const child = await host.identityManager().deriveChildIdentity("wired-agent");
  const operator = await host.identityManager().getOrCreateIdentity();
  assert.notEqual(child.peerId, operator.peerId);

  const broker = host.taskBroker();
  const passedGate = host
    .accessPassManager()
    .issue(child.peerId, "agent-run");
  assert.ok(passedGate);

  // An agent-initiated invocation on a Tier-2 (approved) skill consults the
  // operator's approval gate and reaches the handler with the agent audit
  // context — the operator's own identity is never substituted.
  broker.registerSkill("agent.safe", async (_payload, ctx) => ctx, {
    localOnly: false,
    remote: { gate: "access-pass", scope: "agent-run", agent: { level: "approved" } },
  });
  const agentCall = await broker.handleRemote({
    id: "wired-1",
    skill: "agent.safe",
    peerId: child.peerId,
    payload: null,
  });
  assert.equal(agentCall.status, "ok");
  assert.deepEqual(agentCall.result, {
    peerId: child.peerId,
    initiatedBy: "agent",
    agentLabel: "wired-agent",
  });
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0], {
    taskId: "wired-1",
    skill: "agent.safe",
    agentLabel: "wired-agent",
    peerId: child.peerId,
  });

  // The operator's own peerId is never treated as an agent: the public `any`
  // gate still works for it, with no approval.
  broker.registerSkill("agent.public", async (_payload, ctx) => ctx, {
    localOnly: false,
    remote: { gate: "any" },
  });
  const operatorCall = await broker.handleRemote({
    id: "wired-2",
    skill: "agent.public",
    peerId: operator.peerId,
    payload: null,
  });
  assert.equal(operatorCall.status, "ok");
  assert.deepEqual(operatorCall.result, {
    peerId: operator.peerId,
    initiatedBy: "operator",
  });
  assert.equal(approvals.length, 1);

  // Deleting the agent identity removes it from the live registry immediately:
  // the same peerId stops escalating (no more approval), reverting to a plain
  // peer that still has to pass the normal gate.
  await host.identityManager().deleteChildIdentity("wired-agent");
  const afterDelete = await broker.handleRemote({
    id: "wired-3",
    skill: "agent.safe",
    peerId: child.peerId,
    payload: null,
  });
  assert.equal(afterDelete.status, "ok");
  assert.deepEqual(afterDelete.result, { peerId: child.peerId, initiatedBy: "operator" });
  assert.equal(approvals.length, 1);
});
