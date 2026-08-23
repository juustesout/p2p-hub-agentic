import type { MediaKind } from "@p2p-hub/sdk";
import type {
  ConfirmationInitiator,
  TrustConfirmation,
} from "./trust-gate";

/**
 * A media-access confirmation request, as the gate needs it. `peerId` names
 * the peer the grant would be consumed for and `expiresInMs` the grant
 * lifetime — both are audit-relevant, so neither is invented here. `reason`
 * is free text for the native prompt (it becomes the variant's `summary`
 * field).
 */
export interface RequestMediaAccessOptions {
  /** Who initiated the request — `"operator"` or `` `agent:<label>` ``. */
  initiator: ConfirmationInitiator;
  /** Human-readable reason shown in the native confirm dialog. */
  reason: string;
  /** The peer the media grant would be consumed for. */
  peerId: string;
  /** Grant lifetime in ms, decided by the caller. */
  expiresInMs: number;
  /** Which device class is requested. A "both" request is two calls. */
  kind: MediaKind;
}

/**
 * Ask the host for a Tier-2 native confirmation of live camera/microphone
 * access (design doc "Decision 2"). This is the single platform-facing route
 * for media access: `p2p-hub:media:v1` inbound requests reach the native
 * prompt through {@link TrustTierGate.confirmMediaRequest}, and any
 * agent/platform-originated media access goes through this gate — there is no
 * other route, and the browser's own `getUserMedia` UI is deliberately not
 * part of the flow.
 *
 * Fails closed: no confirmer, a confirmer that throws, or a user denial all
 * resolve to `false`. The caller treats `false` as "deny media access".
 */
export async function requestMediaAccess(
  confirmation: TrustConfirmation,
  opts: RequestMediaAccessOptions,
): Promise<boolean> {
  if (!confirmation.confirmTier2) {
    return false;
  }
  try {
    return await confirmation.confirmTier2({
      kind: "media-access-request",
      peerId: opts.peerId,
      mediaKind: opts.kind,
      summary: opts.reason,
      expiresInMs: opts.expiresInMs,
      initiator: opts.initiator,
    });
  } catch {
    return false;
  }
}
