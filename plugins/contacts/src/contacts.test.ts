import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadPlugin, StorageManager, HookRegistry } from "@p2p-hub/core";
import type { ContactsPlugin } from "./index";

const pluginDir = path.resolve(__dirname, "..");

const PEER_ID = "a".repeat(64);

async function loadContacts(): Promise<ContactsPlugin> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "contacts-data-"));
  return (await loadPlugin(
    pluginDir,
    new StorageManager(dataDir),
    new HookRegistry(),
  )) as ContactsPlugin;
}

test("addContact stores a matching peerId/publicKeyHex pair as pending", async () => {
  const contacts = await loadContacts();

  const contact = await contacts.addContact({
    peerId: PEER_ID,
    publicKeyHex: PEER_ID,
    displayName: "Alice",
  });

  assert.equal(contact.peerId, PEER_ID);
  assert.equal(contact.publicKeyHex, PEER_ID);
  assert.equal(contact.displayName, "Alice");
  assert.equal(contact.trustState, "pending");

  const listed = await contacts.listContacts();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].trustState, "pending");
});

test("addContact rejects a peerId/publicKeyHex pair that does not match", async () => {
  const contacts = await loadContacts();

  await assert.rejects(
    contacts.addContact({
      peerId: PEER_ID,
      publicKeyHex: "b".repeat(64),
      displayName: "Mallory",
    }),
    /does not match peerId/,
  );

  await assert.rejects(
    contacts.addContact({
      peerId: "not-hex",
      publicKeyHex: "not-hex",
      displayName: "Mallory",
    }),
    /64-char hex/,
  );

  assert.equal((await contacts.listContacts()).length, 0);
});

test("listContacts and removeContact round-trip", async () => {
  const contacts = await loadContacts();

  const alice = await contacts.addContact({
    peerId: PEER_ID,
    publicKeyHex: PEER_ID,
    displayName: "Alice",
  });
  const bob = await contacts.addContact({
    peerId: "b".repeat(64),
    publicKeyHex: "b".repeat(64),
    displayName: "Bob",
  });

  let listed = await contacts.listContacts();
  assert.equal(listed.length, 2);

  assert.equal(await contacts.removeContact(bob.peerId), true);
  listed = await contacts.listContacts();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].peerId, alice.peerId);

  assert.equal(await contacts.removeContact(bob.peerId), false);
});

test("verifyPeer returns a graceful error when no network is available", async () => {
  const contacts = await loadContacts();

  await contacts.addContact({
    peerId: PEER_ID,
    publicKeyHex: PEER_ID,
    displayName: "Alice",
  });

  const result = await contacts.verifyPeer({ peerId: PEER_ID });
  assert.equal(result.verified, false);
  assert.equal(result.error, "no network provider available");

  // A failed verification must not have changed the trust state.
  const listed = await contacts.listContacts();
  assert.equal(listed[0].trustState, "pending");
});
