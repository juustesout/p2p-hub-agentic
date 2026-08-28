/**
 * SmartProjects v1.1 schema extensions.
 *
 * v1.0 kept the project/task model types inline in `index.ts`. v1.1 adds the
 * collaboration layer — dependencies, delegation and cryptographically-signed
 * completion proofs — in its own module so the pure computations
 * (`computations.ts`) and the UI can import the same shapes without reaching
 * into the plugin entry module.
 */

/** The lifecycle of a task delegation to a network peer. */
export type DelegationStatus = "pending" | "accepted" | "declined";

/** Who a task is delegated to and whether they accepted the assignment. */
export interface TaskDelegation {
  /** The transport identity (`peerId`) of the peer the task is delegated to. */
  assignedTo: string;
  status: DelegationStatus;
  /** Optional free-form reason, only set when the delegatee declined. */
  declinedReason?: string;
}

/**
 * A completion proof produced by the *delegatee* (the peer that accepted the
 * delegation) and verified by the project owner before the task is marked
 * done. `signatureHex` is an Ed25519 signature over
 * `COMPLETION_PROOF_DOMAIN_PREFIX + "<taskId>:<projectId>:<timestamp>"`.
 */
export interface TaskCompletionProof {
  /** The signer's identity — must equal the transport-verified sender. */
  signedBy: string;
  /** ISO 8601 timestamp embedded in the signed payload. */
  timestamp: string;
  /** Hex-encoded Ed25519 signature. */
  signatureHex: string;
}

/**
 * Structural domain separation (Fase 2B, CLAUDE.md principle #4/#8): this
 * string is prepended to every completion-proof payload before signing AND
 * verification, so a signature minted in any other domain
 * (`p2p-hub:chat:message:v1:`, ...) is structurally meaningless here — the
 * bytes never match. Callers pick this constant and never another protocol's
 * constant.
 */
export const COMPLETION_PROOF_DOMAIN_PREFIX =
  "p2p-hub:tasks:completion-proof:v1:";
