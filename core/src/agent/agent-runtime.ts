import { randomUUID } from "node:crypto";
import type {
  NetworkPeer,
  NetworkProvider,
  PeerIdentity,
  TaskResult,
} from "@p2p-hub/sdk";
import type { TaskBroker } from "../task-broker/task-broker";
import { DEFAULT_AGENT_ACCESS_LEVEL } from "../task-broker/remote-access";
import type {
  ConfirmationInitiator,
  TrustConfirmation,
} from "../security/trust-gate";
import { isValidChildLabel } from "../identity/child-identity";

/**
 * An agent is a *network actor with its own derived identity* (Slice 1's
 * `deriveChildIdentity`), never the operator identity. This runtime is the
 * integration point that makes that true for task dispatch:
 *
 * - The {@link AgentRuntimeOptions.networkProvider} is constructed **with the
 *   child identity as its signer** (the caller builds it via the provider
 *   factory, exactly like the operator's provider, but from the child key).
 *   The runtime itself never holds any signer at all — so it structurally
 *   cannot hold the operator `IdentityManager` or its signer. The only
 *   identity material it receives is the child's *public* {@link PeerIdentity}.
 * - Every task the agent dispatches is tagged `initiator: "agent:<label>"`
 *   toward the confirm layer. An agent action that needs Tier-2 approval is
 *   shown to the operator as "Agent `<label>` wants to ...", never as a
 *   generic/operator-initiated prompt.
 * - Dispatch goes through the **shared {@link TaskBroker}** (the same one the
 *   operator and plugins use — no per-agent broker instances). The broker's
 *   skill registry carries each skill's `remote.agent` policy, so the
 *   agent-dispatch matrix is the same one the inbound path enforces:
 *   `never` refuses, `telemetry` passes without approval, and `approved`
 *   (the fail-closed default, applied when a skill declares no agent policy)
 *   requires a fresh native `confirmTier2` before the task leaves the host.
 *
 * Spec-gap resolution: the plan's minimal shape was
 * `AgentRuntimeOptions { label, networkProvider }`; `peerId()` and the confirm
 * layer require the child's public identity and a `TrustConfirmation` seam, so
 * those are added as explicit options. The operator signer is deliberately
 * *not* an option — the runtime can never be constructed with it.
 */

/** A task this agent dispatches, with the platform-set initiator tag. */
export interface AgentTaskRequest {
  id: string;
  skill: string;
  payload: unknown;
  /** Which actor initiates the task. Set by the runtime, never by the caller. */
  initiator: ConfirmationInitiator;
}

export interface AgentRuntimeOptions {
  /** Agent label — becomes the `` `agent:<label>` `` initiator tag. */
  label: string;
  /**
   * The agent's **own** derived identity (Slice 1 `deriveChildIdentity`).
   * Public material only (peerId/publicKeyHex); the child *signer* lives
   * inside {@link networkProvider} and is never passed here.
   */
  identity: PeerIdentity;
  /**
   * The transport, instantiated with the child identity as signer — not the
   * operator signer. This is the only place the agent's signing key exists.
   */
  networkProvider: NetworkProvider;
  /**
   * The Tier-2 confirm layer. Absent `confirmTier2` ⇒ any agent task that
   * needs approval is denied (fail-closed, same as every other gate).
   */
  confirmation: TrustConfirmation;
  /**
   * The **shared** {@link TaskBroker} (operator + plugins + agents all use the
   * same one). Consulted for the skill's `remote.agent` policy before dispatch.
   */
  broker: TaskBroker;
}

/** The expected result of the per-dispatch authorization step. */
type DispatchVerdict = "allowed" | "denied";

/**
 * Wraps one agent's network presence. `start()`/`stop()` drive the wrapped
 * provider; `peerId()` reports the child peerId — never the operator's.
 */
export class AgentRuntime {
  private started = false;

  constructor(private readonly options: AgentRuntimeOptions) {
    if (!isValidChildLabel(options.label)) {
      throw new Error(
        `invalid agent label "${options.label}" (expected ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$)`,
      );
    }
    if (!options.identity || options.identity.peerId.length === 0) {
      throw new Error("AgentRuntime requires the agent's own (child) identity");
    }
  }

  /** Start the agent's network provider. Idempotent. */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.options.networkProvider.start();
    this.started = true;
  }

  /** Stop the agent's network provider. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    await this.options.networkProvider.stop();
    this.started = false;
  }

  /** The agent's own child peerId — never the operator's. */
  peerId(): string {
    return this.options.identity.peerId;
  }

  /** The agent label (the `` `agent:` `` suffix of every initiator tag). */
  label(): string {
    return this.options.label;
  }

  /**
   * Dispatch a task as this agent. The dispatched {@link AgentTaskRequest}
   * carries `initiator: "agent:<label>"` and that same tag flows into the
   * confirm layer's `ConfirmationRequest` (the shared broker's skill registry
   * decides whether a native confirmation is needed first). Never throws for a
   * denial — it resolves to a typed error {@link TaskResult}, mirroring the
   * broker's own fail-closed style.
   */
  async sendTask(
    peer: NetworkPeer,
    task: { skill: string; payload: unknown; id?: string },
  ): Promise<TaskResult> {
    const dispatched: AgentTaskRequest = {
      id: task.id ?? randomUUID(),
      skill: task.skill,
      payload: task.payload,
      initiator: `agent:${this.options.label}`,
    };
    const verdict = await this.authorizeDispatch(dispatched);
    if (verdict === "denied") {
      return {
        taskId: dispatched.id,
        status: "error",
        error:
          `agent "${this.options.label}" is not allowed to dispatch skill ` +
          `"${dispatched.skill}"`,
      };
    }
    return this.options.networkProvider.sendTask(peer, {
      id: dispatched.id,
      skill: dispatched.skill,
      payload: dispatched.payload,
    });
  }

  /**
   * Apply the agent-dispatch matrix to a dispatched task using the shared
   * broker's skill registry. A skill that is not registered is treated as
   * `approved` (the fail-closed default): unknown skills still require a human
   * approval.
   */
  private async authorizeDispatch(
    task: AgentTaskRequest,
  ): Promise<DispatchVerdict> {
    const record = this.options.broker
      .listSkills()
      .find((entry) => entry.skill === task.skill);
    const level = record?.remote?.agent?.level ?? DEFAULT_AGENT_ACCESS_LEVEL;

    if (level === "never") {
      return "denied";
    }
    if (level === "telemetry") {
      return "allowed";
    }
    return (await this.askOperator(task)) ? "allowed" : "denied";
  }

  /**
   * Ask the operator for a fresh native confirmation, tagged with the task's
   * initiator. Fails closed: no confirmer, a throwing confirmer, or a denial
   * all resolve to `false`.
   */
  private async askOperator(task: AgentTaskRequest): Promise<boolean> {
    const confirm = this.options.confirmation.confirmTier2;
    if (!confirm) {
      return false;
    }
    try {
      return await confirm({
        kind: "agent-task-approval",
        taskId: task.id,
        skill: task.skill,
        agentLabel: this.options.label,
        peerId: this.options.identity.peerId,
        initiator: task.initiator,
      });
    } catch {
      return false;
    }
  }
}
