import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PluginContext } from "@p2p-hub/core";
import {
  buildAuthMessage,
  buildKnockMessage,
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
 * possession of its key (challenge-response over `peersite.signAuthChallenge`,
 * domain-separated by `PEERSITE_AUTH_CONTEXT`) *and* is either a verified
 * contact or holds a valid, human-approved access pass (see below).
 *
 * Access passes (phase 4B): a peer that is *not* a verified contact can request
 * read-only site access with a single, standalone proof-of-possession
 * ("knock") over `peersite.requestAccess`. The knock is verified against the
 * claimed `peerId` itself (raw public-key hex) — no contacts lookup, no prior
 * handshake, no transport identity. A valid knock creates a *pending* request
 * that the host resolves through a native tier-2 confirmation
 * (`TrustConfirmation.confirmTier2({ kind: "peer-access-request", ... })`). On
 * approval the plugin mints an ephemeral, in-memory `AccessPass` whose `scope`
 * is fixed to `"site-read-only"` — it only lifts the verified-contact gate on
 * `fetchAsset`, never on `execute-skill` (which stays a separate,
 * site-credential-gated surface).
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

/** A single, standalone access request ("knock") with inline proof. */
export interface RequestAccessInput {
  /** Claimed peerId. It is both the identity and the verification key. */
  peerId: string;
  /** Human-readable reason/claim shown in the native confirm prompt. */
  claim: string;
  /** Unix epoch milliseconds; must be within the replay window. */
  timestamp: number;
  /** Hex-encoded Ed25519 signature over {@link buildKnockMessage}. */
  signature: string;
}

export type RequestAccessResult =
  | { ok: true; requestId: string; status: "pending" }
  | { ok: false; error: string };

/**
 * Ephemeral, in-memory access pass. `scope` is fixed to `"site-read-only"`; it
 * is never persisted and never handed out as a bearer token — it is keyed by
 * the peerId, and the peer must still prove possession on every `fetchAsset`.
 */
export interface AccessPass {
  peerId: string;
  scope: "site-read-only";
  issuedAt: number;
  expiresAt: number;
}

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
  /** Enable/disable accepting incoming access-request knocks (default off). */
  setAcceptIncomingRequests(enabled: boolean): Promise<void>;
  /** Verify a knock and, if accepted, register a pending access request. */
  requestAccess(input: RequestAccessInput): Promise<RequestAccessResult>;
  /** Resolve a pending request; on approval mint an access pass. */
  resolveAccessRequest(requestId: string, approved: boolean): Promise<boolean>;
}

const SITE_ROOT_KEY = "siteRoot";
const FETCH_ASSET_SKILL = "peersite.fetchAsset";
const SIGN_AUTH_CHALLENGE_SKILL = "peersite.signAuthChallenge";
const ACCESS_REQUESTED_EVENT = "peersite:accessRequested";

/** A knock's signature is only accepted within this window of the timestamp. */
const KNOCK_REPLAY_WINDOW_MS = 5 * 60 * 1000;
/** At most one accepted knock per peerId within this window. */
const KNOCK_RATE_LIMIT_MS = 60 * 60 * 1000;
/** How long an approved access pass stays valid. */
const ACCESS_PASS_TTL_MS = 60 * 60 * 1000;
/** How long a pending access request stays resolvable. */
const ACCESS_REQUEST_TTL_MS = 5 * 60 * 1000;
/** Upper bound on the claim string (shown verbatim in the native prompt). */
const MAX_CLAIM_LENGTH = 200;

interface PendingAccessRequest {
  requestId: string;
  peerId: string;
  claim: string;
  expiresInMs: number;
  createdAt: number;
}

