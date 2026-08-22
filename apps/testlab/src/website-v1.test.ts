import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginHost } from "@p2p-hub/core";
import {
  MAX_WEBSITE_ASSET_BYTES,
  buildWebsiteRequest,
  parseWebsiteResponse,
  WEBSITE_PROTOCOL_ID,
} from "@p2p-hub/sdk";

// Real mDNS multicast discovery is not delivered on GitHub-hosted macOS
// runners, so this real multi-peer smoke scenario is skipped there.
const MDNS_SKIP =
  process.platform === "darwin" &&
  "real mDNS multicast discovery is not delivered on GitHub macOS runners";
import { installBuiltPlugin, writeSiteCliPlugin, type SiteCliApi } from "./fixtures";

/**
 * Fase 2-eindcriterium negative matrix over a real P2P transport.
 *
 * `peer-app.test.ts` proves the authorization story (stranger / spoofed peerId /
 * verified contact / approved access pass). This file exercises the versioned
 * `p2p-hub:website:v1` *wire* contract end-to-end on top of that same
 * enforcement:
 *
 *   - byte-exact binary assets (a real PNG) survive the base64 round trip;
 *   - unknown protocols/versions and malformed envelopes answer with typed
 *     error envelopes (never a partial success);
 *   - traversal escapes and missing paths are `not-found`;
 *   - oversized assets are rejected with `payload-too-large`, never truncated;
 *   - invalid (expired / revoked) access passes stay denied at the broker gate.
 */

interface TaskResultLike {
  taskId: string;
  status: "ok" | "error";
  result?: unknown;
  error?: string;
}

interface PeerSiteApi {
  setSiteRoot(siteRoot: string): Promise<string>;
}

interface ContactsApi {
  addContact(input: { peerId: string; publicKeyHex: string; displayName: string }): Promise<unknown>;
  verifyPeer(input: { peerId: string }): Promise<{ verified: boolean; error?: string }>;
}

const REPO_PLUGINS = path.resolve(__dirname, "../../../plugins");

function tempRoot(tag: string): string {
  return path.join(__dirname, "../../node_modules/.cache", `website-v1-${tag}-${Math.random().toString(36).slice(2)}`);
}

async function bootHost(tag: string, pluginIds: string[], withSiteCli: boolean): Promise<{ host: PluginHost; peerId: string; api: SiteCliApi | null }> {
  const root = tempRoot(tag);
  const pluginsDir = path.join(root, "plugins");
  await fs.mkdir(pluginsDir, { recursive: true });
  for (const id of pluginIds) {
    await installBuiltPlugin(pluginsDir, id, REPO_PLUGINS);
  }
  if (withSiteCli) {
    await writeSiteCliPlugin(root);
  }
  const host = new PluginHost({
    pluginsDir,
    dataDir: path.join(root, "data"),
    enableNetworking: true,
  });
  await host.boot();
  const peerId = (await host.identityManager().getOrCreateIdentity()).peerId;
  const api = host.getActivated("sitecli") as SiteCliApi | undefined;
  return { host, peerId, api: api ?? null };
}

function knownPeerIds(host: PluginHost): Set<string> {
  const peers = new Set<string>();
  const provider = host.networkRegistry().selectActive();
  for (const discovered of provider?.listPeers?.() ?? []) {
    if (discovered.peerId) {
      peers.add(discovered.peerId);
    }
  }
  return peers;
}

