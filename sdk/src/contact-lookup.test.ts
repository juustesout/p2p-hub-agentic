import { test } from "node:test";
import assert from "node:assert/strict";
import { asContactLookup, type ContactLookup } from "./contact-lookup";

test("asContactLookup accepts an object with a getContact function", () => {
  const lookup: ContactLookup = {
    getContact: async (peerId) =>
      peerId.length === 64 ? { trustState: "verified" } : null,
  };
  assert.equal(asContactLookup(lookup), lookup);
});

test("asContactLookup rejects non-objects", () => {
  assert.equal(asContactLookup(undefined), null);
  assert.equal(asContactLookup(null), null);
  assert.equal(asContactLookup(42), null);
  assert.equal(asContactLookup("contacts"), null);
  assert.equal(asContactLookup(true), null);
});

test("asContactLookup rejects objects without a function getContact", () => {
  assert.equal(asContactLookup({}), null);
  assert.equal(asContactLookup({ getContact: "not a function" }), null);
  assert.equal(asContactLookup({ getContact: 42 }), null);
  assert.equal(
    asContactLookup({ addContact: () => undefined, listContacts: () => [] }),
    null,
  );
});

test("asContactLookup treats a getContact that is not callable as absent", () => {
  const fake = { getContact: Promise.resolve({ trustState: "verified" }) };
  assert.equal(asContactLookup(fake), null);
});
