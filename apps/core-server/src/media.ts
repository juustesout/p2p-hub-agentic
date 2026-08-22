import {
  encodeMediaError,
  encodeMediaGrant,
  parseMediaRequest,
} from "@p2p-hub/sdk";
import type { SkillHandler, SkillInvocationContext, TrustTierGate } from "@p2p-hub/core";

/**
 * Lifetime of a granted media request, in ms. Short-lived: a live camera/mic
 * grant is not a long-lived session; the peer re-requests (and re-confirms)
 * per session. A policy decision of the confirming shell, not part of the wire
 * contract.
 */
export const MEDIA_GRANT_TTL_MS = 60_000;

/**
 * Per-peer cooldown between media requests, in ms. A media request triggers a
 * native Tier-2 prompt on the shell, which is precious — a flood of requests
 * would be a denial-of-attention attack. The cooldown is checked in the skill
 * handler (after the contract parses) so a hostile peer cannot spam prompts.
 */
export const MEDIA_REQUEST_RATE_LIMIT_MS = 30_000;

/**
 * The `core.media.request` handler factory — the `p2p-hub:media:v1` capability
 * (design doc "Decision 2"). Kept as a pure factory (no transport, no server
 * state) so the enforcement logic is unit-testable without a live host.
 *
 * A remote peer asks for live camera/microphone access. The envelope is parsed
 * fail-closed through the SDK contract (no identity/token fields on the wire),
 * then the request must be approved by the shell's native Tier-2 confirmation
 * (`confirmMediaRequest`) — the browser's `getUserMedia` UI is deliberately
 * not part of this path. A grant is minted only after that approval; there is
 * no route that skips it.
 *
 * Invariants enforced here, independent of the broker's own Fase 2A gates:
 *   - the caller must be a transport-verified peer (`context.peerId`); an
 *     anonymous or caller-supplied identity is `unauthorized`;
 *   - a per-peer cooldown stops a peer from spamming native prompts;
 *   - no confirmer / user denial resolves to `denied` (fail-closed).
 */
export function createMediaSkillHandler(deps: {
  trustGate: TrustTierGate;
}): SkillHandler {
  const lastRequest = new Map<string, number>();

  return async (
    payload: unknown,
    context?: SkillInvocationContext,
  ): Promise<unknown> => {
    const parsed = parseMediaRequest(payload);
    if (!parsed.ok) {
      return encodeMediaError(parsed.code);
    }

    const callerPeerId = context?.peerId;
    if (!callerPeerId) {
      return encodeMediaError("unauthorized");
    }

    const now = Date.now();
    const last = lastRequest.get(callerPeerId);
    if (last !== undefined && now - last < MEDIA_REQUEST_RATE_LIMIT_MS) {
      return encodeMediaError("rate-limited");
    }
    lastRequest.set(callerPeerId, now);

    const approved = await deps.trustGate.confirmMediaRequest(
      callerPeerId,
      parsed.request.kind,
      parsed.request.requested,
      MEDIA_GRANT_TTL_MS,
    );
    return approved
      ? encodeMediaGrant(MEDIA_GRANT_TTL_MS)
      : encodeMediaError("denied");
  };
}
