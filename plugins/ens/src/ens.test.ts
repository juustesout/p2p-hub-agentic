import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StorageManager } from "@p2p-hub/core";
import type { PluginContext } from "@p2p-hub/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import activate from "./index";
import type { EnsPlugin, EnsRpcClient } from "./index";

/**
 * The exact statement the plugin computes, so tests sign what the plugin will
 * verify. `name` is the ENSIP-15-normalized name (with `.eth` suffix).
 */
function statementFor(peerId: string, name: string): string {
  return `I authorize peer ${peerId} for name ${name}`;
}

function makeEd25519Keypair(): string {
  // Matches IdentityManager's encoding: the raw 32-byte Ed25519 public key as
  // lowercase hex, no 0x prefix. A real key (not a hand-written string) catches
  // casing/prefix mismatches in the plugin.
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return Buffer.from(jwk.x, "base64url").toString("hex");
}

function makeCtx(dataDir: string): PluginContext {
  const storage = new StorageManager(dataDir);
  const own = storage.getOrCreate("ens");
  const disposable = { dispose: () => {} };
  const ctx = {
    storage: {
      get: (key: string) => own.get(key),
      set: (key: string, value: unknown) => own.set(key, value),
      delete: (key: string) => own.delete(key),
      list: (prefix?: string) => own.list(prefix),
    },
    readStorageOf: () => null,
    dataDir,
    hooks: {
      on: () => disposable,
      emit: async () => {},
      registerFilter: () => disposable,
      applyFilters: async (_event: string, value: unknown) => value,
    },
    skills: {
      register: () => {},
      unregister: () => {},
    },
    ai: {
      generateText: async () => {
        throw new Error("unused");
      },
    },
    vault: {
      setSecret: async () => {},
      listSecretKeys: async () => [],
      deleteSecret: async () => false,
    },
    identity: {
      sign: async () => Buffer.alloc(0),
      verify: () => false,
      peerId: async () => "",
    },
    network: null,
    trust: null,
    timers: {
      setTimeout: () => disposable,
      setInterval: () => disposable,
    },
    onDispose: () => {},
  };
  return ctx as unknown as PluginContext;
}

interface FakeEnsOptions {
  peerId?: string | null;
  sig?: string | null;
  owner?: string | null;
}

/** Fake RPC client with a call counter, so tests assert "no live lookup". */
function fakeClient(
  opts: FakeEnsOptions,
): EnsRpcClient & { calls: () => number } {
  let calls = 0;
  return {
    async getText(_name: string, key: string) {
      calls += 1;
      if (key === "p2p.peer") return opts.peerId ?? null;
      if (key === "p2p.sig") return opts.sig ?? null;
      return null;
    },
    async getOwner(_name: string) {
      calls += 1;
      return opts.owner ?? null;
    },
    calls: () => calls,
  };
}

interface MakePluginOptions {
  client?: EnsRpcClient & { calls?: () => number };
  now?: () => number;
  ttlMs?: number;
}

async function makePlugin(
  opts: MakePluginOptions = {},
): Promise<{ plugin: EnsPlugin; dataDir: string }> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ens-data-"));
  const plugin = activate(makeCtx(dataDir), {
    ensClient: opts.client,
    now: opts.now,
    ttlMs: opts.ttlMs,
  });
  return { plugin, dataDir };
}

// ---------------------------------------------------------------------------
// 1. Valid cross-signature -> verified peerId
// ---------------------------------------------------------------------------

test("resolve returns a verified peerId for a valid owner cross-signature", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const peerId = makeEd25519Keypair();
  const sig = await account.signMessage({
    message: statementFor(peerId, "juust.eth"),
  });

  const { plugin } = await makePlugin({
    client: fakeClient({ peerId, sig, owner: account.address }),
  });
  await plugin.setConfig({ enabled: true, rpcUrl: "http://unused.invalid" });

  const result = await plugin.resolve({ name: "juust.eth" });
  assert.equal(result.verified, true);
  if (result.verified) {
    assert.equal(result.peerId, peerId);
    assert.equal(result.ensOwnerAddress, account.address.toLowerCase());
  }
});

// ---------------------------------------------------------------------------
// 2. Missing / invalid signature -> verified:false, no usable peerId
// ---------------------------------------------------------------------------

