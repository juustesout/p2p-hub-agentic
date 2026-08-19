/**
 * Pure, deterministic settings-risk evaluation.
 *
 * `evaluateSettingsRisk` maps a set of effective security-relevant settings to
 * an ordered list of `RiskFinding`s plus an aggregate severity. It is a pure
 * function: no I/O, no randomness, no timers, no dependency on React, Tauri,
 * the network, AI or crypto. Given the same `EffectiveSettings` it always
 * returns a deep-equal result, so it can be run synchronously in the desktop
 * shell on every settings change ("live" risk) as well as in core on apply.
 */

/** The effective security settings that feed risk evaluation. */
export interface EffectiveSettings {
  /** True when the P2P hub is reachable beyond loopback (e.g. 0.0.0.0). */
  p2pHubExposed: boolean;
  /** True when chat auto-notification is enabled. */
  chatAutoNotify: boolean;
  /** True when remote skill invocation is unrestricted. */
  unrestrictedRemoteSkills: boolean;
  /** True when external API execution is allowed. */
  allowExternalApiExecution: boolean;
  /** True when the vault is stored locally (vs. a remote/HSM-backed store). */
  localVaultStorage: boolean;
}

/** Ordered risk severity. Individual findings are never `none`; only the
 * aggregate of an empty finding list is `none`. */
export type RiskSeverity = "none" | "low" | "medium" | "high" | "critical";

/** A single risk finding with a stable, human-parseable id. */
export interface RiskFinding {
  /** Stable finding id, e.g. `ERR_EXPOSED_UNRESTRICTED_SKILL`. */
  id: string;
  /** Severity of this finding (never `none`). */
  severity: Exclude<RiskSeverity, "none">;
  /** Short human-readable explanation of the risk. */
  message: string;
}

/** Result of a risk evaluation: all findings plus the aggregate severity. */
export interface RiskAssessment {
  /** Every finding produced by the active rules, in severity order (highest
   * first). Empty when the settings are considered safe. */
  findings: RiskFinding[];
  /** The highest severity among `findings`, or `none` when there are none. */
  aggregate: RiskSeverity;
}

const SEVERITY_RANK: Record<RiskSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Return the highest severity from a set of severities (defaults to `none`). */
export function highestSeverity(
  severities: ReadonlyArray<RiskSeverity>,
): RiskSeverity {
  let best: RiskSeverity = "none";
  for (const severity of severities) {
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[best]) {
      best = severity;
    }
  }
  return best;
}

/**
 * Normalize an `EffectiveSettings`-shaped input into a fully boolean settings
 * object. Missing or non-boolean fields default to `false` (the safe value),
 * so callers may pass a partial settings object without risking `undefined`
 * leaking into the rule evaluation. The input is never mutated.
 */
export function normalizeSettings(
  settings: Partial<EffectiveSettings> | undefined,
): EffectiveSettings {
  const s = settings ?? {};
  return {
    p2pHubExposed: s.p2pHubExposed === true,
    chatAutoNotify: s.chatAutoNotify === true,
    unrestrictedRemoteSkills: s.unrestrictedRemoteSkills === true,
    allowExternalApiExecution: s.allowExternalApiExecution === true,
    localVaultStorage: s.localVaultStorage === true,
  };
}

function finding(
  id: string,
  severity: Exclude<RiskSeverity, "none">,
  message: string,
): RiskFinding {
  return { id, severity, message };
}

const SEVERITY_DESC: Record<Exclude<RiskSeverity, "none">, number> = {
  low: SEVERITY_RANK.low,
  medium: SEVERITY_RANK.medium,
  high: SEVERITY_RANK.high,
  critical: SEVERITY_RANK.critical,
};

/**
 * Evaluate the effective settings and return every applicable risk finding
 * plus the aggregate severity. Pure and deterministic.
 */
export function evaluateSettingsRisk(
  settings: EffectiveSettings | Partial<EffectiveSettings> | undefined,
): RiskAssessment {
  const s = normalizeSettings(settings);

  const findings: RiskFinding[] = [];

  if (s.p2pHubExposed && s.chatAutoNotify && s.unrestrictedRemoteSkills) {
    findings.push(
      finding(
        "ERR_EXPOSED_UNRESTRICTED_SKILL",
        "critical",
        "The P2P hub is exposed beyond loopback with unrestricted remote skills and chat auto-notification enabled.",
      ),
    );
  }

  if (s.allowExternalApiExecution && s.unrestrictedRemoteSkills) {
    findings.push(
      finding(
        "ERR_REMOTE_EXTERNAL_API_ACCESS",
        "high",
        "Unrestricted remote skills are combined with external API execution.",
      ),
    );
  }

  if (s.p2pHubExposed && s.localVaultStorage) {
    findings.push(
      finding(
        "WARN_P2P_VAULT_EXPOSURE",
        "medium",
        "The vault is stored locally while the P2P hub is exposed beyond loopback.",
      ),
    );
  }

  findings.sort(
    (a, b) => SEVERITY_DESC[b.severity] - SEVERITY_DESC[a.severity],
  );

  const aggregate = highestSeverity(findings.map((f) => f.severity));

  return { findings, aggregate };
}
