import type { PluginContext } from "@p2p-hub/core";
import { PEER_ID_RE } from "@p2p-hub/core";
import { createPublicClient, http, recoverMessageAddress } from "viem";
import { getEnsText, namehash } from "viem/ens";
import { readContract } from "viem/actions";
import { ens_normalize } from "@adraffy/ens-normalize";
import { confusables, type ConfusablePoint } from "unicode-confusables";

/**
 * ENS name -> verified peerId discovery.
 *
 * This plugin resolves an ENS name to a `peerId` and proves the binding with a
 * cross-signature, so a `.eth` name becomes a *human-readable address book
 * entry* — never a trust tier. It answers only "which peerId does `name`
 * currently claim?", and it refuses to return a usable `peerId` unless the ENS
 * owner has cryptographically signed that exact claim.
 *
 * Fail-closed shape:
 *   - disabled (default) or no RPC URL -> a clear error, no lookup.
 *   - a `p2p.peer` record without a valid `p2p.sig` -> `verified: false` and
 *     **no** `peerId` field (only `claimedPeerId`, for a warning UI).
 *
 * All Web3 coupling lives in this one plugin (`viem`, `@adraffy/ens-normalize`,
 * `unicode-confusables`) — never in `core` or `sdk`.
 */

/** Cross-signed ENS text records. `p2p.sig` signs the statement below. */
const TEXT_RECORD_PEER = "p2p.peer";
const TEXT_RECORD_SIG = "p2p.sig";

/** Config storage key under the plugin's own `ctx.storage`. */
const CONFIG_KEY = "config";

/** Default cache TTL for a resolved name -> peerId binding. */
const DEFAULT_TTL_MS = 3_600_000; // 1 hour

/** Canonical ENS Registry (mainnet). Owner is read from here, not the resolver. */
const ENS_REGISTRY_ADDRESS = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const ENS_REGISTRY_OWNER_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [{ type: "bytes32", name: "node" }],
    outputs: [{ type: "address", name: "" }],
  },
] as const;

export interface EnsConfig {
  enabled: boolean;
  rpcUrl?: string;
}

export type EnsResolveResult =
  | { verified: true; peerId: string; ensOwnerAddress: string; warning?: string }
  | {
      verified: false;
      claimedPeerId?: string;
      ensOwnerAddress: string | null;
      warning?: string;
    };

/**
 * Minimal RPC surface the resolver needs. In production this is implemented
 * with `viem`; tests inject a fake so `npm test` never touches a real ENS or
 * Ethereum RPC (the transport is never constructed in tests).
 */
export interface EnsRpcClient {
  getText(name: string, key: string): Promise<string | null>;
  getOwner(name: string): Promise<string | null>;
}

/** Test seam. Production callers activate without this; the loader passes only
 * `ctx`, so these stay `undefined` outside the test harness. */
export interface EnsDeps {
  ensClient?: EnsRpcClient;
  ttlMs?: number;
  now?: () => number;
}

export interface EnsPlugin {
  setConfig(input: { enabled?: boolean; rpcUrl?: string }): Promise<EnsConfig>;
  getConfig(): Promise<EnsConfig>;
  resolve(input: { name: string }): Promise<EnsResolveResult>;
}

/**
 * The exact bytes the owner must sign (EIP-191 `personal_sign`): one line,
 * no trailing whitespace/newline. `name` is the ENSIP-15-normalized name
 * (including the `.eth` suffix); `peerId` is the lowercase, 0x-free hex id.
 */
function statementFor(peerId: string, name: string): string {
  return `I authorize peer ${peerId} for name ${name}`;
}

