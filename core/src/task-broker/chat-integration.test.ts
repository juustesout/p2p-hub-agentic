import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NetworkLightProvider } from "@p2p-hub/network-light";
import { wireNetworkToBroker } from "./wire-network";
import { TaskBroker } from "./task-broker";
import { IdentityManager } from "../identity/identity-manager";
import { NetworkRegistry } from "../network-registry";
import { StorageManager } from "../storage/storage-manager";
import { HookRegistry } from "../hooks/hook-registry";
import { VaultManager } from "../storage/vault-manager";
import { loadPlugin } from "../plugin-loader/plugin-loader";

const CHAT_DIR = path.resolve(__dirname, "../../../plugins/chat");
const CONTACTS_DIR = path.resolve(__dirname, "../../../plugins/contacts");

// Pinned on purpose: if chat's signing context or canonical field order ever
// changes, these tests are the regression guard.
const MESSAGE_CONTEXT = "p2p-hub:chat:message:v1:";
const CONTACTS_CHALLENGE_CONTEXT = "p2p-hub:contacts:challenge:v1:";

interface ChatApi {
  sendMessage(input: {
    toPeerId: string;
    text: string;
    action?: { $ref: string };
  }): Promise<{
    fromPeerId: string;
    toPeerId: string;
    text: string;
    sentAt: string;
    signature: string;
    verified: boolean;
  }>;
  listThreads(): Promise<
    Array<{ peerId: string; lastMessageAt: string; messageCount: number }>
  >;
  getThread(peerId: string): Promise<
    Array<{
      fromPeerId: string;
      toPeerId: string;
      text: string;
      verified: boolean;
      signature: string;
    }>
  >;
}

interface ContactsApi {
  addContact(input: {
    peerId: string;
    publicKeyHex: string;
    displayName: string;
  }): Promise<{ peerId: string; trustState: string }>;
  listContacts(): Promise<Array<{ peerId: string; trustState: string }>>;
}

function canonical(fields: {
  toPeerId: string;
  text: string;
  sentAt: string;
  action?: { $ref: string };
}): string {
  const obj: Record<string, unknown> = {
    toPeerId: fields.toPeerId,
    text: fields.text.normalize("NFC"),
    sentAt: fields.sentAt,
  };
  if (fields.action !== undefined) {
    obj.action = fields.action;
  }
  return JSON.stringify(obj);
}

function signBuffer(fields: {
  toPeerId: string;
  text: string;
  sentAt: string;
  action?: { $ref: string };
}): Buffer {
  return Buffer.concat([
    Buffer.from(MESSAGE_CONTEXT, "utf8"),
    Buffer.from(canonical(fields), "utf8"),
  ]);
}

