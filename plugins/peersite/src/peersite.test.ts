import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DisposerBag,
  HookRegistry,
  loadPlugin,
  NetworkRegistry,
  resolveAndContainFile,
  StorageManager,
  TaskBroker,
  VaultManager,
} from "@p2p-hub/core";
import type {
  ContactTrustState,
  NetworkPeer,
  NetworkProvider,
  TaskRequest,
  TaskResult,
} from "@p2p-hub/sdk";
import { buildAuthMessage, buildKnockMessage } from "@p2p-hub/core";
import type { PeerSitePlugin } from "./index";

const pluginDir = path.resolve(__dirname, "..");

function makeKeypair(): {
  privateKey: crypto.KeyObject;
  publicKeyHex: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    privateKey,
    publicKeyHex: Buffer.from(jwk.x, "base64url").toString("hex"),
  };
}

interface LoadOptions {
  storage?: StorageManager;
  dataDir?: string;
  trustState?: ContactTrustState | null;
  trustEnabled?: boolean;
  networking?: boolean;
  hooks?: HookRegistry;
}

async function loadPeerSite(opts: LoadOptions = {}): Promise<{
  plugin: PeerSitePlugin;
  dataDir: string;
  storage: StorageManager;
  peerId: string;
  privateKey: crypto.KeyObject;
  hooks: HookRegistry;
}> {
  const dataDir =
    opts.dataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "peersite-data-")));
  const storage = opts.storage ?? new StorageManager(dataDir);
  const vault = new VaultManager({
    dataDir: path.join(dataDir, "vault"),
    masterKey: "test-master",
  });

  const peer = makeKeypair();
  const trustEnabled = opts.trustEnabled ?? true;
  const networking = opts.networking ?? true;
  const hooks = opts.hooks ?? new HookRegistry();

  let registry: NetworkRegistry | null = null;
  if (networking) {
    registry = new NetworkRegistry();
    registry.register(
      fakeProvider(peer.publicKeyHex, (data) =>
        crypto.sign(null, data, peer.privateKey),
      ),
    );
  }

  const trustState = opts.trustState === undefined ? "verified" : opts.trustState;
  const trust = {
    getContact: async (id: string) => {
      if (id !== peer.publicKeyHex || trustState === null) {
        return null;
      }
      return { trustState };
    },
  };

  const plugin = (await loadPlugin(
    pluginDir,
    storage,
    hooks,
    new TaskBroker(),
    vault,
    undefined,
    registry,
    new DisposerBag(),
    trustEnabled ? () => trust : null,
  )) as PeerSitePlugin;

  return { plugin, dataDir, storage, peerId: peer.publicKeyHex, privateKey: peer.privateKey, hooks };
}

function fakeProvider(
  peerId: string,
  sign: (data: Buffer) => Buffer,
): NetworkProvider {
  return {
    id: "fake",
    priority: 100,
    isReady: () => true,
    start: async () => {},
    stop: async () => {},
    discover: async () => [],
    listPeers: (): NetworkPeer[] => [
      {
        id: "fake-instance",
        address: "127.0.0.1:1",
        skills: ["peersite.signAuthChallenge"],
        name: "fake",
        peerId,
      },
    ],
    sendTask: async (_peer: NetworkPeer, task: TaskRequest): Promise<TaskResult> => {
      const nonce = (task.payload as { nonce: string }).nonce;
      const signature = sign(buildAuthMessage(Buffer.from(nonce, "hex")));
      return { taskId: task.id, status: "ok", result: { signature: signature.toString("hex") } };
    },
    onTask: () => {},
  };
}

async function makeSite(): Promise<{ root: string; dataDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "peersite-site-"));
  await fs.writeFile(path.join(root, "index.html"), "<h1>hello</h1>");
  await fs.mkdir(path.join(root, "sub"), { recursive: true });
  await fs.writeFile(path.join(root, "sub", "index.html"), "<h1>sub</h1>");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "peersite-out-"));
  return { root, dataDir };
}

// ---------------------------------------------------------------------------
// setSiteRoot / getSiteRoot (config ownership)
// ---------------------------------------------------------------------------

test("setSiteRoot validates, persists and returns the canonical realpath", async () => {
  const { plugin, storage } = await loadPeerSite();
  const { root } = await makeSite();

  const real = await plugin.setSiteRoot(root);
  assert.equal(real, await fs.realpath(root));
  assert.equal(await plugin.getSiteRoot(), real);

  // Persisted under the plugin's own storage key, so a fresh instance on the
  // same storage recovers the same root.
  const second = await loadPeerSite({ storage });
  assert.equal(await second.plugin.getSiteRoot(), real);
});

