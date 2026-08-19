import {
  requiredTrustTier,
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
 * Out-of-band confirmation capability, injected by the host. The only
 * implementation that matters is the desktop shell's native (Tauri host)
 * prompt; there is deliberately no JavaScript fallback (`window.confirm`) here.
 */
export interface TrustConfirmation {
  /** Ask the host for a fresh, explicit native confirmation of a tier-2 change. */
  confirmTier2?(summary: string): Promise<boolean>;
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
      confirmed = await this.confirmation.confirmTier2(summary);
    } catch {
      throw new TrustConfirmationDeniedError(tier, "confirmation failed");
    }

    if (!confirmed) {
      throw new TrustConfirmationDeniedError(tier, "denied by user");
    }

    return tier;
  }
}
