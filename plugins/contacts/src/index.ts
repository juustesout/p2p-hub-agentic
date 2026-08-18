import * as crypto from "node:crypto";
import type { PluginContext } from "@p2p-hub/core";
import {
  addObject,
  createDocument,
  isPBXDocument,
  linkObject,
  resolveRef,
  rootObject,
  type PBXDocument,
  type PBXObject,
  type PBXReference,
} from "@p2p-hub/sdk";

/**
 * P2P identity registry.
 *
 * A `peerId` (a persistent Ed25519 public key) proves nothing by itself — anyone
 * can claim to *be* `peerId` X. This plugin turns a stored contact into a
 * proof-of-possession relationship: `verifyPeer` runs a challenge-response
 * against the peer's `contacts.signChallenge` skill, and only promotes the
 * contact to `trustState: "verified"` when the returned signature verifies
 * against the stored public key. That still is not "this is really Jan" — real
 * identity remains a human/pairing-UX concern — but it closes the trivial
 * spoof ("I happen to claim your peerId") hole.
 *
 * `signChallenge` is the single network-exposed skill (`localOnly: false`) and
 * deliberately signs a *domain-separated* message, never attacker-chosen bytes.
 */

export type TrustState = "pending" | "verified" | "blocked";

/** A contact as exposed by the plugin API (a `P2P.Contact` object's fields). */
export interface ContactRecord {
  peerId: string;
  publicKeyHex: string;
  displayName: string;
  addedAt: string;
  trustState: TrustState;
  lastVerifiedAt?: string;
}

export interface AddContactInput {
  peerId: string;
  publicKeyHex: string;
  displayName: string;
}

export interface VerifyPeerInput {
  peerId: string;
}

export interface VerifyResult {
  verified: boolean;
  /** Present only when verification did not succeed. Never contains secrets. */
  error?: string;
}

export interface ContactsPlugin {
  addContact(input: AddContactInput): Promise<ContactRecord>;
  listContacts(): Promise<ContactRecord[]>;
  removeContact(peerId: string): Promise<boolean>;
  verifyPeer(input: VerifyPeerInput): Promise<VerifyResult>;
}

const CONTACT_BOOK_CLASS = "P2P.ContactBook";
const CONTACT_CLASS = "P2P.Contact";
const BOOK_KEY = "contactBook";

/**
 * Domain-separation context. `signChallenge` signs exactly this prefix plus the
 * caller-supplied nonce — never arbitrary bytes. A signature produced here can
 * therefore never be replayed as a valid signature in another context (a
 * future protocol, a payment, …). `verifyPeer` must use the exact same prefix.
 */
const CHALLENGE_CONTEXT = "p2p-hub:contacts:challenge:v1:";

/** Loader-prefixed skill name (`<pluginId>.signChallenge`). */
const SIGN_CHALLENGE_SKILL = "contacts.signChallenge";

const PEER_ID_RE = /^[0-9a-f]{64}$/;

function challengeMessage(nonce: Buffer): Buffer {
  return Buffer.concat([Buffer.from(CHALLENGE_CONTEXT, "utf8"), nonce]);
}

