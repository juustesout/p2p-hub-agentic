/**
 * Fase 2A — platform-enforced remote access policy.
 *
 * Before 2A, "who may invoke this skill over the network" was a convention:
 * every network-exposed skill (`localOnly: false`) either trusted every peer
 * or performed its own gate checks inside the plugin. That put the trust
 * boundary inside each plugin author's hands, and a sloppy/malicious
 * third-party plugin could simply forget to check.
 *
 * 2A moves the decision into the {@link TaskBroker}: a skill declares a
 * `remote` policy at registration, and `handleRemote` evaluates that policy
 * *before* dispatch — the handler never runs when the gate is closed. The
 * broker is the single enforcement point; the plugin only declares intent.
 *
 * Fail-closed invariants (independently enforced in `TaskBroker.execute`):
 *   - A network-exposed skill WITHOUT a `remote` policy is denied. Opting a
 *     skill into the network (`localOnly: false`) alone no longer authorizes
 *     anything — the policy is the authorization.
 *   - `access-pass` requires a `scope`; a policy without one is rejected at
 *     registration time.
 *   - A remote peer with no transport-verified `peerId` (anonymous) can never
 *     satisfy `verified-contact` or `access-pass` — it is denied even when the
 *     policy names those gates.
 *   - `verified-contact` / `access-pass` without an injected {@link RemoteGate}
 *     are denied: an absent gate cannot prove anything.
 *   - `any` is the only gate that needs no proof. It is therefore gated twice:
 *     at registration (the plugin must hold an explicit `network:public:*`
 *     manifest permission, enforced by the plugin loader) and at runtime (the
 *     broker still requires the policy object).
 */
export type RemoteGateKind = "verified-contact" | "access-pass" | "any";

/** A single gate kind, or a list evaluated as OR. An empty list denies. */
export type RemoteGateSpec = RemoteGateKind | RemoteGateKind[];

export interface RemoteAccessPolicy {
  /**
   * Gate(s) a remote caller must pass to invoke the skill, evaluated as OR
   * when an array is given. `"any"` means explicitly public — it requires the
   * manifest permission `network:public:<pluginId>.<skill>` on top of the
   * regular `network:skill:<pluginId>.<skill>` permission.
   */
  gate: RemoteGateSpec;
  /**
   * Required when `gate` includes `"access-pass"`: the pass scope a caller
   * must hold (e.g. `"site-read-only"`). Passes are scoped so one pass cannot
   * lift the gate on unrelated capabilities.
   */
  scope?: string;
  /**
   * A1/Slice 2 — how *agent* callers (declared child identities) are treated,
   * layered on top of the gate. Fail-closed default when absent: `"approved"`
   * (every agent-initiated invocation additionally needs a native human
   * approval). Agents can never pass the `"any"` gate regardless of this field.
   */
  agent?: AgentAccessPolicy;
}

/**
 * A1/Slice 2 — per-skill classification of agent callers. Mirrors the
 * three-tier escalation matrix recorded in plan.md:
 *
 * - `"telemetry"` (Tier 1) — read-only/telemetry skills: the normal gate is
 *   the whole check, no per-invocation approval.
 * - `"approved"` (Tier 2, default) — discrete side-effect skills: after the
 *   gate passes, every agent-initiated invocation also requires a native human
 *   approval (per-invocation step-up).
 * - `"never"` (Tier 3) — critical skills (vault/admin/settings-adjacent):
 *   agent callers are always refused, even with a passing gate.
 *
 * The broker's `any`-gate refusal is structural and independent of this field:
 * an agent caller can never use the public path.
 */
export type AgentAccessLevel = "telemetry" | "approved" | "never";

export interface AgentAccessPolicy {
  level: AgentAccessLevel;
}

/**
 * Capability the {@link TaskBroker} consults to detect agent callers.
 * Deliberately injected (never constructed by the broker): the broker must not
 * know *how* agent identities are stored — the host wires a concrete
 * implementation backed by its child-identity registry. Resolution happens
 * from the transport-verified `task.peerId` only; a caller-supplied payload
 * field is never consulted (CLAUDE.md principle: the platform decides
 * authorization from a transport-verified identity).
 */
export interface AgentGate {
  /**
   * Resolve the agent label for a transport-verified `peerId`, or `null` when
   * the peer is not a declared agent identity. Never throws (a failing lookup
   * reads as "not an agent" — the caller still has to pass the normal gate).
   */
  resolveAgentLabel(peerId: string): Promise<string | null>;
}

/** What the host's native approval prompt needs to render for an agent task. */
export interface AgentTaskApprovalRequest {
  taskId: string;
  skill: string;
  agentLabel: string;
  peerId: string;
}

/**
 * A1/Slice 2 — per-invocation human approval for agent-initiated tasks (Tier 2
 * step-up). Injected by the host exactly like {@link RemoteGate}; the desktop
 * shell renders a native confirmation. An absent gate fails closed: an agent
 * task that needs approval is denied when no confirmer is wired.
 */
export interface TaskApprovalGate {
  /**
   * Ask the host for a fresh, explicit native confirmation before dispatching
   * an agent-initiated task. Resolves `true` = approved. Never throws (a
   * throwing confirmer is a denial).
   */
  approveAgentTask?(request: AgentTaskApprovalRequest): Promise<boolean>;
}

/**
 * Capability the {@link TaskBroker} consults to evaluate a {@link RemoteAccessPolicy}.
 * Deliberately injected (never constructed by the broker): the broker must not
 * know *how* contacts or access passes are stored — the host wires concrete
 * implementations. An absent gate makes the non-`any` gates fail closed.
 */
export interface RemoteGate {
  /** True when `peerId` is a verified contact. Never throws. */
  isVerifiedContact(peerId: string): Promise<boolean>;
  /** True when `peerId` holds a valid, unexpired pass for `scope`. Never throws. */
  hasValidAccessPass(peerId: string, scope: string): Promise<boolean>;
}

/** Normalize a {@link RemoteGateSpec} to a canonical array (OR semantics). */
export function normalizeRemoteGates(spec: RemoteGateSpec | undefined): RemoteGateKind[] {
  if (spec === undefined) {
    return [];
  }
  return Array.isArray(spec) ? spec : [spec];
}

/** The fail-closed agent access level when a policy declares none. */
export const DEFAULT_AGENT_ACCESS_LEVEL: AgentAccessLevel = "approved";

/** True when `level` names a known {@link AgentAccessLevel}. */
export function isAgentAccessLevel(value: unknown): value is AgentAccessLevel {
  return value === "telemetry" || value === "approved" || value === "never";
}
