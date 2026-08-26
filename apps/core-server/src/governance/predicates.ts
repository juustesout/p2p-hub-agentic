/**
 * Slice 1 — the single source of truth for "is this registered skill reachable
 * over the P2P network". Two callers depend on this and MUST stay in sync:
 *
 *   - the governance **catalog** (`GovernanceService.catalog`): the skills an
 *     operator may grant via a matrix entry;
 *   - the permission-matrix **write validation** (`PeerMatrixStore` via the
 *     `validateSkill` the core-server wires in `initGovernance`): the skills a
 *     matrix entry may actually list.
 *
 * A matrix entry can never name a skill this predicate does not accept (the
 * Stap 6 intersection invariant), and the catalog shows exactly the skills the
 * predicate accepts — so both surfaces agreeing is a property of this one
 * function, not of two hand-rolled filters drifting apart.
 *
 * Semantics (the manifest-exposed, network-reachable set):
 *   - `localOnly` skills are never network-accessible (deny-by-default);
 *   - `httpBridgeOnly` skills are local operator privileges over the HTTP
 *     bridge and are structurally never peer-facing;
 *   - a `remote` policy must be present — `localOnly: false` alone authorizes
 *     nothing (Fase 2A).
 *
 * `httpExposed` is deliberately NOT consulted: it is the *local HTTP bridge*
 * dimension, orthogonal to network reachability. A skill can be both
 * network-exposed and HTTP-exposed; the predicate asks only "over the P2P
 * network".
 */
export interface NetworkExposableSkill {
  localOnly: boolean;
  httpBridgeOnly: boolean;
  remote?: unknown;
}

export function isNetworkExposedSkill(skill: NetworkExposableSkill): boolean {
  return !skill.localOnly && !skill.httpBridgeOnly && skill.remote !== undefined;
}
