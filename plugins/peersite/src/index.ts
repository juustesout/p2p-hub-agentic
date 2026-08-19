import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PluginContext } from "@p2p-hub/core";
import {
  authenticateIncomingPeer,
  contentTypeForPath,
  PEER_ID_RE,
  resolveAndContainFile,
  signAuthChallenge,
  validateSiteRoot,
} from "@p2p-hub/core";

/**
 * PeerSite: publish a directory as a static site that is reachable both over
 * the local HTTP bridge (`/site/*`) and, to *verified contacts only*, over the
 * P2P network (`peersite.fetchAsset`).
 *
 * This plugin owns the site-root configuration: the user-chosen directory is
 * stored here (`ctx.storage`), validated with the shared
 * {@link validateSiteRoot}, and read back by the core-server HTTP handler via
 * `host.getActivated("peersite")`. The HTTP and P2P surfaces both resolve
 * files through the same {@link resolveAndContainFile}, so they accept and
 * reject exactly the same paths.
 *
 * The P2P surface is fail-closed: `fetchAsset` only answers a peer that proves
 * possession of a *verified* contact's key (challenge-response over
 * `peersite.signAuthChallenge`, domain-separated by
 * `PEERSITE_AUTH_CONTEXT`). An unverified/unknown peer gets a plain
 * "unauthorized" and nothing else.
 */

export interface FetchAssetInput {
  /** Claimed persistent peerId of the caller. Proves nothing by itself. */
  peerId: string;
  /** Decoded sub-path to serve, e.g. `"index.html"` or `"a/b.css"`. */
  path: string;
}

export type FetchAssetResult =
  | { ok: true; contentType: string; data: string; name: string }
  | { ok: false; error: string };

export interface PeerSiteStatus {
  online: boolean;
  peerName: string;
  siteRootConfigured: boolean;
}

export interface PeerSitePlugin {
  /** Validate and persist a site root; returns its canonical realpath. */
  setSiteRoot(siteRoot: string): Promise<string>;
  /** The configured site root's realpath, or `null` when not configured. */
  getSiteRoot(): Promise<string | null>;
  status(): Promise<PeerSiteStatus>;
  fetchAsset(input: FetchAssetInput): Promise<FetchAssetResult>;
}

const SITE_ROOT_KEY = "siteRoot";
const FETCH_ASSET_SKILL = "peersite.fetchAsset";
const SIGN_AUTH_CHALLENGE_SKILL = "peersite.signAuthChallenge";

export default function activate(ctx: PluginContext): PeerSitePlugin {
  let siteRootReal: string | null = null;
  let rootLoaded = false;

  async function getSiteRoot(): Promise<string | null> {
    if (!rootLoaded) {
      const stored = await ctx.storage.get(SITE_ROOT_KEY);
      if (typeof stored === "string" && stored.length > 0) {
        // Re-validate at load: a root that has since moved or been deleted is
        // treated as unconfigured, never as a dangling path to serve from.
        try {
          siteRootReal = validateSiteRoot(stored, ctx.dataDir);
        } catch {
          siteRootReal = null;
        }
      }
      rootLoaded = true;
    }
    return siteRootReal;
  }

  async function setSiteRoot(siteRoot: string): Promise<string> {
    const real = validateSiteRoot(siteRoot, ctx.dataDir);
    siteRootReal = real;
    rootLoaded = true;
    await ctx.storage.set(SITE_ROOT_KEY, siteRoot);
    return real;
  }

  async function status(): Promise<PeerSiteStatus> {
    const root = await getSiteRoot();
    return {
      online: true,
      peerName: await ctx.identity.peerId(),
      siteRootConfigured: root !== null,
    };
  }

  async function authenticatePeer(peerId: string): Promise<boolean> {
    // Deny by default: no trust seam or no network means nobody gets in.
    if (!ctx.trust || !ctx.network || !PEER_ID_RE.test(peerId)) {
      return false;
    }
    const result = await authenticateIncomingPeer(peerId, {
      getContact: (id) => ctx.trust!.getContact(id),
      requestSignature: async (id, nonce) => {
        const res = await ctx.network!.sendTask(id, {
          id: crypto.randomUUID(),
          skill: SIGN_AUTH_CHALLENGE_SKILL,
          payload: { nonce: nonce.toString("hex") },
        });
        if (res.status !== "ok") {
          return null;
        }
        const signature = (res.result as { signature?: unknown } | undefined)
          ?.signature;
        return typeof signature === "string"
          ? Buffer.from(signature, "hex")
          : null;
      },
      verify: (publicKeyHex, data, signature) =>
        ctx.identity.verify(publicKeyHex, data, signature),
    });
    return result.authenticated;
  }

  async function fetchAsset(input: FetchAssetInput): Promise<FetchAssetResult> {
    const { peerId, path: requestedPath } = (input ?? {}) as {
      peerId?: unknown;
      path?: unknown;
    };

    // Authenticate first: never leak which paths exist to an unverified peer.
    if (typeof peerId !== "string" || typeof requestedPath !== "string") {
      return { ok: false, error: "unauthorized" };
    }
    if (!(await authenticatePeer(peerId))) {
      return { ok: false, error: "unauthorized" };
    }

    const root = await getSiteRoot();
    if (!root) {
      return { ok: false, error: "site not configured" };
    }

    const resolved = resolveAndContainFile(root, requestedPath);
    if (!resolved) {
      return { ok: false, error: "not found" };
    }

    let contents: Buffer;
    try {
      contents = await fs.readFile(resolved);
    } catch {
      return { ok: false, error: "not found" };
    }

    return {
      ok: true,
      contentType: contentTypeForPath(resolved),
      data: contents.toString("base64"),
      name: path.basename(resolved),
    };
  }

  ctx.skills.register(
    "setSiteRoot",
    async (payload) => {
      const { siteRoot } = (payload ?? {}) as { siteRoot?: unknown };
      if (typeof siteRoot !== "string" || siteRoot.length === 0) {
        throw new Error("setSiteRoot expects { siteRoot: string }");
      }
      return setSiteRoot(siteRoot);
    },
    // Local-only, but reachable over the authenticated HTTP bridge so the
    // desktop shell can configure the site without any network exposure.
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register("status", async () => status(), { localOnly: false });

  ctx.skills.register(
    "fetchAsset",
    async (payload) => fetchAsset(payload as FetchAssetInput),
    { localOnly: false },
  );

  ctx.skills.register(
    "signAuthChallenge",
    async (payload) => {
      const { nonce } = (payload ?? {}) as { nonce?: unknown };
      if (typeof nonce !== "string" || !/^[0-9a-f]+$/.test(nonce)) {
        throw new Error("signAuthChallenge expects { nonce: string(hex) }");
      }
      // Domain-separated signature (PEERSITE_AUTH_CONTEXT || nonce), never
      // caller-chosen bytes.
      const signature = await signAuthChallenge(
        (data) => ctx.identity.sign(data),
        Buffer.from(nonce, "hex"),
      );
      return { signature: signature.toString("hex") };
    },
    { localOnly: false },
  );

  return { setSiteRoot, getSiteRoot, status, fetchAsset };
}
