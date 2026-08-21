import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { IdentityManager } from "./identity-manager";
import {
  authenticateIncomingPeer,
  buildAuthMessage,
  PEERSITE_AUTH_CONTEXT,
  signAuthChallenge,
  type PeerAuthDeps,
} from "./peer-auth";

function makeKeypair(): { privateKey: crypto.KeyObject; publicKeyHex: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    privateKey,
    publicKeyHex: Buffer.from(jwk.x, "base64url").toString("hex"),
  };
}

function signWith(privateKey: crypto.KeyObject): (domain: string, data: Buffer) => Promise<Buffer> {
  return async (domain, data) =>
    crypto.sign(
      null,
      Buffer.concat([Buffer.from(domain, "utf8"), data]),
      privateKey,
    );
}

interface DepsResult {
  deps: PeerAuthDeps;
  requestCalls: () => number;
}

/**
 * Build deps where the peer is a "virtual identity" (a bare keypair). The
 * claimed `peerId` is that keypair's public key hex, so a correct signature
 * verifies against it. `trustState` controls the contact lookup result.
 */
function buildDeps(opts: {
  trustState: "pending" | "verified" | "blocked" | null;
  signer?: crypto.KeyObject;
}): DepsResult {
  let requestCalls = 0;
  const signer = opts.signer;
  const deps: PeerAuthDeps = {
    getContact: async () =>
      opts.trustState === null ? null : { trustState: opts.trustState },
    requestSignature: async (_peerId, nonce) => {
      requestCalls += 1;
      if (!signer) {
        return null;
      }
      return signAuthChallenge(signWith(signer), nonce);
    },
    verify: (publicKeyHex, domain, data, signature) =>
      IdentityManager.verify(
        publicKeyHex,
        Buffer.concat([Buffer.from(domain, "utf8"), data]),
        signature,
      ),
  };
  return { deps, requestCalls: () => requestCalls };
}

test("rejects a non-hex / malformed peerId without issuing a challenge", async () => {
  const { deps, requestCalls } = buildDeps({ trustState: "verified" });

  const result = await authenticateIncomingPeer("not-hex", deps);
  assert.deepEqual(result, {
    authenticated: false,
    peerId: "not-hex",
    reason: "invalid-peer-id",
  });
  assert.equal(requestCalls(), 0);
});

test("rejects an unknown contact without issuing a challenge", async () => {
  const keypair = makeKeypair();
  const { deps, requestCalls } = buildDeps({ trustState: null, signer: keypair.privateKey });

  const result = await authenticateIncomingPeer(keypair.publicKeyHex, deps);
  assert.deepEqual(result, {
    authenticated: false,
    peerId: keypair.publicKeyHex,
    reason: "not-a-verified-contact",
  });
  assert.equal(requestCalls(), 0);
});

test("rejects a pending (unverified) contact without issuing a challenge", async () => {
  const keypair = makeKeypair();
  const { deps, requestCalls } = buildDeps({
    trustState: "pending",
    signer: keypair.privateKey,
  });

  const result = await authenticateIncomingPeer(keypair.publicKeyHex, deps);
  assert.equal(result.authenticated, false);
  assert.equal(
    result.authenticated ? null : result.reason,
    "not-a-verified-contact",
  );
  assert.equal(requestCalls(), 0);
});

test("rejects a blocked contact without issuing a challenge", async () => {
  const keypair = makeKeypair();
  const { deps, requestCalls } = buildDeps({
    trustState: "blocked",
    signer: keypair.privateKey,
  });

  const result = await authenticateIncomingPeer(keypair.publicKeyHex, deps);
  assert.equal(result.authenticated, false);
  assert.equal(
    result.authenticated ? null : result.reason,
    "not-a-verified-contact",
  );
  assert.equal(requestCalls(), 0);
});

test("authenticates a verified contact that signs the challenge (two virtual identities)", async () => {
  const peer = makeKeypair();
  const { deps, requestCalls } = buildDeps({
    trustState: "verified",
    signer: peer.privateKey,
  });

  const result = await authenticateIncomingPeer(peer.publicKeyHex, deps);
  assert.deepEqual(result, { authenticated: true, peerId: peer.publicKeyHex });
  assert.equal(requestCalls(), 1);
});

test("rejects a verified contact that signs with the wrong key", async () => {
  const peer = makeKeypair();
  const impostor = makeKeypair();
  const { deps } = buildDeps({ trustState: "verified", signer: impostor.privateKey });

  const result = await authenticateIncomingPeer(peer.publicKeyHex, deps);
  assert.equal(result.authenticated, false);
  assert.equal(result.authenticated ? null : result.reason, "bad-signature");
});

test("rejects a signature made under a different domain prefix", async () => {
  const peer = makeKeypair();
  let requestCalls = 0;
  const deps: PeerAuthDeps = {
    getContact: async () => ({ trustState: "verified" }),
    // Sign the *contacts* domain prefix instead of the PeerSite one.
    requestSignature: async (_peerId, nonce) => {
      requestCalls += 1;
      const wrong = Buffer.concat([
        Buffer.from("p2p-hub:contacts:challenge:v1:", "utf8"),
        nonce,
      ]);
      return crypto.sign(null, wrong, peer.privateKey);
    },
    verify: (publicKeyHex, domain, data, signature) =>
      IdentityManager.verify(
        publicKeyHex,
        Buffer.concat([Buffer.from(domain, "utf8"), data]),
        signature,
      ),
  };

  const result = await authenticateIncomingPeer(peer.publicKeyHex, deps);
  assert.equal(result.authenticated, false);
  assert.equal(result.authenticated ? null : result.reason, "bad-signature");
  assert.equal(requestCalls, 1);
});

test("rejects when the peer does not respond to the challenge", async () => {
  const peer = makeKeypair();
  const { deps } = buildDeps({ trustState: "verified" });

  const result = await authenticateIncomingPeer(peer.publicKeyHex, deps);
  assert.equal(result.authenticated, false);
  assert.equal(result.authenticated ? null : result.reason, "no-response");
});

test("buildAuthMessage anchors on the exact domain prefix", () => {
  const nonce = Buffer.from("abcdef", "hex");
  const message = buildAuthMessage(nonce);
  assert.equal(
    message.subarray(0, PEERSITE_AUTH_CONTEXT.length).toString("utf8"),
    PEERSITE_AUTH_CONTEXT,
  );
  assert.deepEqual(message.subarray(PEERSITE_AUTH_CONTEXT.length), nonce);
});

test("a signature minted under one domain never verifies under another (structural separation)", async () => {
  const signer = makeKeypair();
  const nonce = crypto.randomBytes(32);

  // The domain-aware signer applies PEERSITE_AUTH_CONTEXT itself — the caller
  // never chooses the bytes that get signed, only the data payload.
  const signature = await signAuthChallenge(signWith(signer.privateKey), nonce);

  const validUnderPeersite = IdentityManager.verify(
    signer.publicKeyHex,
    buildAuthMessage(nonce),
    signature,
  );
  assert.equal(validUnderPeersite, true);

  // The same signature must fail under the *contacts* domain even though the
  // underlying key and nonce are identical — that is the point of structural
  // domain separation.
  const validUnderContacts = IdentityManager.verify(
    signer.publicKeyHex,
    Buffer.concat([
      Buffer.from("p2p-hub:contacts:challenge:v1:", "utf8"),
      nonce,
    ]),
    signature,
  );
  assert.equal(validUnderContacts, false);
});