export default function activate(ctx: PluginContext): ContactsPlugin {
  function newBook(): PBXDocument {
    return createDocument(CONTACT_BOOK_CLASS, { contacts: [] });
  }

  async function loadBook(): Promise<PBXDocument> {
    const stored = await ctx.storage.get(BOOK_KEY);
    return isPBXDocument(stored) ? stored : newBook();
  }

  async function saveBook(book: PBXDocument): Promise<void> {
    await ctx.storage.set(BOOK_KEY, book);
  }

  function contactRefs(book: PBXDocument): PBXReference[] {
    const root = rootObject(book);
    const refs = root?.contacts;
    return Array.isArray(refs) ? (refs as PBXReference[]) : [];
  }

  function findContact(book: PBXDocument, peerId: string): PBXObject | null {
    for (const ref of contactRefs(book)) {
      const obj = resolveRef(book, ref);
      if (obj && obj.peerId === peerId) {
        return obj;
      }
    }
    return null;
  }

  function listContactObjects(book: PBXDocument): PBXObject[] {
    const out: PBXObject[] = [];
    for (const ref of contactRefs(book)) {
      const obj = resolveRef(book, ref);
      if (obj) {
        out.push(obj);
      }
    }
    return out;
  }

  function toRecord(obj: PBXObject): ContactRecord {
    return {
      peerId: String(obj.peerId),
      publicKeyHex: String(obj.publicKeyHex),
      displayName: String(obj.displayName),
      addedAt: String(obj.addedAt),
      trustState: obj.trustState as TrustState,
      ...(obj.lastVerifiedAt !== undefined
        ? { lastVerifiedAt: String(obj.lastVerifiedAt) }
        : {}),
    };
  }

  async function addContact(input: AddContactInput): Promise<ContactRecord> {
    const { peerId, publicKeyHex, displayName } = (input ?? {}) as {
      peerId?: unknown;
      publicKeyHex?: unknown;
      displayName?: unknown;
    };
    if (
      typeof peerId !== "string" ||
      typeof publicKeyHex !== "string" ||
      typeof displayName !== "string"
    ) {
      throw new Error(
        "addContact expects { peerId: string, publicKeyHex: string, displayName: string }",
      );
    }
    // A peerId is a 64-char hex Ed25519 public key. Reject garbage at the door.
    if (!PEER_ID_RE.test(peerId)) {
      throw new Error("addContact: peerId must be a 64-char hex Ed25519 public key");
    }
    // In the identity layer peerId and publicKeyHex are the same value; a
    // mismatch is a trivially spoofed/invalid pair — reject it immediately.
    if (publicKeyHex !== peerId) {
      throw new Error("addContact: publicKeyHex does not match peerId");
    }

    const book = await loadBook();
    const existing = findContact(book, peerId);
    if (existing) {
      // Idempotent re-add: refresh the label, keep the established trust state.
      existing.displayName = displayName;
      await saveBook(book);
      return toRecord(existing);
    }

    const contactId = addObject(book, CONTACT_CLASS, {
      peerId,
      publicKeyHex,
      displayName,
      addedAt: new Date().toISOString(),
      trustState: "pending",
    });
    const root = rootObject(book);
    const refs = contactRefs(book);
    refs.push(linkObject(book, contactId));
    if (root) {
      root.contacts = refs;
    }
    await saveBook(book);
    return toRecord(book.$objects[contactId]);
  }

  async function listContacts(): Promise<ContactRecord[]> {
    const book = await loadBook();
    return listContactObjects(book).map(toRecord);
  }

  async function removeContact(peerId: string): Promise<boolean> {
    const book = await loadBook();
    const refs = contactRefs(book);
    const idx = refs.findIndex((ref) => resolveRef(book, ref)?.peerId === peerId);
    if (idx === -1) {
      return false;
    }
    const removed = resolveRef(book, refs[idx]);
    if (removed) {
      delete book.$objects[removed.$id];
    }
    const root = rootObject(book);
    if (root) {
      root.contacts = refs.filter((_, i) => i !== idx);
    }
    await saveBook(book);
    return true;
  }

  async function verifyPeer(input: VerifyPeerInput): Promise<VerifyResult> {
    const { peerId } = (input ?? {}) as { peerId?: unknown };
    if (typeof peerId !== "string") {
      return { verified: false, error: "verifyPeer expects { peerId: string }" };
    }
    if (!ctx.network) {
      return { verified: false, error: "no network provider available" };
    }

    const book = await loadBook();
    const contact = findContact(book, peerId);
    if (!contact) {
      return { verified: false, error: `contact "${peerId}" not found` };
    }

    const nonce = crypto.randomBytes(32);
    const result = await ctx.network.sendTask(peerId, {
      id: crypto.randomUUID(),
      skill: SIGN_CHALLENGE_SKILL,
      payload: { nonce: nonce.toString("hex") },
    });

    if (result.status !== "ok") {
      return { verified: false, error: result.error ?? "peer did not respond" };
    }
    const signature = (result.result as { signature?: unknown } | undefined)
      ?.signature;
    if (typeof signature !== "string") {
      return { verified: false, error: "peer returned no signature" };
    }

    const valid = ctx.identity.verify(
      String(contact.publicKeyHex),
      challengeMessage(nonce),
      Buffer.from(signature, "hex"),
    );
    if (!valid) {
      return { verified: false, error: "signature verification failed" };
    }

    contact.trustState = "verified";
    contact.lastVerifiedAt = new Date().toISOString();
    await saveBook(book);
    return { verified: true };
  }

  ctx.skills.register("addContact", async (payload) => addContact(payload as AddContactInput), {
    localOnly: true,
  });

  ctx.skills.register("listContacts", async () => listContacts(), {
    localOnly: true,
  });

  ctx.skills.register("removeContact", async (payload) => {
    const { peerId } = (payload ?? {}) as { peerId?: unknown };
    if (typeof peerId !== "string") {
      throw new Error("removeContact expects { peerId: string }");
    }
    return removeContact(peerId);
  }, {
    localOnly: true,
  });

  ctx.skills.register("verifyPeer", async (payload) => verifyPeer(payload as VerifyPeerInput), {
    localOnly: true,
  });

  // The only network-reachable skill: a peer invokes it to prove possession of
  // the private key behind its advertised peerId. Requires the manifest
  // permission `network:skill:contacts.signChallenge`.
  ctx.skills.register(
    "signChallenge",
    async (payload) => {
      const { nonce } = (payload ?? {}) as { nonce?: unknown };
      if (typeof nonce !== "string" || nonce.length === 0 || !/^[0-9a-f]+$/.test(nonce)) {
        throw new Error("signChallenge expects { nonce: string(hex) }");
      }
      // Domain separation: sign CONTEXT || nonce, never caller-chosen bytes.
      const signature = await ctx.identity.sign(
        challengeMessage(Buffer.from(nonce, "hex")),
      );
      return { signature: signature.toString("hex") };
    },
    { localOnly: false },
  );

  return { addContact, listContacts, removeContact, verifyPeer };
}
