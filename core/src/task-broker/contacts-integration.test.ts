import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NetworkLightProvider } from "@p2p-hub/network-light";
import type {
  NetworkPeer,
  NetworkProvider,
  TaskRequest,
  TaskResult,
} from "@p2p-hub/sdk";
import { wireNetworkToBroker } from "./wire-network";
import { TaskBroker } from "./task-broker";
import { IdentityManager } from "../identity/identity-manager";
import { NetworkRegistry } from "../network-registry";
import { StorageManager } from "../storage/storage-manager";
import { HookRegistry } from "../hooks/hook-registry";
import { VaultManager } from "../storage/vault-manager";
import { loadPlugin } from "../plugin-loader/plugin-loader";

const CONTACTS_DIR = path.resolve(__dirname, "../../../plugins/contacts");

interface ContactsApi {
  addContact(input: {
    peerId: string;
    publicKeyHex: string;
    displayName: string;
  }): Promise<{ peerId: string; trustState: string; lastVerifiedAt?: string }>;
  listContacts(): Promise<Array<{ peerId: string; trustState: string }>>;
  removeContact(peerId: string): Promise<boolean>;
  verifyPeer(input: { peerId: string }): Promise<{ verified: boolean; error?: string }>;
}

const CHALLENGE_CONTEXT = "p2p-hub:contacts:challenge:v1:";

function challengeMessage(nonce: Buffer): Buffer {
  return Buffer.concat([Buffer.from(CHALLENGE_CONTEXT, "utf8"), nonce]);
}

async function waitFor<T>(
  check: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null | undefined;
  while (Date.now() < deadline) {
    last = await check();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function makeIdentity(): Promise<{
  identity: IdentityManager;
  vault: VaultManager;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "contacts-signer-"));
  const vault = new VaultManager({
    dataDir: path.join(dir, "vault"),
    masterKey: "test-master",
  });
  return { identity: new IdentityManager({ vault }), vault };
}

async function bootNode(): Promise<{
  contacts: ContactsApi;
  provider: NetworkLightProvider;
  peerId: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "contacts-node-"));
  const vault = new VaultManager({
    dataDir: path.join(root, "vault"),
    masterKey: "test-master",
  });
  const identity = new IdentityManager({ vault });
  const peer = await identity.getOrCreateIdentity();

  const broker = new TaskBroker();
  const registry = new NetworkRegistry();
  const contacts = (await loadPlugin(
    CONTACTS_DIR,
    new StorageManager(path.join(root, "storage")),
    new HookRegistry(),
    broker,
    vault,
    identity,
    registry,
  )) as ContactsApi;

  const provider = new NetworkLightProvider({
    port: 0,
    skills: ["contacts.signChallenge"],
    identity: peer,
    identitySigner: (data) => identity.sign(data),
  });
  wireNetworkToBroker(provider, broker);
  registry.register(provider);
  await provider.start();

  return { contacts, provider, peerId: peer.peerId };
}

function fakeProvider(opts: {
  peerId: string;
  respond: (nonceHex: string) => Promise<string>;
}): NetworkProvider {
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
        skills: ["contacts.signChallenge"],
        name: "fake",
        peerId: opts.peerId,
      },
    ],
    sendTask: async (_peer: NetworkPeer, task: TaskRequest): Promise<TaskResult> => {
      const nonce = (task.payload as { nonce: string }).nonce;
      const signature = await opts.respond(nonce);
      return { taskId: task.id, status: "ok", result: { signature } };
    },
    onTask: () => {},
  };
}

async function loadContacts(
  identity: IdentityManager,
  vault: VaultManager,
  respond: (nonceHex: string) => Promise<string>,
): Promise<ContactsApi> {
  const peer = await identity.getOrCreateIdentity();
  const registry = new NetworkRegistry();
  registry.register(fakeProvider({ peerId: peer.peerId, respond }));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "contacts-fake-"));
  return (await loadPlugin(
    CONTACTS_DIR,
    new StorageManager(path.join(root, "storage")),
    new HookRegistry(),
    new TaskBroker(),
    vault,
    identity,
    registry,
  )) as ContactsApi;
}

test("challenge-response roundtrip verifies a real peer end-to-end", async () => {
  const nodeA = await bootNode();
  const nodeB = await bootNode();
  try {
    await nodeA.contacts.addContact({
      peerId: nodeB.peerId,
      publicKeyHex: nodeB.peerId,
      displayName: "B",
    });

    await waitFor(() => {
      const peers = nodeA.provider.listPeers?.() ?? [];
      return peers.some((p) => p.peerId === nodeB.peerId) ? true : null;
    });

    const result = await nodeA.contacts.verifyPeer({ peerId: nodeB.peerId });
    assert.equal(result.verified, true);

    const listed = await nodeA.contacts.listContacts();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].peerId, nodeB.peerId);
    assert.equal(listed[0].trustState, "verified");
  } finally {
    await nodeA.provider.stop();
    await nodeB.provider.stop();
  }
});

test("a tampered signature is rejected and leaves trustState pending", async () => {
  const { identity, vault } = await makeIdentity();
  const peer = await identity.getOrCreateIdentity();

  const contacts = await loadContacts(identity, vault, async (nonceHex) => {
    // A correct signature, then corrupted in transit before verification.
    const sig = await identity.sign(
      challengeMessage(Buffer.from(nonceHex, "hex")),
    );
    sig[0] ^= 0xff;
    return sig.toString("hex");
  });

  await contacts.addContact({
    peerId: peer.peerId,
    publicKeyHex: peer.peerId,
    displayName: "peer",
  });

  const result = await contacts.verifyPeer({ peerId: peer.peerId });
  assert.equal(result.verified, false);
  assert.equal((await contacts.listContacts())[0].trustState, "pending");
});

test("exposing contacts.signChallenge without the manifest permission fails activation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "contacts-noperm-"));
  const pluginDir = path.join(root, "contacts");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "manifest.json"),
    JSON.stringify({
      id: "contacts",
      version: "0.1.0",
      kind: "generic",
      permissions: [],
      entry: "./index.mjs",
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.mjs"),
    `export default function activate(ctx) {
      ctx.skills.register("signChallenge", async () => ({}), { localOnly: false });
      return {};
    }`,
  );

  await assert.rejects(
    () =>
      loadPlugin(
        pluginDir,
        new StorageManager(path.join(root, "storage")),
        new HookRegistry(),
        new TaskBroker(),
      ),
    /network:skill:contacts\.signChallenge/,
  );
});

test("a bare signature over the nonce (no domain context) is rejected", async () => {
  const { identity, vault } = await makeIdentity();
  const peer = await identity.getOrCreateIdentity();

  const contacts = await loadContacts(identity, vault, async (nonceHex) => {
    // Sign ONLY the nonce, omitting the CHALLENGE_CONTEXT prefix — exactly
    // what a signature oracle would be tricked into producing. verifyPeer
    // verifies against CONTEXT || nonce, so this must be rejected.
    return (await identity.sign(Buffer.from(nonceHex, "hex"))).toString("hex");
  });

  await contacts.addContact({
    peerId: peer.peerId,
    publicKeyHex: peer.peerId,
    displayName: "peer",
  });

  const result = await contacts.verifyPeer({ peerId: peer.peerId });
  assert.equal(result.verified, false);
  assert.equal((await contacts.listContacts())[0].trustState, "pending");
});