async function waitFor(check: () => boolean, timeoutMs = 20_000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function assertErrorEnvelope(result: TaskResultLike, code: string): void {
  assert.equal(result.status, "ok", "a compliant gate-passing peer answers at the task level");
  const response = parseWebsiteResponse(result.result);
  assert.ok(response, "answer must be a parseable envelope");
  assert.equal(response.status, "error");
  assert.equal(response.code, code);
}

test("website-v1 wire contract: binary, malformed, traversal, oversize, and invalid-pass matrix", { skip: MDNS_SKIP }, async () => {
  const siteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "website-v1-site-"));
  await fs.writeFile(path.join(siteRoot, "index.html"), "<h1>hello from P2P</h1>");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
  await fs.writeFile(path.join(siteRoot, "logo.png"), png);
  const oversized = Buffer.alloc(MAX_WEBSITE_ASSET_BYTES + 1, 0x41);
  await fs.writeFile(path.join(siteRoot, "big.bin"), oversized);
  await fs.writeFile(path.join(siteRoot, ".secret.txt"), "nope");

  const a = await bootHost("a", ["peersite", "contacts"], false);
  const b = await bootHost("b", ["contacts"], true);
  const c = await bootHost("c", [], true);

  const peersite = a.host.getActivated("peersite") as PeerSiteApi;
  const contactsA = a.host.getActivated("contacts") as ContactsApi;
  const contactsB = b.host.getActivated("contacts") as ContactsApi;

  try {
    await waitFor(() => knownPeerIds(b.host).has(a.peerId));
    await waitFor(() => knownPeerIds(a.host).has(b.peerId));

    await peersite.setSiteRoot(siteRoot);

    // B becomes a verified contact of A.
    await contactsA.addContact({ peerId: b.peerId, publicKeyHex: b.peerId, displayName: "B" });
    await contactsB.addContact({ peerId: a.peerId, publicKeyHex: a.peerId, displayName: "A" });
    const bVerified = await contactsB.verifyPeer({ peerId: a.peerId });
    assert.equal(bVerified.verified, true, bVerified.error ?? "");
    const aVerified = await contactsA.verifyPeer({ peerId: b.peerId });
    assert.equal(aVerified.verified, true, aVerified.error ?? "");

    if (!b.api || !c.api) {
      throw new Error("consumer hosts must have sitecli");
    }

    // 1. Byte-exact binary round trip.
    const pngFetch = await b.api.sendTask(a.peerId, "peersite.fetchAsset", {
      ...buildWebsiteRequest("logo.png"),
    });
    assert.equal(pngFetch.status, "ok");
    const pngResponse = parseWebsiteResponse(pngFetch.result);
    assert.ok(pngResponse && pngResponse.status === "ok");
    assert.match(pngResponse.contentType, /image\/png/);
    assert.deepEqual(Buffer.from(pngResponse.data, "base64"), png);

    // 2. Unknown protocol / version.
    assertErrorEnvelope(
      await b.api.sendTask(a.peerId, "peersite.fetchAsset", {
        protocol: "p2p-hub:other",
        version: 1,
        path: "index.html",
      }),
      "unsupported-version",
    );
    assertErrorEnvelope(
      await b.api.sendTask(a.peerId, "peersite.fetchAsset", {
        protocol: WEBSITE_PROTOCOL_ID,
        version: 999,
        path: "index.html",
      }),
      "unsupported-version",
    );

    // 3. Malformed envelopes (extra field, missing path, empty path).
    assertErrorEnvelope(
      await b.api.sendTask(a.peerId, "peersite.fetchAsset", {
        protocol: WEBSITE_PROTOCOL_ID,
        version: 1,
        path: "index.html",
        extra: true,
      }),
      "malformed",
    );
    assertErrorEnvelope(
      await b.api.sendTask(a.peerId, "peersite.fetchAsset", {
        protocol: WEBSITE_PROTOCOL_ID,
        version: 1,
      }),
      "malformed",
    );
    assertErrorEnvelope(
      await b.api.sendTask(a.peerId, "peersite.fetchAsset", {
        protocol: WEBSITE_PROTOCOL_ID,
        version: 1,
        path: "",
      }),
      "malformed",
    );

    // 4. Traversal escapes and missing files are not-found.
    assertErrorEnvelope(
      await b.api.sendTask(a.peerId, "peersite.fetchAsset", {
        ...buildWebsiteRequest("../etc/passwd"),
      }),
      "not-found",
    );
    assertErrorEnvelope(
      await b.api.sendTask(a.peerId, "peersite.fetchAsset", {
        ...buildWebsiteRequest("sub/../../index.html"),
      }),
      "not-found",
    );
    assertErrorEnvelope(
      await b.api.sendTask(a.peerId, "peersite.fetchAsset", {
        ...buildWebsiteRequest(".secret.txt"),
      }),
      "not-found",
    );
    assertErrorEnvelope(
      await b.api.sendTask(a.peerId, "peersite.fetchAsset", {
        ...buildWebsiteRequest("missing.html"),
      }),
      "not-found",
    );

    // 5. Oversized asset → typed error, never truncated.
    assertErrorEnvelope(
      await b.api.sendTask(a.peerId, "peersite.fetchAsset", {
        ...buildWebsiteRequest("big.bin"),
      }),
      "payload-too-large",
    );

    // 6. C: a stranger with an expired or revoked pass is still denied.
    const scope = "site-read-only";
    a.host.accessPassManager().issue(c.peerId, scope, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const expired = await c.api.sendTask(a.peerId, "peersite.fetchAsset", {
      ...buildWebsiteRequest("index.html"),
    });
    assert.equal(expired.status, "error", "an expired pass must not lift the gate");
    assert.match(expired.error ?? "", /not authorized/);

    a.host.accessPassManager().issue(c.peerId, scope, 60_000);
    assert.equal(a.host.accessPassManager().revoke(c.peerId, scope), true);
    const revoked = await c.api.sendTask(a.peerId, "peersite.fetchAsset", {
      ...buildWebsiteRequest("index.html"),
    });
    assert.equal(revoked.status, "error", "a revoked pass must not lift the gate");
    assert.match(revoked.error ?? "", /not authorized/);
  } finally {
    await Promise.allSettled([a.host.stop(), b.host.stop(), c.host.stop()]);
  }
});
