import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildKnockMessage, PluginHost } from "@p2p-hub/core";
import { buildWebsiteRequest, parseWebsiteResponse } from "@p2p-hub/sdk";
import { installBuiltPlugin, writeSiteCliPlugin, type SiteCliApi } from "./fixtures";

// Real mDNS multicast discovery is not delivered on GitHub-hosted macOS
// runners, so the real multi-peer smoke scenario cannot run there; it runs on
// ubuntu and windows. macOS is still covered by the unit-test matrix.
const MDNS_SKIP =
  process.platform === "darwin" &&
  "real mDNS multicast discovery is not delivered on GitHub macOS runners";

/**
 * Fase 2A toetssteen — the plan.md end-criterion, exercised as a real multi-peer
 * test:
 *
 *   "Dit is mijn peer identity. Ik expose deze specifieke capability aan deze
 *    peer. Eén van mijn capabilities is een statische website. De website staat
 *    lokaal op mijn disk. Een andere peer kan hem via het P2P-protocol ophalen,
 *    zonder dat ik een publieke webserver hoef te draaien."
 *
 * Scenario (3 peers, real network-light transports, independent PluginHosts):
 *   - A publishes a local directory as a P2P static site (real peersite plugin).
 *   - B is a verified contact of A and fetches assets over P2P.
 *   - C is a stranger: denied until it obtains a human-approved access pass,
 *     then allowed. A caller-supplied `peerId` in the payload is ignored — the
 *     broker gates on the transport-verified identity only.
 */

interface TaskResultLike {
  taskId: string;
  status: "ok" | "error";
  result?: unknown;
  error?: string;
}

interface PeerSiteApi {
  setSiteRoot(siteRoot: string): Promise<string>;
  setAcceptIncomingRequests(enabled: boolean): Promise<void>;
  resolveAccessRequest(requestId: string, approved: boolean): Promise<boolean>;
}

interface ContactsApi {
  addContact(input: { peerId: string; publicKeyHex: string; displayName: string }): Promise<unknown>;
  verifyPeer(input: { peerId: string }): Promise<{ verified: boolean; error?: string }>;
}

interface Host {
  host: PluginHost;
  peerId: string;
  api: SiteCliApi | null;
}

const REPO_PLUGINS = path.resolve(__dirname, "../../../plugins");

/** Host roots must live under node_modules/.cache so built plugins resolve @p2p-hub/core. */
function tempRoot(tag: string): string {
  return path.join(__dirname, "../../node_modules/.cache", `peer-app-${tag}-${Math.random().toString(36).slice(2)}`);
}

