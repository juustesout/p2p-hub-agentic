import * as crypto from "node:crypto";
import type { PluginContext } from "@p2p-hub/core";
import {
  addObject,
  createDocument,
  isPBXDocument,
  isPBXReference,
  linkObject,
  resolveRef,
  rootObject,
  type PBXDocument,
  type PBXObject,
  type PBXReference,
} from "@p2p-hub/sdk";

/**
 * P2P chat — signed 1-op-1 messaging over the network capability.
 *
 * A message is a PBX `P2P.ChatMessage` filed inside a `P2P.ChatThread`, one
 * thread per remote peer (there are no group chats). `sendMessage` signs a
 * domain-separated canonical form of the message and delivers it to the peer's
 * `chat.receiveMessage` skill; the receiver verifies that signature against
 * the sender's public key *if the sender is a known contact*, and stores the
 * result with `verified` accordingly.
 *
 * Embedded `action` references are pure data: they are stored and surfaced,
 * but never executed by this plugin. Executing an action is a human decision,
 * made elsewhere.
 */

const INDEX_CLASS = "P2P.ChatIndex";
const THREAD_CLASS = "P2P.ChatThread";
const MESSAGE_CLASS = "P2P.ChatMessage";
const INDEX_KEY = "chatIndex";

/**
 * Domain-separation context. A chat signature is computed over exactly this
 * prefix plus the canonical message bytes, so a signature valid here can never
 * be replayed as valid in another protocol (contacts challenge-response, …).
 * `receiveMessage` must reconstruct the exact same buffer to verify.
 */
const MESSAGE_CONTEXT = "p2p-hub:chat:message:v1:";

/** Loader-prefixed skill name (`<pluginId>.receiveMessage`). */
const RECEIVE_SKILL = "chat.receiveMessage";

/** The contacts plugin is the single source of truth for known peers. */
const CONTACTS_PLUGIN_ID = "contacts";
const CONTACTS_BOOK_KEY = "contactBook";

const PEER_ID_RE = /^[0-9a-f]{64}$/;
const SIGNATURE_RE = /^[0-9a-f]+$/;

/** A stored message as exposed by the plugin API. */
export interface ChatMessageRecord {
  fromPeerId: string;
  toPeerId: string;
  text: string;
  sentAt: string;
  /** Optional OLE reference to an action; display-only, never executed. */
  action?: PBXReference;
  /** Hex signature over `MESSAGE_CONTEXT || canonicalMessage(...)`. */
  signature: string;
  /** Set by the receiver; own outbound messages are always `true`. */
  verified: boolean;
}

export interface SendMessageInput {
  toPeerId: string;
  text: string;
  action?: PBXReference;
}

export interface ThreadSummary {
  peerId: string;
  lastMessageAt: string;
  messageCount: number;
}

export interface ChatPlugin {
  sendMessage(input: SendMessageInput): Promise<ChatMessageRecord>;
  listThreads(): Promise<ThreadSummary[]>;
  getThread(peerId: string): Promise<ChatMessageRecord[]>;
}

/**
 * The canonical signed payload, byte-for-byte. Field order is significant:
 * sender and receiver must build this object with the exact same key order or
 * the signature will not verify. `action` is included only when present.
 */
function canonicalMessage(fields: {
  toPeerId: string;
  text: string;
  sentAt: string;
  action?: PBXReference;
}): string {
  const obj: Record<string, unknown> = {
    toPeerId: fields.toPeerId,
    // Normalize to NFC before serializing so visually identical text typed on
    // different OS/keyboard layouts (composed vs decomposed accents) yields the
    // same canonical bytes and does not spuriously fail signature verification.
    text: fields.text.normalize("NFC"),
    sentAt: fields.sentAt,
  };
  if (fields.action !== undefined) {
    obj.action = fields.action;
  }
  return JSON.stringify(obj);
}

/** The full buffer signed by `sendMessage` and verified by `receiveMessage`. */
function signBuffer(fields: {
  toPeerId: string;
  text: string;
  sentAt: string;
  action?: PBXReference;
}): Buffer {
  return Buffer.concat([
    Buffer.from(MESSAGE_CONTEXT, "utf8"),
    Buffer.from(canonicalMessage(fields), "utf8"),
  ]);
}

interface WireMessage {
  fromPeerId: string;
  toPeerId: string;
  text: string;
  sentAt: string;
  action?: PBXReference;
  signature: string;
}

