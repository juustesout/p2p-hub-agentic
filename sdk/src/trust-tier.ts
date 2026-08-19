/**
 * Trust tiers for applying security-sensitive settings.
 *
 * A "trust tier" describes how much confirmation is required before a
 * change (or a whole settings bundle) may take effect:
 *
 * - `0` — a normal session; the change is applied with no extra confirmation.
 * - `1` — the session plus its existing capabilities; applied only once the
 *   session has demonstrated the relevant capability/context.
 * - `2` — the capabilities plus a fresh, explicit native (Tauri host)
 *   confirmation. This tier can never be satisfied by JavaScript alone (no
 *   `window.confirm`); the host must present an out-of-band prompt.
 *
 * The mapping from risk severity to the minimum required tier is a pure,
 * deterministic policy and lives here so both core and the desktop shell
 * agree on it.
 */

import type { RiskSeverity } from "./settings-risk";

/** A trust tier: 0 (normal), 1 (capability-confirmed), 2 (native-confirmed). */
export type TrustTier = 0 | 1 | 2;

export const TRUST_TIER_NORMAL = 0 as TrustTier;
export const TRUST_TIER_CAPABILITY = 1 as TrustTier;
export const TRUST_TIER_NATIVE = 2 as TrustTier;

/**
 * The minimum trust tier required to apply a change of the given aggregate
 * severity. `critical` requires a fresh native confirmation (tier 2); `high`
 * requires the existing capability context (tier 1); everything else is safe
 * to apply in a normal session (tier 0).
 */
export function requiredTrustTier(severity: RiskSeverity): TrustTier {
  switch (severity) {
    case "critical":
      return TRUST_TIER_NATIVE;
    case "high":
      return TRUST_TIER_CAPABILITY;
    default:
      return TRUST_TIER_NORMAL;
  }
}
