import {
  MEDIA_PROTOCOL_ID,
  MEDIA_PROTOCOL_VERSION,
  buildMediaRequestSummary,
  requiredTrustTier,
  type MediaKind,
  type MediaStreamParams,
  type RiskSeverity,
  type TrustTier,
} from "@p2p-hub/sdk";

/**
 * Raised when a change is refused because the required trust tier could not be
 * satisfied. Always fail-closed: a missing confirmer, an unauthenticated
 * session, a native confirmation that returns `false`, or a confirmer that
 * throws all surface as this error — never as a silent allow.
 */
export class TrustConfirmationDeniedError extends Error {
  readonly requiredTier: TrustTier;
  readonly reason: string;

  constructor(requiredTier: TrustTier, reason: string) {
    super(`trust tier ${requiredTier} confirmation denied: ${reason}`);
    this.name = "TrustConfirmationDeniedError";
    this.requiredTier = requiredTier;
    this.reason = reason;
  }
}

/**
 * Who initiated the change being confirmed. `"operator"` for a human-driven
 * action; `` `agent:${label}` `` for an action initiated by a declared agent
 * identity. The native dialog must surface the label (`"Agent <label> wants
 * to ..."`), never a generic "a request is pending". This is a platform
 * verdict, set at the confirm-request construction site from a
 * transport/platform-verified initiator — never from a caller-supplied field.
 */
export type ConfirmationInitiator = "operator" | `agent:${string}`;

/**
 * A single native-confirmation prompt, discriminated by `kind` so the host can
 * render the right dialog with exactly the fields it needs — never guessing
 * which loose positional parameters belong together.
 *
 * Every variant carries a mandatory `initiator` (no default): a confirm call
 * that omits who initiated the change is a compile-time error, so an
 * agent-initiated action can never be shown as an operator-initiated one.
 */
export type ConfirmationRequest =
  | {
      kind: "critical-settings";
      summary: string;
      initiator: ConfirmationInitiator;
    }
  | {
      kind: "peer-access-request";
      peerId: string;
      claim: string;
      expiresInMs: number;
      initiator: ConfirmationInitiator;
    }
  | {
      kind: "agent-task-approval";
      taskId: string;
      skill: string;
      agentLabel: string;
      peerId: string;
      initiator: ConfirmationInitiator;
    }
  | {
      kind: "media-access-request";
      peerId: string;
      mediaKind: MediaKind;
      requested?: MediaStreamParams;
      summary: string;
      expiresInMs: number;
      initiator: ConfirmationInitiator;
    };

/**
 * Out-of-band confirmation capability, injected by the host. The only
 * implementation that matters is the desktop shell's native (Tauri host)
 * prompt; there is deliberately no JavaScript fallback (`window.confirm`) here.
 */
export interface TrustConfirmation {
  /** Ask the host for a fresh, explicit native confirmation. */
  confirmTier2?(request: ConfirmationRequest): Promise<boolean>;
}

/** What the gate already knows about the caller before asking for more. */
export interface TrustGateContext {
  /** True when the caller is an authenticated local session (boot token). */
  authenticated: boolean;
}

/**
 * Enforces the trust-tier policy from `requiredTrustTier`:
 *
 * - tier 0 (safe) — allowed with no further checks.
 * - tier 1 — allowed only for an authenticated session (its existing
 *   capability context is the confirmation).
 * - tier 2 — additionally requires a fresh native `confirmTier2`.
 *
 * Every denial throws {@link TrustConfirmationDeniedError}. With no
 * {@link TrustConfirmation} injected (the default), any tier-2 change is
 * denied — the fail-closed posture.
 */
export class TrustTierGate {
  constructor(private readonly confirmation: TrustConfirmation = {}) {}

  /** The minimum tier required for a severity. */
  requiredTier(severity: RiskSeverity): TrustTier {
    return requiredTrustTier(severity);
  }

  /**
   * Authorize a change of the given aggregate severity. Resolves with the tier
   * that was satisfied, or throws {@link TrustConfirmationDeniedError}.
   */
  async authorize(
    severity: RiskSeverity,
    summary: string,
    context: TrustGateContext = { authenticated: false },
  ): Promise<TrustTier> {
    const tier = requiredTrustTier(severity);

    if (tier === 0) {
      return tier;
    }

    if (!context.authenticated) {
      throw new TrustConfirmationDeniedError(tier, "unauthenticated session");
    }

    if (tier === 1) {
      return tier;
    }

    // Tier 2: a fresh native confirmation is mandatory.
    if (!this.confirmation.confirmTier2) {
      throw new TrustConfirmationDeniedError(tier, "no native confirmer");
    }

    let confirmed: boolean;
    try {
      confirmed = await this.confirmation.confirmTier2({
        kind: "critical-settings",
        summary,
        // Settings changes are operator-driven: only a human interacts with
        // the settings surface. An agent-driven settings change would route
        // through its own initiator-tagged confirm (never this default).
        initiator: "operator",
      });
    } catch {
      throw new TrustConfirmationDeniedError(tier, "confirmation failed");
    }

    if (!confirmed) {
      throw new TrustConfirmationDeniedError(tier, "denied by user");
    }

    return tier;
  }

  /**
   * Ask the host to confirm an incoming peer-access request (tier 2). Unlike
   * {@link authorize}, this is not driven by a settings risk severity — a
   * peer-access request is its own tier-2 prompt — so the gate is consulted
   * directly for a `peer-access-request` confirmation.
   *
   * Fails closed: no confirmer, a confirmer that throws, or a user denial all
   * resolve to `false`. The caller treats `false` as "deny the request".
   */
  async confirmPeerAccess(
    peerId: string,
    claim: string,
    expiresInMs: number,
  ): Promise<boolean> {
    if (!this.confirmation.confirmTier2) {
      return false;
    }
    try {
      return await this.confirmation.confirmTier2({
        kind: "peer-access-request",
        peerId,
        claim,
        expiresInMs,
        initiator: "operator",
      });
    } catch {
      return false;
    }
  }

  /**
   * Ask the host to confirm an inbound media request (camera/microphone) from a
   * remote peer (Decision 2: Tier-2 native-confirm gate). This is the only
   * approval path for `p2p-hub:media:v1` — the browser's own `getUserMedia`
   * permission UI is deliberately not part of this flow.
   *
   * Fails closed: no confirmer, a confirmer that throws, or a user denial all
   * resolve to `false`. The caller treats `false` as "deny the request".
   */
  async confirmMediaRequest(
    peerId: string,
    mediaKind: MediaKind,
    requested: MediaStreamParams | undefined,
    expiresInMs: number,
  ): Promise<boolean> {
    if (!this.confirmation.confirmTier2) {
      return false;
    }
    try {
      return await this.confirmation.confirmTier2({
        kind: "media-access-request",
        peerId,
        mediaKind,
        requested,
        summary: buildMediaRequestSummary({
          protocol: MEDIA_PROTOCOL_ID,
          version: MEDIA_PROTOCOL_VERSION,
          kind: mediaKind,
          requested,
        }),
        expiresInMs,
        initiator: "operator",
      });
    } catch {
      return false;
    }
  }
}