async function bootHost(
  tag: string,
  pluginIds: string[],
  withSiteCli: boolean,
): Promise<Host> {
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

function knownPeerIds(h: Host): Set<string> {
  const peers = new Set<string>();
  const provider = h.host.networkRegistry().selectActive();
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

/** C -> A: knock for site-read-only access, signed with C's own identity key. */
async function knock(
  consumer: Host,
  hostPeerId: string,
  claim: string,
): Promise<TaskResultLike> {
  if (!consumer.api) {
    throw new Error("consumer host has no sitecli plugin");
  }
  const timestamp = Date.now();
  const message = buildKnockMessage(consumer.peerId, claim, timestamp);
  const signature = await consumer.host.identityManager().sign(message);
  return consumer.api.sendTask(hostPeerId, "peersite.requestAccess", {
    peerId: consumer.peerId,
    claim,
    timestamp,
    signature: signature.toString("hex"),
  });
}

function assertAssetOk(result: TaskResultLike, expectedText: string): void {
  // Fase 2-eindcriterium: the handler answers with the versioned
  // `p2p-hub:website:v1` success envelope, which the consumer decodes with the
  // shared `parseWebsiteResponse` contract helper.
  assert.equal(result.status, "ok");
  const response = parseWebsiteResponse(result.result);
  assert.ok(response, "a compliant peer must answer with a parseable envelope");
  assert.equal(response.status, "ok");
  assert.match(response.contentType, /text\/html/);
  assert.equal(Buffer.from(response.data, "base64").toString("utf8"), expectedText);
}

test("Fase 2A toetssteen: a verified contact and an access-pass holder fetch a P2P static site; a stranger is denied", { skip: MDNS_SKIP }, async () => {
  const siteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "peer-app-site-"));
  await fs.writeFile(path.join(siteRoot, "index.html"), "<h1>hello from P2P</h1>");
  await fs.mkdir(path.join(siteRoot, "sub"), { recursive: true });
  await fs.writeFile(path.join(siteRoot, "sub", "about.html"), "<h1>about</h1>");

  const a = await bootHost("a", ["peersite", "contacts"], false);
  const b = await bootHost("b", ["contacts"], true);
  const c = await bootHost("c", [], true);

  const peersite = a.host.getActivated("peersite") as PeerSiteApi;
  const contactsA = a.host.getActivated("contacts") as ContactsApi;
  const contactsB = b.host.getActivated("contacts") as ContactsApi;

  try {
    // Full discovery mesh first.
    await waitFor(() => knownPeerIds(a).has(b.peerId) && knownPeerIds(a).has(c.peerId));
    await waitFor(() => knownPeerIds(b).has(a.peerId));
    await waitFor(() => knownPeerIds(c).has(a.peerId));

    await peersite.setSiteRoot(siteRoot);

    // 1. Stranger denied — including a spoofed peerId in the payload.
    if (!c.api) {
      throw new Error("stranger host has no sitecli plugin");
    }
    const strangerDenied = await c.api.sendTask(a.peerId, "peersite.fetchAsset", {
      ...buildWebsiteRequest("index.html"),
    });
    assert.equal(strangerDenied.status, "error");
    assert.match(strangerDenied.error ?? "", /not authorized/);

    const spoofed = await c.api.sendTask(a.peerId, "peersite.fetchAsset", {
      ...buildWebsiteRequest("index.html"),
      peerId: b.peerId,
    });
    assert.equal(spoofed.status, "error", "a caller-supplied peerId must not bypass the gate");
    assert.match(spoofed.error ?? "", /not authorized/);

    // 2. Verified contact: mutual verification via contacts.signChallenge, then fetch.
    await contactsA.addContact({ peerId: b.peerId, publicKeyHex: b.peerId, displayName: "B" });
    await contactsB.addContact({ peerId: a.peerId, publicKeyHex: a.peerId, displayName: "A" });
    const bVerified = await contactsB.verifyPeer({ peerId: a.peerId });
    assert.equal(bVerified.verified, true, bVerified.error ?? "");
    const aVerified = await contactsA.verifyPeer({ peerId: b.peerId });
    assert.equal(aVerified.verified, true, aVerified.error ?? "");

    if (!b.api) {
      throw new Error("consumer host has no sitecli plugin");
    }
    const contactFetch = await b.api.sendTask(a.peerId, "peersite.fetchAsset", {
      ...buildWebsiteRequest("index.html"),
    });
    assertAssetOk(contactFetch, "<h1>hello from P2P</h1>");

    const nestedFetch = await b.api.sendTask(a.peerId, "peersite.fetchAsset", {
      ...buildWebsiteRequest("sub/about.html"),
    });
    assertAssetOk(nestedFetch, "<h1>about</h1>");

    // 3. Access pass: a stranger knocks, a human approves, then the pass works.
    await peersite.setAcceptIncomingRequests(true);
    let requestId = "";
    const requested = new Promise<void>((resolve) => {
      const disposable = a.host
        .hookRegistry()
        .on("peersite:accessRequested", (payload) => {
          requestId = String((payload as { requestId?: unknown }).requestId ?? "");
          disposable.dispose();
          resolve();
        });
    });
    const knockResult = await knock(c, a.peerId, "toetssteen wants read access");
    assert.equal(knockResult.status, "ok");
    assert.equal((knockResult.result as { status?: string }).status, "pending");
    await requested;
    assert.ok(requestId.length > 0, "A must receive a peersite:accessRequested event");

    const approved = await peersite.resolveAccessRequest(requestId, true);
    assert.equal(approved, true);

    if (!c.api) {
      throw new Error("stranger host has no sitecli plugin");
    }
    const passFetch = await c.api.sendTask(a.peerId, "peersite.fetchAsset", {
      ...buildWebsiteRequest("index.html"),
    });
    assertAssetOk(passFetch, "<h1>hello from P2P</h1>");
  } finally {
    await Promise.allSettled([a.host.stop(), b.host.stop(), c.host.stop()]);
  }
});
