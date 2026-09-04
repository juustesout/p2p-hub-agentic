import type {
  ChatMessageRecordView,
  HelpAgentAskResult,
} from "../../types";
import { lastBundleClipboardText } from "./bundle-slot";

/**
 * Pure helpers for the HelpCenter "Chat met ons" and "Help-agent" tabs
 * (Brief 7D). Kept free of React and of the network so the node:test suites
 * can exercise them directly; the tabs only glue these to `coreBridge`.
 *
 * Security notes encoded here:
 * - bundles are redacted by construction and only ever pasted as *text* into a
 *   chat composer — nothing else from the Diagnose tab is forwarded;
 * - a bundle longer than the chat protocol's message cap is visibly truncated
 *   (never silently cut mid-line and never sent to the wrong peer);
 * - the help-agent question length mirrors the server cap so the client
 *   refuses before any text is sent to the core-server, let alone an LLM.
 */

/** Chat protocol cap (matches `MAX_CHAT_TEXT_LENGTH` in the chat plugin). */
export const SUPPORT_CHAT_MAX_LENGTH = 10_000;

/** Help-agent question cap (mirrors the core-server `MAX_AGENT_QUESTION_LENGTH`). */
export const AGENT_QUESTION_MAX_LENGTH = 2000;

/** True when a question is safe to ask the help-agent. */
export function validateAgentQuestion(text: string): string | null {
  const clean = text.trim();
  if (clean.length === 0) {
    return "Stel eerst een vraag.";
  }
  if (clean.length > AGENT_QUESTION_MAX_LENGTH) {
    return `De vraag is te lang (max ${AGENT_QUESTION_MAX_LENGTH} tekens).`;
  }
  return null;
}

/**
 * Cap a text for the chat protocol. Oversized input is truncated with a clear
 * trailing note so the support desk knows the bundle was cut, instead of a
 * silent mid-sentence break.
 */
export function chatCapText(
  text: string,
  maxLength: number = SUPPORT_CHAT_MAX_LENGTH,
): { text: string; truncated: boolean } {
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }
  const note = "\n… [tekst afgekapt tot het chatlimiet van 10.000 tekens]";
  const headLength = Math.max(0, maxLength - note.length);
  return { text: `${text.slice(0, headLength)}${note}`, truncated: true };
}

/** The last generated bundle as chat text, or null when none was made yet. */
export function bundleAsChatText(): { text: string; truncated: boolean } | null {
  const bundle = lastBundleClipboardText();
  if (!bundle) {
    return null;
  }
  const banner =
    "Hieronder een diagnose-bundel (altijd afgeschermd). Kan de helpdesk kijken?\n";
  return chatCapText(`${banner}${bundle}`);
}

/** Classify a stored message for display in the support thread. */
export function classifyMessage(
  record: ChatMessageRecordView,
  threadPeerId: string,
): "you" | "support" | "other" {
  if (record.fromPeerId === threadPeerId) {
    return "support";
  }
  if (record.toPeerId === threadPeerId) {
    return "you";
  }
  return "other";
}

/** A short Dutch status line for an agent ask failure (fallback for UI text). */
export function agentAskFailure(result: Extract<HelpAgentAskResult, { ok: false }>): string {
  switch (result.code) {
    case "ai-not-configured":
      return "De help-agent heeft een AI-provider nodig. Configureer er een en probeer opnieuw.";
    case "ai-unavailable":
      return result.detail || "De AI-provider is op dit moment niet bereikbaar. Probeer het later.";
    case "invalid-question":
      return result.detail || "De vraag kon niet worden verwerkt.";
    default:
      return result.detail || "Er ging iets mis bij het stellen van de vraag.";
  }
}