function buildClient(rpcUrl: string): EnsRpcClient {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    async getText(name, key) {
      try {
        return await getEnsText(client, { name, key });
      } catch {
        return null;
      }
    },
    async getOwner(name) {
      try {
        // Registry owner(namehash(name)) — the canonical "who owns this name"
        // source, NOT the resolver's addr()/coin-type record.
        const owner = await readContract(client, {
          address: ENS_REGISTRY_ADDRESS,
          abi: ENS_REGISTRY_OWNER_ABI,
          functionName: "owner",
          args: [namehash(name)],
        });
        return typeof owner === "string" ? owner : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * True when `name` contains a non-ASCII character that is a confusable
 * lookalike of another character (e.g. Cyrillic "а" -> Latin "a"). ASCII
 * characters are never flagged (digits like "1"/"0" are deliberately excluded
 * to avoid false positives on ordinary names).
 *
 * IMPORTANT — this is a UX warning, NOT a security boundary. The authorization
 * decision is the cross-signature verification alone; a missed or imprecise
 * homograph here does not weaken it. Do not treat the absence of a `warning`
 * as a reason to trust a name.
 */
function looksConfusable(name: string): boolean {
  for (const ch of name) {
    if ((ch.codePointAt(0) ?? 0) <= 0x7f) {
      continue;
    }
    let entries: ConfusablePoint[];
    try {
      entries = confusables(ch) ?? [];
    } catch {
      entries = [];
    }
    if (entries.some((e) => typeof e.similarTo === "string" && e.similarTo.length > 0)) {
      return true;
    }
  }
  return false;
}

export default function activate(ctx: PluginContext, deps?: EnsDeps): EnsPlugin {
  const now = deps?.now ?? (() => Date.now());
  const ttlMs = deps?.ttlMs ?? DEFAULT_TTL_MS;
  // Only-verified resolutions are cached; a failed verification is re-checked
  // on the next call so a later owner fix is picked up.
  const cache = new Map<string, { result: EnsResolveResult; at: number }>();

  let builtClient: EnsRpcClient | null = null;
  let builtForUrl: string | null = null;

  async function getConfig(): Promise<EnsConfig> {
    const stored = await ctx.storage.get(CONFIG_KEY);
    if (
      typeof stored === "object" &&
      stored !== null &&
      typeof (stored as Record<string, unknown>).enabled === "boolean"
    ) {
      const record = stored as { enabled: boolean; rpcUrl?: unknown };
      return {
        enabled: record.enabled,
        rpcUrl: typeof record.rpcUrl === "string" ? record.rpcUrl : undefined,
      };
    }
    return { enabled: false };
  }

  async function setConfig(input: {
    enabled?: boolean;
    rpcUrl?: string;
  }): Promise<EnsConfig> {
    const current = await getConfig();
    const enabled = typeof input.enabled === "boolean" ? input.enabled : current.enabled;
    const rpcUrl =
      typeof input.rpcUrl === "string" && input.rpcUrl.length > 0
        ? input.rpcUrl
        : current.rpcUrl;
    const next: EnsConfig = { enabled };
    if (rpcUrl !== undefined) {
      next.rpcUrl = rpcUrl;
    }
    await ctx.storage.set(CONFIG_KEY, next);
    return next;
  }

  async function resolve(input: { name: string }): Promise<EnsResolveResult> {
    const { name } = (input ?? {}) as { name?: unknown };
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("resolve expects { name: string }");
    }

    const config = await getConfig();
    if (!config.enabled) {
      throw new Error("ens: resolution is disabled (enable via ens.setConfig)");
    }

    // Homograph warning is computed on the *original* input, not the normalized
    // name. `ens_normalize` maps lookalikes (e.g. fullwidth "Ｏ" -> "o", Roman
    // numeral "ⅰ" -> "i") to their ASCII form, so by the time the name is
    // normalized the confusable is gone; flagging the raw input is what tells
    // the user "the name you typed visually differs from what actually
    // resolved". This is UX only — see `looksConfusable`.
    const warning = looksConfusable(name)
      ? "name contains characters that visually resemble others (homograph risk)"
      : undefined;

    // Normalize (ENSIP-15). A hard-invalid name throws here — this is a
    // distinct case from a "suspicious" (but valid) lookalike name.
    let normalized: string;
    try {
      normalized = ens_normalize(name);
    } catch (err) {
      throw new Error(
        `ens: invalid name "${name}": ${(err as Error).message}`,
      );
    }

    let rpc: EnsRpcClient;
    if (deps?.ensClient) {
      rpc = deps.ensClient;
    } else if (config.rpcUrl) {
      if (builtForUrl !== config.rpcUrl) {
        builtClient = buildClient(config.rpcUrl);
        builtForUrl = config.rpcUrl;
      }
      rpc = builtClient as EnsRpcClient;
    } else {
      throw new Error("ens: no RPC URL configured (set via ens.setConfig)");
    }

    const cached = cache.get(normalized);
    if (cached && now() - cached.at < ttlMs) {
      return cached.result;
    }

    const result = await doResolve(rpc, normalized, warning);
    if (result.verified) {
      cache.set(normalized, { result, at: now() });
    }
    return result;
  }

  async function doResolve(
    rpc: EnsRpcClient,
    normalized: string,
    warning: string | undefined,
  ): Promise<EnsResolveResult> {
    const [peerRecord, sigRecord, owner] = await Promise.all([
      rpc.getText(normalized, TEXT_RECORD_PEER),
      rpc.getText(normalized, TEXT_RECORD_SIG),
      rpc.getOwner(normalized),
    ]);

    const ownerAddress = owner ? owner.toLowerCase() : null;

    if (typeof peerRecord !== "string" || peerRecord.length === 0) {
      return { verified: false, ensOwnerAddress: ownerAddress, warning };
    }
    const claimedPeerId = peerRecord;

    if (typeof sigRecord !== "string" || sigRecord.length === 0) {
      return {
        verified: false,
        claimedPeerId,
        ensOwnerAddress: ownerAddress,
        warning,
      };
    }

    if (!PEER_ID_RE.test(claimedPeerId)) {
      return {
        verified: false,
        claimedPeerId,
        ensOwnerAddress: ownerAddress,
        warning,
      };
    }

    if (!ownerAddress) {
      return {
        verified: false,
        claimedPeerId,
        ensOwnerAddress: null,
        warning,
      };
    }

    let recovered: string | null = null;
    try {
      const address = await recoverMessageAddress({
        message: statementFor(claimedPeerId, normalized),
        signature: sigRecord as `0x${string}`,
      });
      recovered = address.toLowerCase();
    } catch {
      recovered = null;
    }

    if (!recovered || recovered !== ownerAddress) {
      return {
        verified: false,
        claimedPeerId,
        ensOwnerAddress: ownerAddress,
        warning,
      };
    }

    return {
      verified: true,
      peerId: claimedPeerId,
      ensOwnerAddress: ownerAddress,
      warning,
    };
  }

  ctx.skills.register(
    "setConfig",
    async (payload) => setConfig((payload ?? {}) as { enabled?: boolean; rpcUrl?: string }),
    { localOnly: true, httpExposed: true },
  );

  ctx.skills.register(
    "resolve",
    async (payload) => resolve((payload ?? {}) as { name: string }),
    { localOnly: true, httpExposed: true },
  );

  return { setConfig, getConfig, resolve };
}
