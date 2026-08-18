import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  HookRegistry,
  NetworkRegistry,
  StorageManager,
  TaskBroker,
  VaultManager,
  loadPlugin,
  verifyIdentitySignature,
} from "@p2p-hub/core";
import type {
  NetworkPeer,
  NetworkProvider,
  TaskRequest,
  TaskResult,
} from "@p2p-hub/sdk";
import type { ChatPlugin } from "./index";

const pluginDir = path.resolve(__dirname, "..");

// Pinned here on purpose: if the plugin ever changes its signing context or
// canonical field order, this test must be updated alongside it.
const MESSAGE_CONTEXT = "p2p-hub:chat:message:v1:";

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

function hex64(): string {
  return crypto.randomBytes(32).toString("hex");
}

interface CapturedSend {
  task?: TaskRequest;
}

function fakeProvider(peerId: string, capture?: CapturedSend): NetworkProvider {
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
        skills: ["chat.receiveMessage"],
        peerId,
      },
    ],
    sendTask: async (_peer: NetworkPeer, task: TaskRequest): Promise<TaskResult> => {
      if (capture) {
        capture.task = task;
      }
      return { taskId: task.id, status: "ok", result: { received: true, verified: true } };
    },
    onTask: () => {},
  };
}

async function loadChat(targetPeerId?: string): Promise<{
  chat: ChatPlugin;
  captured?: CapturedSend;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-data-"));
  const vault = new VaultManager({
    dataDir: path.join(dataDir, "vault"),
    masterKey: "test-master",
  });
  let registry: NetworkRegistry | null = null;
  let captured: CapturedSend | undefined;
  if (targetPeerId) {
    registry = new NetworkRegistry();
    captured = {};
    registry.register(fakeProvider(targetPeerId, captured));
  }
  const chat = (await loadPlugin(
    pluginDir,
    new StorageManager(dataDir),
    new HookRegistry(),
    new TaskBroker(),
    vault,
    undefined,
    registry,
  )) as ChatPlugin;
  return { chat, captured };
}

test("sendMessage signs the exact canonical form and stores a verified message", async () => {
  const target = hex64();
  const { chat, captured } = await loadChat(target);

  const sent = await chat.sendMessage({ toPeerId: target, text: "hello" });

  assert.equal(sent.verified, true);
  assert.equal(sent.toPeerId, target);
  assert.equal(sent.text, "hello");
  assert.match(sent.fromPeerId, /^[0-9a-f]{64}$/);
  assert.match(sent.signature, /^[0-9a-f]+$/);

  // The signature must verify against the canonical form (key order pinned).
  const good = verifyIdentitySignature(
    sent.fromPeerId,
    signBuffer({ toPeerId: target, text: "hello", sentAt: sent.sentAt }),
    Buffer.from(sent.signature, "hex"),
  );
  assert.equal(good, true);

  // The same logical fields in a different key order must NOT verify.
  const reordered = Buffer.concat([
    Buffer.from(MESSAGE_CONTEXT, "utf8"),
    Buffer.from(
      JSON.stringify({ text: "hello", sentAt: sent.sentAt, toPeerId: target }),
      "utf8",
    ),
  ]);
  const bad = verifyIdentitySignature(
    sent.fromPeerId,
    reordered,
    Buffer.from(sent.signature, "hex"),
  );
  assert.equal(bad, false);

  // The outgoing task carried the right skill and payload.
  const capturedTask = captured?.task;
  assert.ok(capturedTask, "sendTask should have been invoked");
  assert.equal(capturedTask.skill, "chat.receiveMessage");
  const message = (capturedTask.payload as { message: { fromPeerId: string } })
    .message;
  assert.equal(message.fromPeerId, sent.fromPeerId);

  // Own copy is stored, trusted, and indexed.
  const thread = await chat.getThread(target);
  assert.equal(thread.length, 1);
  assert.equal(thread[0].verified, true);
  assert.equal(thread[0].text, "hello");

  const threads = await chat.listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].peerId, target);
  assert.equal(threads[0].messageCount, 1);
});

test("sendMessage includes an action reference in the signed canonical form", async () => {
  const target = hex64();
  const { chat } = await loadChat(target);

  const action = { $ref: crypto.randomUUID() };
  const sent = await chat.sendMessage({ toPeerId: target, text: "do", action });

  assert.deepEqual(sent.action, action);
  const good = verifyIdentitySignature(
    sent.fromPeerId,
    signBuffer({ toPeerId: target, text: "do", sentAt: sent.sentAt, action }),
    Buffer.from(sent.signature, "hex"),
  );
  assert.equal(good, true);
});

test("canonical serialization is NFC-normalized so composed and decomposed text agree", async () => {
  const target = hex64();
  const { chat } = await loadChat(target);

  const nfc = "caf\u00e9"; // "café" — precomposed é (U+00E9)
  const nfd = "cafe\u0301"; // same text — decomposed e + combining acute (U+0301)
  assert.notEqual(nfc, nfd, "the two input forms must actually differ");
  assert.equal(nfc.normalize("NFC"), nfd.normalize("NFC"));

  // Send the *decomposed* form. The plugin must sign the NFC-normalized
  // canonical bytes, not the raw NFD bytes it was given.
  const sent = await chat.sendMessage({ toPeerId: target, text: nfd });
  assert.equal(sent.text, nfd, "stored text stays exactly as typed");

  const againstNfc = verifyIdentitySignature(
    sent.fromPeerId,
    signBuffer({ toPeerId: target, text: nfc, sentAt: sent.sentAt }),
    Buffer.from(sent.signature, "hex"),
  );
  assert.equal(againstNfc, true, "signature must verify against the NFC form");

  // Regression guard: without normalization, the NFD bytes would not match.
  // Build the raw (non-normalized) canonical bytes directly to prove the
  // plugin actually normalized before signing.
  const rawNfd = Buffer.concat([
    Buffer.from(MESSAGE_CONTEXT, "utf8"),
    Buffer.from(
      JSON.stringify({ toPeerId: target, text: nfd, sentAt: sent.sentAt }),
      "utf8",
    ),
  ]);
  const againstNfd = verifyIdentitySignature(
    sent.fromPeerId,
    rawNfd,
    Buffer.from(sent.signature, "hex"),
  );
  assert.equal(
    againstNfd,
    false,
    "signature must NOT verify against the raw decomposed form",
  );
});

test("sendMessage rejects malformed input", async () => {
  const target = hex64();
  const { chat } = await loadChat(target);

  await assert.rejects(
    chat.sendMessage({ toPeerId: "not-hex", text: "hi" }),
    /hex64/,
  );
  await assert.rejects(chat.sendMessage({ toPeerId: target, text: "" }), /non-empty/);
  await assert.rejects(
    chat.sendMessage({ toPeerId: target, text: "hi", action: {} as never }),
    /PBX/,
  );
});

test("sendMessage reports a missing network provider gracefully", async () => {
  const { chat } = await loadChat();
  await assert.rejects(
    chat.sendMessage({ toPeerId: hex64(), text: "hi" }),
    /no network provider available/,
  );
});