/** Strip control characters (incl. newlines) so a claim can't break a dialog. */
function sanitizeClaim(claim: string): string {
  return claim.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

export default function activate(ctx: PluginContext): PeerSitePlugin {
  let siteRootReal: string | null = null;
  let rootLoaded = false;
  let acceptIncoming = false;

  const accessPasses = new Map<string, AccessPass>();
  const pendingRequests = new Map<string, PendingAccessRequest>();
  const knockTimestamps = new Map<string, number>();

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

  /**
   * Challenge-response proof of key possession, *without* any contact check.
   * The peer must answer a `signAuthChallenge` challenge signed with the key
   * behind `peerId`. Deny-by-default when there is no network seam.
   */
  async function provePossession(peerId: string): Promise<boolean> {
    if (!ctx.network) {
      return false;
    }
    const nonce = crypto.randomBytes(32);
    const res = await ctx.network.sendTask(peerId, {
      id: crypto.randomUUID(),
      skill: SIGN_AUTH_CHALLENGE_SKILL,
      payload: { nonce: nonce.toString("hex") },
    });
    if (res.status !== "ok") {
      return false;
    }
    const signature = (res.result as { signature?: unknown } | undefined)
      ?.signature;
    if (typeof signature !== "string" || !/^[0-9a-f]+$/.test(signature)) {
      return false;
    }
    return ctx.identity.verify(
      peerId,
      buildAuthMessage(nonce),
      Buffer.from(signature, "hex"),
    );
  }

  async function isVerifiedContact(peerId: string): Promise<boolean> {
    if (!ctx.trust) {
      return false;
    }
    const contact = await ctx.trust.getContact(peerId);
    return contact?.trustState === "verified";
  }

  function hasValidAccessPass(peerId: string): boolean {
    const pass = accessPasses.get(peerId);
    if (!pass) {
      return false;
    }
    if (Date.now() > pass.expiresAt) {
      accessPasses.delete(peerId);
      return false;
    }
    return true;
  }

  async function setAcceptIncomingRequests(enabled: boolean): Promise<void> {
    acceptIncoming = enabled;
  }

  async function requestAccess(
    input: RequestAccessInput,
  ): Promise<RequestAccessResult> {
    const { peerId, claim, timestamp, signature } = (input ?? {}) as {
      peerId?: unknown;
      claim?: unknown;
      timestamp?: unknown;
      signature?: unknown;
    };

    if (typeof peerId !== "string" || !PEER_ID_RE.test(peerId)) {
      return { ok: false, error: "unauthorized" };
    }
    if (typeof claim !== "string" || claim.length > MAX_CLAIM_LENGTH) {
      return { ok: false, error: "unauthorized" };
    }
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      return { ok: false, error: "unauthorized" };
    }
    if (typeof signature !== "string" || !/^[0-9a-f]+$/.test(signature)) {
      return { ok: false, error: "unauthorized" };
    }

    const now = Date.now();
    // Replay window: a knock older (or newer) than the window is stale.
    if (Math.abs(now - timestamp) > KNOCK_REPLAY_WINDOW_MS) {
      return { ok: false, error: "unauthorized" };
    }

    // Rate limit (read-only until a proof is verified below, so invalid knocks
    // cannot grow the map).
    const lastKnock = knockTimestamps.get(peerId);
    if (lastKnock !== undefined && now - lastKnock < KNOCK_RATE_LIMIT_MS) {
      return { ok: false, error: "rate limited" };
    }

    // Verify against the claimed peerId itself — the raw public key, not a
    // contacts lookup. A bad signature is indistinguishable from "unauthorized".
    const message = buildKnockMessage(peerId, claim, timestamp);
    const valid = ctx.identity.verify(
      peerId,
      message,
      Buffer.from(signature, "hex"),
    );
    if (!valid) {
      return { ok: false, error: "unauthorized" };
    }

    // Record the proof *after* it verifies, so only genuine peers rate-limit.
    knockTimestamps.set(peerId, now);
    // Opportunistic prune of stale rate-limit entries.
    for (const [id, ts] of knockTimestamps) {
      if (now - ts >= KNOCK_RATE_LIMIT_MS) {
        knockTimestamps.delete(id);
      }
    }

    if (!acceptIncoming) {
      return { ok: false, error: "not accepting" };
    }

    const requestId = crypto.randomUUID();
    const cleanClaim = sanitizeClaim(claim);
    pendingRequests.set(requestId, {
      requestId,
      peerId,
      claim: cleanClaim,
      expiresInMs: ACCESS_PASS_TTL_MS,
      createdAt: now,
    });

    await ctx.hooks.emit(ACCESS_REQUESTED_EVENT, {
      requestId,
      peerId,
      claim: cleanClaim,
      expiresInMs: ACCESS_PASS_TTL_MS,
    });

    return { ok: true, requestId, status: "pending" };
  }

  async function resolveAccessRequest(
    requestId: string,
    approved: boolean,
  ): Promise<boolean> {
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return false;
    }
    pendingRequests.delete(requestId);

    if (!approved) {
      return true;
    }
    if (Date.now() - pending.createdAt > ACCESS_REQUEST_TTL_MS) {
      return false;
    }

    const now = Date.now();
    accessPasses.set(pending.peerId, {
      peerId: pending.peerId,
      scope: "site-read-only",
      issuedAt: now,
      expiresAt: now + pending.expiresInMs,
    });
    return true;
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
    if (!PEER_ID_RE.test(peerId)) {
      return { ok: false, error: "unauthorized" };
    }

    // Prove possession first, independent of contact status.
    if (!(await provePossession(peerId))) {
      return { ok: false, error: "unauthorized" };
    }

    // Access requires either a verified contact or a valid site-read-only pass.
    if (
      !(await isVerifiedContact(peerId)) &&
      !hasValidAccessPass(peerId)
    ) {
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

  ctx.skills.register(
    "requestAccess",
    async (payload) => requestAccess(payload as RequestAccessInput),
    { localOnly: false },
  );

  ctx.skills.register(
    "setAcceptIncomingRequests",
    async (payload) => {
      const { enabled } = (payload ?? {}) as { enabled?: unknown };
      if (typeof enabled !== "boolean") {
        throw new Error("setAcceptIncomingRequests expects { enabled: boolean }");
      }
      await setAcceptIncomingRequests(enabled);
      return { enabled };
    },
    { localOnly: true, httpExposed: true },
  );

  return {
    setSiteRoot,
    getSiteRoot,
    status,
    fetchAsset,
    setAcceptIncomingRequests,
    requestAccess,
    resolveAccessRequest,
  };
}