async function waitFor<T>(
  check: () => T | null | undefined,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null | undefined;
  while (Date.now() < deadline) {
    last = check();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function makeIdentity(): Promise<{ identity: IdentityManager; peerId: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-identity-"));
  const vault = new VaultManager({
    dataDir: path.join(dir, "vault"),
    masterKey: "test-master",
  });
  const identity = new IdentityManager({ vault });
  const peerId = (await identity.getOrCreateIdentity()).peerId;
  return { identity, peerId };
}

/** Boot a node with contacts + chat sharing storage/broker (no networking). */
async function bootReceiver(): Promise<{
  chat: ChatApi;
  contacts: ContactsApi;
  broker: TaskBroker;
  peerId: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-recv-"));
  const vault = new VaultManager({
    dataDir: path.join(root, "vault"),
    masterKey: "test-master",
  });
  const identity = new IdentityManager({ vault });
  const peerId = (await identity.getOrCreateIdentity()).peerId;

  const storage = new StorageManager(path.join(root, "storage"));
  const broker = new TaskBroker();
  const registry = new NetworkRegistry();

  const contacts = (await loadPlugin(
    CONTACTS_DIR,
    storage,
    new HookRegistry(),
    broker,
    vault,
    identity,
    registry,
  )) as ContactsApi;
  const chat = (await loadPlugin(
    CHAT_DIR,
    storage,
    new HookRegistry(),
    broker,
    vault,
    identity,
    registry,
  )) as ChatApi;

  return { chat, contacts, broker, peerId };
}

async function deliver(
  broker: TaskBroker,
  message: unknown,
): Promise<{ status: string; error?: string; result?: unknown }> {
  return broker.handle({
    id: crypto.randomUUID(),
    skill: "chat.receiveMessage",
    payload: { message },
  });
}

test("a known sender's message verifies only under the exact canonical serialization", async () => {
  const receiver = await bootReceiver();
  const sender = await makeIdentity();

  await receiver.contacts.addContact({
    peerId: sender.peerId,
    publicKeyHex: sender.peerId,
    displayName: "S",
  });

  const fields = {
    toPeerId: receiver.peerId,
    text: "hello",
    sentAt: "2026-08-18T00:00:00.000Z",
  };
  const signature = (await sender.identity.sign(signBuffer(fields))).toString("hex");
  const message = { fromPeerId: sender.peerId, ...fields, signature };

  const result = await deliver(receiver.broker, message);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.result, { received: true, verified: true });

  const thread = await receiver.chat.getThread(sender.peerId);
  assert.equal(thread.length, 1);
  assert.equal(thread[0].verified, true);
  assert.equal(thread[0].text, "hello");

  // Regression: the same logical content signed in a different key order must
  // be rejected as an invalid signature (canonical form is order-sensitive).
  const reordered = Buffer.concat([
    Buffer.from(MESSAGE_CONTEXT, "utf8"),
    Buffer.from(
      JSON.stringify({ text: "hello", sentAt: fields.sentAt, toPeerId: fields.toPeerId }),
      "utf8",
    ),
  ]);
  const wrongSignature = (
    await sender.identity.sign(reordered)
  ).toString("hex");
  const badMessage = { ...message, signature: wrongSignature };

  const badResult = await deliver(receiver.broker, badMessage);
  assert.equal(badResult.status, "error");
  assert.match(badResult.error ?? "", /invalid signature/);

  // Nothing new was stored by the rejected message.
  assert.equal((await receiver.chat.getThread(sender.peerId)).length, 1);
});

test("a message from an unknown sender is stored with verified:false, never dropped", async () => {
  const receiver = await bootReceiver();
  const sender = await makeIdentity();

  const fields = {
    toPeerId: receiver.peerId,
    text: "stranger",
    sentAt: new Date().toISOString(),
  };
  const signature = (await sender.identity.sign(signBuffer(fields))).toString("hex");
  const message = { fromPeerId: sender.peerId, ...fields, signature };

  const result = await deliver(receiver.broker, message);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.result, { received: true, verified: false });

  const thread = await receiver.chat.getThread(sender.peerId);
  assert.equal(thread.length, 1);
  assert.equal(thread[0].verified, false);
  assert.equal(thread[0].text, "stranger");
});

test("a known sender's invalid signature is hard-rejected and not stored", async () => {
  const receiver = await bootReceiver();
  const sender = await makeIdentity();

  await receiver.contacts.addContact({
    peerId: sender.peerId,
    publicKeyHex: sender.peerId,
    displayName: "S",
  });

  const fields = {
    toPeerId: receiver.peerId,
    text: "forged",
    sentAt: new Date().toISOString(),
  };
  const signature = (await sender.identity.sign(signBuffer(fields))).toString("hex");
  const corrupted = (signature[0] === "0" ? "1" : "0") + signature.slice(1);
  const message = { fromPeerId: sender.peerId, ...fields, signature: corrupted };

  const result = await deliver(receiver.broker, message);
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /invalid signature/);
  assert.equal((await receiver.chat.getThread(sender.peerId)).length, 0);
});

test("a contacts challenge-response signature cannot be replayed as a chat message", async () => {
  const receiver = await bootReceiver();
  const sender = await makeIdentity();

  await receiver.contacts.addContact({
    peerId: sender.peerId,
    publicKeyHex: sender.peerId,
    displayName: "S",
  });

  // What a signChallenge oracle would hand out: a signature over its own
  // domain-separated context, not chat's.
  const challengeSig = (
    await sender.identity.sign(
      Buffer.concat([Buffer.from(CONTACTS_CHALLENGE_CONTEXT, "utf8"), Buffer.alloc(32)]),
    )
  ).toString("hex");

  const message = {
    fromPeerId: sender.peerId,
    toPeerId: receiver.peerId,
    text: "replay",
    sentAt: new Date().toISOString(),
    signature: challengeSig,
  };

  const result = await deliver(receiver.broker, message);
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /invalid signature/);
});

