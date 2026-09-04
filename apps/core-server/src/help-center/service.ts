import type { AIBudgetGate, VaultManager } from "@p2p-hub/core";
import { CoreAIProvider } from "@p2p-hub/core";
import {
  HelpAgent,
  type HelpAgentResult,
  type HelpAgentState,
} from "./help-agent";

/**
 * HelpCenter composition root (Brief 7D): the server-side help-agent and the
 * baked-in support contact the shell's "Chat met ons" tab talks to.
 *
 * The support contact is deliberately *not* a hidden hardcoded "verified"
 * peer: without a real key exchange no identity may be trusted, so the peerId
 * is operator-provided (env `P2P_HUB_SUPPORT_PEER_ID`, a 64-hex Ed25519
 * peerId). When absent the support endpoint reports `configured: false` and
 * the shell shows the chat tab as unavailable — fail-closed, never a chat
 * that quietly goes nowhere. The display name is a baked-in label.
 *
 * The help-agent is wired to a `CoreAIProvider` (the single component allowed
 * to read the `ai.*` vault secrets) and to the same anti-financial-DoS
 * `AIBudgetManager` every other AI call path uses, so operator help requests
 * count against the node-wide AI budget like any other caller.
 */

export interface SupportContact {
  peerId: string | null;
  displayName: string;
}

const SUPPORT_DISPLAY_NAME = "P2P Hub Helpdesk";
const SUPPORT_PEER_ID_ENV = "P2P_HUB_SUPPORT_PEER_ID";
const SUPPORT_PEER_ID_RE = /^[0-9a-f]{64}$/;

/** Resolve the support identity from the environment (injectable for tests). */
export function resolveSupportContact(
  env: NodeJS.ProcessEnv = process.env,
): SupportContact {
  const raw = (env[SUPPORT_PEER_ID_ENV] ?? "").trim().toLowerCase();
  const peerId = SUPPORT_PEER_ID_RE.test(raw) ? raw : null;
  return { peerId, displayName: SUPPORT_DISPLAY_NAME };
}

export interface HelpCenterServiceOptions {
  /** Lazy vault accessor — the vault manager only exists once the host boots. */
  vault: () => VaultManager | null;
  /** Anti-financial-DoS quota gate shared with every other AI call path. */
  aiBudget?: AIBudgetGate;
  /** Secret-free current server state the agent reasons over. */
  state: () => HelpAgentState;
}

export class HelpCenterService {
  private readonly options: HelpCenterServiceOptions;
  private provider: CoreAIProvider | null = null;
  private agent: HelpAgent | null = null;

  constructor(options: HelpCenterServiceOptions) {
    this.options = options;
  }

  /** The baked-in support contact (env-resolved, `configured` when a peerId exists). */
  support(): SupportContact & { configured: boolean } {
    const contact = resolveSupportContact();
    return { ...contact, configured: contact.peerId !== null };
  }

  /** True when an AI provider is configured and the help-agent may show/run. */
  async status(): Promise<{ available: boolean }> {
    const agent = this.agentInstance();
    if (!agent) {
      return { available: false };
    }
    return { available: await agent.available() };
  }

  /** Answer one operator question via the read-only, propose-then-confirm agent. */
  ask(question: unknown): Promise<HelpAgentResult> {
    const agent = this.agentInstance();
    if (!agent) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "ai-not-configured",
          detail:
            "De help-agent heeft een AI-provider nodig. Configureer er een en probeer opnieuw.",
        },
      });
    }
    return agent.ask(question);
  }

  private agentInstance(): HelpAgent | null {
    if (this.agent) {
      return this.agent;
    }
    const vault = this.options.vault();
    if (!vault) {
      return null;
    }
    this.provider = new CoreAIProvider({
      vault,
      aiBudgetGate: this.options.aiBudget,
    });
    this.agent = new HelpAgent(this.provider, this.options.state);
    return this.agent;
  }
}