export default function activate(ctx: PluginContext): ChatPlugin {
  function newIndex(): PBXDocument {
    return createDocument(INDEX_CLASS, { threads: [] });
  }

  async function loadIndex(): Promise<PBXDocument> {
    const stored = await ctx.storage.get(INDEX_KEY);
    return isPBXDocument(stored) ? stored : newIndex();
  }

  async function saveIndex(doc: PBXDocument): Promise<void> {
    await ctx.storage.set(INDEX_KEY, doc);
  }

  function threadRefs(doc: PBXDocument): PBXReference[] {
    const refs = rootObject(doc)?.threads;
    return Array.isArray(refs) ? (refs as PBXReference[]) : [];
  }

  function findThread(doc: PBXDocument, peerId: string): PBXObject | null {
    for (const ref of threadRefs(doc)) {
      const obj = resolveRef(doc, ref);
      if (obj && obj.peerId === peerId) {
        return obj;
      }
    }
    return null;
  }

  function messageRefs(thread: PBXObject): PBXReference[] {
    const refs = thread.messages;
    return Array.isArray(refs) ? (refs as PBXReference[]) : [];
  }

  function messageToRecord(obj: PBXObject): ChatMessageRecord {
    const record: ChatMessageRecord = {
      fromPeerId: String(obj.fromPeerId),
      toPeerId: String(obj.toPeerId),
      text: String(obj.text),
      sentAt: String(obj.sentAt),
      signature: String(obj.signature),
      verified: obj.verified === true,
    };
    if (isPBXReference(obj.action)) {
      record.action = obj.action;
    }
    return record;
  }

  /** Append a message to the thread for `peerKey`, creating the thread if needed. */
  async function appendMessage(
    doc: PBXDocument,
    peerKey: string,
    message: WireMessage,
    verified: boolean,
  ): Promise<ChatMessageRecord> {
    let thread = findThread(doc, peerKey);
    if (!thread) {
      const threadId = addObject(doc, THREAD_CLASS, {
        peerId: peerKey,
        messages: [],
      });
      thread = doc.$objects[threadId];
      const root = rootObject(doc);
      const refs = threadRefs(doc);
      refs.push(linkObject(doc, threadId));
      if (root) {
        root.threads = refs;
      }
    }

    const messageId = addObject(doc, MESSAGE_CLASS, {
      fromPeerId: message.fromPeerId,
      toPeerId: message.toPeerId,
      text: message.text,
      sentAt: message.sentAt,
      ...(message.action !== undefined ? { action: message.action } : {}),
      signature: message.signature,
      verified,
    });
    const refs = messageRefs(thread);
    refs.push(linkObject(doc, messageId));
    thread.messages = refs;
    thread.lastMessageAt = message.sentAt;
    return messageToRecord(doc.$objects[messageId]);
  }

  async function sendMessage(input: SendMessageInput): Promise<ChatMessageRecord> {
    const { toPeerId, text, action } = (input ?? {}) as {
      toPeerId?: unknown;
      text?: unknown;
      action?: unknown;
    };
    if (typeof toPeerId !== "string" || !PEER_ID_RE.test(toPeerId)) {
      throw new Error(
        "sendMessage expects { toPeerId: string(hex64), text: string, action?: {$ref} }",
      );
    }
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("sendMessage expects a non-empty text string");
    }
    if (action !== undefined && !isPBXReference(action)) {
      throw new Error("sendMessage: action must be a PBX { $ref } reference");
    }
    if (!ctx.network) {
      throw new Error("sendMessage: no network provider available");
    }

    const fromPeerId = await ctx.identity.peerId();
    const sentAt = new Date().toISOString();
    const fields = {
      toPeerId,
      text,
      sentAt,
      ...(action !== undefined ? { action: action as PBXReference } : {}),
    };
    const signature = (await ctx.identity.sign(signBuffer(fields))).toString(
      "hex",
    );

    const message: WireMessage = {
      fromPeerId,
      ...fields,
      signature,
    };

    // Deliver to the peer. sendTask never throws; it resolves to an error
    // result when the peer is unreachable. Our own copy is stored regardless,
    // and is always trusted because we signed it ourselves.
    await ctx.network.sendTask(toPeerId, {
      id: crypto.randomUUID(),
      skill: RECEIVE_SKILL,
      payload: { message },
    });

    const doc = await loadIndex();
    const record = await appendMessage(doc, toPeerId, message, true);
    await saveIndex(doc);
    return record;
  }

  function validateIncomingMessage(message: unknown): WireMessage {
    const m = (message ?? {}) as Record<string, unknown>;
    if (
      typeof m.fromPeerId !== "string" ||
      !PEER_ID_RE.test(m.fromPeerId) ||
      typeof m.toPeerId !== "string" ||
      !PEER_ID_RE.test(m.toPeerId) ||
      typeof m.text !== "string" ||
      m.text.length === 0 ||
      typeof m.sentAt !== "string" ||
      typeof m.signature !== "string" ||
      !SIGNATURE_RE.test(m.signature)
    ) {
      throw new Error("receiveMessage: malformed message");
    }
    if (m.action !== undefined && !isPBXReference(m.action)) {
      throw new Error("receiveMessage: action must be a PBX reference");
    }
    return {
      fromPeerId: m.fromPeerId,
      toPeerId: m.toPeerId,
      text: m.text,
      sentAt: m.sentAt,
      ...(m.action !== undefined ? { action: m.action as PBXReference } : {}),
      signature: m.signature,
    };
  }

  /**
   * Look up the sender in the contacts book. Returns the stored public key for
   * a known (non-blocked) contact, `"blocked"` for a blocked contact, or `null`
   * for an unknown sender.
   */
  async function findContactPublicKey(
    peerId: string,
  ): Promise<{ publicKeyHex: string } | "blocked" | null> {
    const contacts = ctx.readStorageOf(CONTACTS_PLUGIN_ID);
    if (!contacts) {
      return null;
    }
    const book = await contacts.get(CONTACTS_BOOK_KEY);
    if (!isPBXDocument(book)) {
      return null;
    }
    const refs = rootObject(book)?.contacts;
    const contactRefs = Array.isArray(refs) ? (refs as PBXReference[]) : [];
    for (const ref of contactRefs) {
      const obj = resolveRef(book, ref);
      if (obj && obj.peerId === peerId) {
        if (obj.trustState === "blocked") {
          return "blocked";
        }
        return { publicKeyHex: String(obj.publicKeyHex) };
      }
    }
    return null;
  }

  /**
   * Network-exposed receive handler. A message with an unknown sender or no
   * verifiable identity is kept but flagged `verified: false` — never silently
   * dropped. A known sender whose signature does not verify is a hard reject
   * (not stored), so a spoofed message can't pollute the thread.
   */
  async function receiveMessage(
    payload: unknown,
  ): Promise<{ received: boolean; verified: boolean }> {
    const { message } = (payload ?? {}) as { message?: unknown };
    const msg = validateIncomingMessage(message);

    const localPeerId = await ctx.identity.peerId();
    if (msg.toPeerId !== localPeerId) {
      throw new Error("receiveMessage: message is not addressed to this peer");
    }

    const contact = await findContactPublicKey(msg.fromPeerId);
    if (contact === "blocked") {
      throw new Error("receiveMessage: sender is blocked");
    }

    if (contact === null) {
      const doc = await loadIndex();
      const record = await appendMessage(doc, msg.fromPeerId, msg, false);
      await saveIndex(doc);
      await ctx.hooks.emit("chat:messageReceived", record);
      return { received: true, verified: false };
    }

    const valid = ctx.identity.verify(
      contact.publicKeyHex,
      signBuffer({
        toPeerId: msg.toPeerId,
        text: msg.text,
        sentAt: msg.sentAt,
        ...(msg.action !== undefined ? { action: msg.action } : {}),
      }),
      Buffer.from(msg.signature, "hex"),
    );
    if (!valid) {
      throw new Error("receiveMessage: invalid signature");
    }

    const doc = await loadIndex();
    const record = await appendMessage(doc, msg.fromPeerId, msg, true);
    await saveIndex(doc);
    await ctx.hooks.emit("chat:messageReceived", record);
    return { received: true, verified: true };
  }

  async function listThreads(): Promise<ThreadSummary[]> {
    const doc = await loadIndex();
    const out: ThreadSummary[] = [];
    for (const ref of threadRefs(doc)) {
      const thread = resolveRef(doc, ref);
      if (!thread) {
        continue;
      }
      out.push({
        peerId: String(thread.peerId),
        lastMessageAt: String(thread.lastMessageAt),
        messageCount: messageRefs(thread).length,
      });
    }
    out.sort((a, b) => a.lastMessageAt.localeCompare(b.lastMessageAt));
    return out;
  }

  async function getThread(peerId: string): Promise<ChatMessageRecord[]> {
    if (typeof peerId !== "string" || !PEER_ID_RE.test(peerId)) {
      throw new Error("getThread expects a 64-char hex peerId");
    }
    const doc = await loadIndex();
    const thread = findThread(doc, peerId);
    if (!thread) {
      return [];
    }
    const out: ChatMessageRecord[] = [];
    for (const ref of messageRefs(thread)) {
      const obj = resolveRef(doc, ref);
      if (obj) {
        out.push(messageToRecord(obj));
      }
    }
    out.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    return out;
  }

  ctx.skills.register(
    "sendMessage",
    async (payload) => sendMessage(payload as SendMessageInput),
    { localOnly: true },
  );

  ctx.skills.register("listThreads", async () => listThreads(), {
    localOnly: true,
  });

  ctx.skills.register(
    "getThread",
    async (payload) => {
      const { peerId } = (payload ?? {}) as { peerId?: unknown };
      if (typeof peerId !== "string") {
        throw new Error("getThread expects { peerId: string }");
      }
      return getThread(peerId);
    },
    { localOnly: true },
  );

  // The only network-reachable skill: a peer delivers a signed message here.
  // Requires the manifest permission `network:skill:chat.receiveMessage`.
  ctx.skills.register("receiveMessage", receiveMessage, { localOnly: false });

  return { sendMessage, listThreads, getThread };
}