test("setSiteRoot rejects the data directory and paths inside it", async () => {
  const { plugin, dataDir } = await loadPeerSite();

  await assert.rejects(plugin.setSiteRoot(dataDir), /data directory/);

  const inside = path.join(dataDir, "sub");
  await fs.mkdir(inside, { recursive: true });
  await assert.rejects(plugin.setSiteRoot(inside), /data directory/);
});

test("setSiteRoot rejects a non-existent directory", async () => {
  const { plugin } = await loadPeerSite();
  await assert.rejects(
    plugin.setSiteRoot(path.join(os.tmpdir(), "does-not-exist-xyz")),
    /does not exist or cannot be resolved/,
  );
});

// ---------------------------------------------------------------------------
// fetchAsset — fail-closed peer authentication
// ---------------------------------------------------------------------------

test("fetchAsset denies an unverified (pending) peer", async () => {
  const { plugin, peerId } = await loadPeerSite({ trustState: "pending" });
  const { root } = await makeSite();
  await plugin.setSiteRoot(root);

  const result = await plugin.fetchAsset({ peerId, path: "index.html" });
  assert.deepEqual(result, { ok: false, error: "unauthorized" });
});

test("fetchAsset denies an unknown peer (no contact record)", async () => {
  const { plugin, peerId } = await loadPeerSite({ trustState: null });
  const { root } = await makeSite();
  await plugin.setSiteRoot(root);

  const result = await plugin.fetchAsset({ peerId, path: "index.html" });
  assert.deepEqual(result, { ok: false, error: "unauthorized" });
});

test("fetchAsset denies when no trust seam is wired", async () => {
  const { plugin, peerId } = await loadPeerSite({ trustEnabled: false });
  const { root } = await makeSite();
  await plugin.setSiteRoot(root);

  const result = await plugin.fetchAsset({ peerId, path: "index.html" });
  assert.deepEqual(result, { ok: false, error: "unauthorized" });
});

test("fetchAsset denies when no network is available for the challenge", async () => {
  const { plugin, peerId } = await loadPeerSite({ networking: false });
  const { root } = await makeSite();
  await plugin.setSiteRoot(root);

  const result = await plugin.fetchAsset({ peerId, path: "index.html" });
  assert.deepEqual(result, { ok: false, error: "unauthorized" });
});

test("fetchAsset serves a file to a verified peer", async () => {
  const { plugin, peerId } = await loadPeerSite();
  const { root } = await makeSite();
  await plugin.setSiteRoot(root);

  const result = await plugin.fetchAsset({ peerId, path: "index.html" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.contentType, /text\/html/);
    assert.equal(Buffer.from(result.data, "base64").toString("utf8"), "<h1>hello</h1>");
    assert.equal(result.name, "index.html");
  }
});

// ---------------------------------------------------------------------------
// fetchAsset — containment (traversal / symlink / dotfile / escape)
// ---------------------------------------------------------------------------

test("fetchAsset denies traversal, dotfiles, backslashes and symlink escapes", async () => {
  const { plugin, peerId } = await loadPeerSite();
  const { root, dataDir } = await makeSite();
  await plugin.setSiteRoot(root);

  // Symlink pointing outside the site root (a data-dir "escape").
  await fs.writeFile(path.join(dataDir, "secret.txt"), "top secret");
  await fs.symlink(path.join(dataDir, "secret.txt"), path.join(root, "leak.txt"));

  const denied = [
    "..", // dot-segment
    "../secret.txt", // traversal
    "a/../../etc/passwd", // traversal
    ".env", // dotfile
    "..\\secret.txt", // backslash traversal
    "sub/../..", // traversal via directory
    "leak.txt", // symlink escape
  ];

  for (const p of denied) {
    const result = await plugin.fetchAsset({ peerId, path: p });
    assert.equal(result.ok, false, `expected denial for ${JSON.stringify(p)}`);
  }
});

// ---------------------------------------------------------------------------
// HTTP <-> P2P parity
// ---------------------------------------------------------------------------