test("resolve refuses a usable peerId when the p2p.sig record is missing", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const peerId = makeEd25519Keypair();

  const { plugin } = await makePlugin({
    client: fakeClient({ peerId, sig: null, owner: account.address }),
  });
  await plugin.setConfig({ enabled: true, rpcUrl: "http://unused.invalid" });

  const result = await plugin.resolve({ name: "juust.eth" });
  assert.equal(result.verified, false);
  assert.ok(!("peerId" in result), "verified:false must not expose a peerId");
  if (!result.verified) {
    assert.equal(result.claimedPeerId, peerId);
  }
});

test("resolve refuses a usable peerId when the p2p.sig does not match the owner", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const peerId = makeEd25519Keypair();

  // A real signature, but over the wrong statement (wrong name) and/or by the
  // wrong key — either way recovery must not equal the ENS owner.
  const sig = await other.signMessage({
    message: statementFor(peerId, "someone-else.eth"),
  });

  const { plugin } = await makePlugin({
    client: fakeClient({ peerId, sig, owner: account.address }),
  });
  await plugin.setConfig({ enabled: true, rpcUrl: "http://unused.invalid" });

  const result = await plugin.resolve({ name: "juust.eth" });
  assert.equal(result.verified, false);
  assert.ok(!("peerId" in result));
});

// ---------------------------------------------------------------------------
// 3. Disabled by default -> clean error, no lookup
// ---------------------------------------------------------------------------

test("resolve throws a clear error and never looks anything up while disabled", async () => {
  const client = fakeClient({});
  const { plugin } = await makePlugin({ client });

  await assert.rejects(
    plugin.resolve({ name: "juust.eth" }),
    /disabled/,
  );
  assert.equal(client.calls(), 0, "no RPC call while disabled");
});

// ---------------------------------------------------------------------------
// 4. Homograph warning (UX only, never a trust boundary)
// ---------------------------------------------------------------------------

test("resolve warns about a confusable name that normalizes to a real one", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const peerId = makeEd25519Keypair();

  // "Ｏ.eth" (fullwidth O) normalizes to "o.eth"; the owner signs the
  // normalized form, and the plugin must flag the raw input as suspicious.
  const sig = await account.signMessage({
    message: statementFor(peerId, "o.eth"),
  });

  const { plugin } = await makePlugin({
    client: fakeClient({ peerId, sig, owner: account.address }),
  });
  await plugin.setConfig({ enabled: true, rpcUrl: "http://unused.invalid" });

  const result = await plugin.resolve({ name: "Ｏ.eth" });
  assert.equal(result.verified, true);
  assert.ok(result.warning, "confusable input must produce a warning");
  if (result.verified) {
    assert.equal(result.peerId, peerId);
  }
});

test("resolve does not warn for an ordinary ASCII name", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const peerId = makeEd25519Keypair();
  const sig = await account.signMessage({
    message: statementFor(peerId, "juust.eth"),
  });

  const { plugin } = await makePlugin({
    client: fakeClient({ peerId, sig, owner: account.address }),
  });
  await plugin.setConfig({ enabled: true, rpcUrl: "http://unused.invalid" });

  const result = await plugin.resolve({ name: "juust.eth" });
  assert.equal(result.verified, true);
  assert.equal(result.warning, undefined);
});

// ---------------------------------------------------------------------------
// 5. Cache TTL — only verified results are cached and re-verified after expiry
// ---------------------------------------------------------------------------

test("a verified result is cached within the TTL and re-fetched after expiry", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const peerId = makeEd25519Keypair();
  const sig = await account.signMessage({
    message: statementFor(peerId, "juust.eth"),
  });

  let t = 0;
  const client = fakeClient({ peerId, sig, owner: account.address });
  const { plugin } = await makePlugin({ client, now: () => t, ttlMs: 1000 });
  await plugin.setConfig({ enabled: true, rpcUrl: "http://unused.invalid" });

  await plugin.resolve({ name: "juust.eth" });
  const callsAfterFirst = client.calls();

  // Within the TTL the cached result is returned without new RPC calls.
  await plugin.resolve({ name: "juust.eth" });
  assert.equal(client.calls(), callsAfterFirst, "cached within TTL");

  // Past the TTL the binding is re-verified.
  t = 2000;
  await plugin.resolve({ name: "juust.eth" });
  assert.ok(client.calls() > callsAfterFirst, "re-fetched after TTL");
});

test("an unverified result is never cached", async () => {
  const client = fakeClient({});
  const { plugin } = await makePlugin({ client });
  await plugin.setConfig({ enabled: true, rpcUrl: "http://unused.invalid" });

  await plugin.resolve({ name: "juust.eth" });
  const callsAfterFirst = client.calls();
  await plugin.resolve({ name: "juust.eth" });
  assert.ok(client.calls() > callsAfterFirst, "unverified is re-checked");
});
