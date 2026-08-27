import type { PluginHost, TrustTierGate } from "@p2p-hub/core";

/**
 * Structural view of the activated `peersite` plugin as seen by the
 * access-confirmation seam. Core-server stays type-ignorant of the plugin
 * package: it only needs `resolveAccessRequest` to answer the plugin's knock.
 */
interface PeerSiteAccessPlugin {
  resolveAccessRequest?(requestId: string, approved: boolean): Promise<boolean>;
}

/**
 * Structural view of the activated `media` plugin as seen by the
 * access-confirmation seam.
 */
interface MediaAccessPlugin {
  resolveMediaAccess?(requestId: string, granted: boolean): Promise<boolean>;
}

/**
 * Handle a `peersite:accessRequested` event emitted by the peersite plugin
 * after it has verified a knock. The request is resolved through the host's
 * native tier-2 confirmation (`confirmPeerAccess`, fail-closed), then passed
 * back to the plugin via `resolveAccessRequest`.
 */
export function wirePeerAccessConfirmations(
  host: PluginHost,
  trustGate: TrustTierGate,
  resolvePeersite: () => PeerSiteAccessPlugin | null,
): void {
  host.hookRegistry().on("peersite:accessRequested", (payload) => {
    void handlePeerAccessRequest(payload, trustGate, resolvePeersite);
  });
}

async function handlePeerAccessRequest(
  payload: unknown,
  trustGate: TrustTierGate,
  resolvePeersite: () => PeerSiteAccessPlugin | null,
): Promise<void> {
  const req = (payload ?? {}) as {
    requestId?: unknown;
    peerId?: unknown;
    claim?: unknown;
    expiresInMs?: unknown;
  };
  if (
    typeof req.requestId !== "string" ||
    typeof req.peerId !== "string" ||
    typeof req.claim !== "string" ||
    typeof req.expiresInMs !== "number"
  ) {
    return;
  }

  const approved = await trustGate.confirmPeerAccess(
    req.peerId,
    req.claim,
    req.expiresInMs,
  );

  const plugin = resolvePeersite();
  if (plugin?.resolveAccessRequest) {
    await plugin.resolveAccessRequest(req.requestId, approved);
  }
}

/**
 * Handle a `media:accessRequested` event emitted by the media plugin before
 * any SDP/ICE exchange with a peer. The request is resolved through the
 * host's native tier-2 confirmation (`confirmMediaRequest`, fail-closed —
 * the same `TrustConfirmation` core-server already owns for peersite), then
 * passed back to the plugin via `resolveMediaAccess`. The plugin never
 * calls `requestMediaAccess` itself; it only raises the hook.
 */
export function wireMediaAccessConfirmations(
  host: PluginHost,
  trustGate: TrustTierGate,
  resolveMedia: () => MediaAccessPlugin | null,
): void {
  host.hookRegistry().on("media:accessRequested", (payload) => {
    void handleMediaAccessRequest(payload, trustGate, resolveMedia);
  });
}

async function handleMediaAccessRequest(
  payload: unknown,
  trustGate: TrustTierGate,
  resolveMedia: () => MediaAccessPlugin | null,
): Promise<void> {
  const req = (payload ?? {}) as {
    requestId?: unknown;
    peerId?: unknown;
    kind?: unknown;
    direction?: unknown;
    expiresInMs?: unknown;
  };
  if (
    typeof req.requestId !== "string" ||
    typeof req.peerId !== "string" ||
    (req.kind !== "camera" && req.kind !== "microphone") ||
    typeof req.expiresInMs !== "number"
  ) {
    return;
  }

  const granted = await trustGate.confirmMediaRequest(
    req.peerId,
    req.kind,
    undefined,
    req.expiresInMs,
  );

  const plugin = resolveMedia();
  if (plugin?.resolveMediaAccess) {
    await plugin.resolveMediaAccess(req.requestId, granted);
  }
}