test("fetchAsset and resolveAndContainFile accept/reject exactly the same paths", async () => {
  const { plugin, peerId } = await loadPeerSite();
  const { root } = await makeSite();
  await plugin.setSiteRoot(root);

  const rootReal = await plugin.getSiteRoot();
  assert.ok(rootReal);

  const paths = [
    "index.html",
    "sub/index.html",
    "sub", // directory -> index.html
    "missing.txt",
    "../etc/passwd",
    ".env",
    "..\\secret.txt",
    "a/../../x",
  ];

  for (const p of paths) {
    const helperAccepted: boolean =
      resolveAndContainFile(rootReal, p) !== null;
    const fetched = await plugin.fetchAsset({ peerId, path: p });
    assert.equal(
      fetched.ok,
      helperAccepted,
      `parity mismatch for ${JSON.stringify(p)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// requestAccess — inline knock proof-of-possession (phase 4B)
// ---------------------------------------------------------------------------

function knockInput(
  peerId: string,
  privateKey: crypto.KeyObject,
  claim = "read your site",
  timestamp = Date.now(),
) {
  return {
    peerId,
    claim,
    timestamp,
    signature: crypto
      .sign(null, buildKnockMessage(peerId, claim, timestamp), privateKey)
      .toString("hex"),
  };
}

test("requestAccess accepts a valid knock and emits a pending request", async () => {
  const { plugin, peerId, privateKey, hooks } = await loadPeerSite();
  await plugin.setAcceptIncomingRequests(true);

  const emitted: unknown[] = [];
  hooks.on("peersite:accessRequested", (payload) => {
    emitted.push(payload);
  });

  const result = await plugin.requestAccess(knockInput(peerId, privateKey));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.status, "pending");
    assert.equal(typeof result.requestId, "string");
  }
  assert.equal(emitted.length, 1);
  const payload = emitted[0] as { peerId: string; claim: string };
  assert.equal(payload.peerId, peerId);
  assert.equal(payload.claim, "read your site");
});

test("requestAccess rejects a bad signature", async () => {
  const { plugin, peerId } = await loadPeerSite();
  await plugin.setAcceptIncomingRequests(true);

  const result = await plugin.requestAccess({
    peerId,
    claim: "read your site",
    timestamp: Date.now(),
    signature: "ff".repeat(64),
  });
  assert.deepEqual(result, { ok: false, error: "unauthorized" });
});

test("requestAccess rejects a stale timestamp outside the replay window", async () => {
  const { plugin, peerId, privateKey } = await loadPeerSite();
  await plugin.setAcceptIncomingRequests(true);

  const stale = Date.now() - 6 * 60 * 1000;
  const result = await plugin.requestAccess(
    knockInput(peerId, privateKey, "c", stale),
  );
  assert.deepEqual(result, { ok: false, error: "unauthorized" });
});

test("requestAccess rate-limits a second knock within the hour", async () => {
  const { plugin, peerId, privateKey } = await loadPeerSite();
  await plugin.setAcceptIncomingRequests(true);

  const first = await plugin.requestAccess(knockInput(peerId, privateKey));
  assert.equal(first.ok, true);

  const second = await plugin.requestAccess(knockInput(peerId, privateKey));
  assert.deepEqual(second, { ok: false, error: "rate limited" });
});

test("requestAccess is denied by default when not accepting incoming requests", async () => {
  const { plugin, peerId, privateKey } = await loadPeerSite();

  const result = await plugin.requestAccess(knockInput(peerId, privateKey));
  assert.deepEqual(result, { ok: false, error: "not accepting" });
});

// ---------------------------------------------------------------------------
// Access pass — fetchAsset pass-check (phase 4B)
// ---------------------------------------------------------------------------

test("an approved access pass lets a non-contact peer fetch assets read-only", async () => {
  const { plugin, peerId, privateKey } = await loadPeerSite({
    trustState: null,
  });
  const { root } = await makeSite();
  await plugin.setSiteRoot(root);
  await plugin.setAcceptIncomingRequests(true);

  // Unknown peer is denied before any pass exists.
  const before = await plugin.fetchAsset({ peerId, path: "index.html" });
  assert.deepEqual(before, { ok: false, error: "unauthorized" });

  const request = await plugin.requestAccess(knockInput(peerId, privateKey));
  assert.equal(request.ok, true);
  const requestId = (request as { requestId: string }).requestId;

  await plugin.resolveAccessRequest(requestId, true);

  const after = await plugin.fetchAsset({ peerId, path: "index.html" });
  assert.equal(after.ok, true);
  if (after.ok) {
    assert.equal(
      Buffer.from(after.data, "base64").toString("utf8"),
      "<h1>hello</h1>",
    );
  }
});

test("a denied access request does not grant a pass", async () => {
  const { plugin, peerId, privateKey } = await loadPeerSite({
    trustState: null,
  });
  const { root } = await makeSite();
  await plugin.setSiteRoot(root);
  await plugin.setAcceptIncomingRequests(true);

  const request = await plugin.requestAccess(knockInput(peerId, privateKey));
  assert.equal(request.ok, true);
  const requestId = (request as { requestId: string }).requestId;

  await plugin.resolveAccessRequest(requestId, false);

  const result = await plugin.fetchAsset({ peerId, path: "index.html" });
  assert.deepEqual(result, { ok: false, error: "unauthorized" });
});

test("resolveAccessRequest returns false for an unknown request id", async () => {
  const { plugin } = await loadPeerSite();
  assert.equal(await plugin.resolveAccessRequest("does-not-exist", true), false);
});