test("a message addressed to a different peer is rejected", async () => {
  const receiver = await bootReceiver();
  const sender = await makeIdentity();

  await receiver.contacts.addContact({
    peerId: sender.peerId,
    publicKeyHex: sender.peerId,
    displayName: "S",
  });

  const fields = {
    toPeerId: "f".repeat(64),
    text: "wrong target",
    sentAt: new Date().toISOString(),
  };
  const signature = (await sender.identity.sign(signBuffer(fields))).toString("hex");
  const message = { fromPeerId: sender.peerId, ...fields, signature };

  const result = await deliver(receiver.broker, message);
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /not addressed/);
});

test("receiveMessage is network-exposed; sendMessage and friends are local-only", async () => {
  const receiver = await bootReceiver();
  const skills = receiver.broker.listSkills();

  const receive = skills.find((s) => s.skill === "chat.receiveMessage");
  assert.ok(receive, "chat.receiveMessage should be registered");
  assert.equal(receive.localOnly, false);
  assert.equal(receive.httpExposed, false);

  for (const name of ["chat.sendMessage", "chat.listThreads", "chat.getThread"]) {
    const skill = skills.find((s) => s.skill === name);
    assert.ok(skill, `${name} should be registered`);
    assert.equal(skill.localOnly, true);
  }
});

/** Boot a node with contacts + chat and a real network-light provider. */
async function bootNode(): Promise<{
  chat: ChatApi;
  contacts: ContactsApi;
  provider: NetworkLightProvider;
  peerId: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-node-"));
  const vault = new VaultManager({
    dataDir: path.join(root, "vault"),
    masterKey: "test-master",
  });
  const identity = new IdentityManager({ vault });
  const peer = await identity.getOrCreateIdentity();

  const storage = new StorageManager(path.join(root, "storage"));
  const broker = new TaskBroker();
  const registry = new NetworkRegistry();

  const contacts = (await loadPlugin(
    CONTACTS_DIR,
    storage,
    new HookRegistry(),
    broker,
    vault,
    identity,
    registry,
  )) as ContactsApi;
  const chat = (await loadPlugin(
    CHAT_DIR,
    storage,
    new HookRegistry(),
    broker,
    vault,
    identity,
    registry,
  )) as ChatApi;

  const provider = new NetworkLightProvider({
    port: 0,
    skills: ["contacts.signChallenge", "chat.receiveMessage"],
    identity: peer,
  });
  wireNetworkToBroker(provider, broker);
  registry.register(provider);
  await provider.start();

  return { chat, contacts, provider, peerId: peer.peerId };
}

test("two hosts exchange a verified signed message end-to-end", async () => {
  const nodeA = await bootNode();
  const nodeB = await bootNode();
  try {
    await nodeA.contacts.addContact({
      peerId: nodeB.peerId,
      publicKeyHex: nodeB.peerId,
      displayName: "B",
    });
    await nodeB.contacts.addContact({
      peerId: nodeA.peerId,
      publicKeyHex: nodeA.peerId,
      displayName: "A",
    });

    await waitFor(() =>
      nodeA.provider
        .listPeers?.()
        .some((p) => p.peerId === nodeB.peerId)
        ? true
        : null,
    );

    const sent = await nodeA.chat.sendMessage({ toPeerId: nodeB.peerId, text: "hi B" });
    assert.equal(sent.verified, true);
    assert.equal(sent.fromPeerId, nodeA.peerId);

    const bThread = await nodeB.chat.getThread(nodeA.peerId);
    assert.equal(bThread.length, 1);
    assert.equal(bThread[0].text, "hi B");
    assert.equal(bThread[0].verified, true);
    assert.equal(bThread[0].fromPeerId, nodeA.peerId);
  } finally {
    await nodeA.provider.stop();
    await nodeB.provider.stop();
  }
});
