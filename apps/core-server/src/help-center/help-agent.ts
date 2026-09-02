import {
  HELP_CENTER_DOCS,
  docPlainText,
  searchDocs,
  type HelpDoc,
} from "@p2p-hub/sdk";

/**
 * HelpCenter read-only help-agent (Brief 7D — Pijler E/G).
 *
 * The agent answers questions by reasoning over the *same* offline knowledge
 * base the user reads in the Documentatie tab (`HELP_CENTER_DOCS` from the
 * SDK), plus a small, secret-free snapshot of the server's current state. It
 * is strictly **read-only** and follows **propose-then-confirm**:
 *
 * - its only "tools" are the local docs corpus and the live state snapshot —
 *   it can never call a skill, read a vault secret or write anything;
 * - the model result is a proposal: a plain-text answer plus numbered steps
 *   the *operator* can take themselves. The agent never claims to have
 *   executed anything and there is no "confirm → let the agent do it" path.
 *
 * The raw AI key never touches this class: it consumes a `CoreAIProvider`
 * (the single component allowed to read `ai.*` vault secrets), so the secret
 * stays in exactly one place and everything else gets a capability, not a
 * value (CLAUDE.md principle #6).
 */

export const MAX_AGENT_QUESTION_LENGTH = 2000;
export const MAX_AGENT_ANSWER_LENGTH = 4000;
export const MAX_AGENT_STEPS = 5;
export const MAX_AGENT_STEP_LENGTH = 240;
const TOP_DOCS = 3;
const DOC_BODY_CONTEXT_CHARS = 700;

/** Secret-free, JSON-safe snapshot of the server's current state. */
export interface HelpAgentState {
  safeMode: boolean;
  networkPaused: boolean;
  vaultExists: boolean;
  vaultUnlocked: boolean;
}

/** A doc the proposal was grounded on (its full text is rendered client-side). */
export interface HelpSourceRef {
  docId: string;
  title: string;
}

export interface HelpAgentProposal {
  question: string;
  answer: string;
  steps: string[];
  sources: HelpSourceRef[];
}

export type HelpAgentResult =
  | { ok: true; proposal: HelpAgentProposal }
  | { ok: false; error: HelpAgentError };

export interface HelpAgentError {
  code:
    | "ai-not-configured"
    | "ai-unavailable"
    | "invalid-question";
  /** Human-readable (Dutch) detail; never contains secrets or stack traces. */
  detail: string;
}

/**
 * The minimal AI surface the agent needs. `CoreAIProvider` satisfies this
 * structurally; tests inject a stub so no vault/key is required to exercise
 * the propose/parse logic.
 */
export interface HelpAgentAI {
  isConfigured(): Promise<boolean>;
  generateText(options: {
    prompt: string;
    system?: string;
    temperature?: number;
  }): Promise<string>;
}

const SYSTEM_PROMPT = [
  "Je bent de help-assistent van het P2P Hub HelpCenter.",
  "Je antwoordt altijd in het Nederlands, kort en concreet.",
  "Je baseert je uitsluitend op de meegeleverde kennisbank-fragmenten en de situatie-samenvatting.",
  "Vermoed je een antwoord niet zeker te weten, zeg dat dan eerlijk en verwijs naar een van de getoonde documenten.",
  "Je voert NOOIT zelf acties uit en je beweert nooit dat je iets hebt uitgevoerd.",
  "Geef antwoord in exact dit JSON-formaat (geen andere tekst ervoor of erna):",
  '{"answer": "...", "steps": ["...", "..."]}',
  "- `answer`: je antwoord, met bronverwijzingen naar documenttitels tussen dubbele aanhalingstekens.",
  "- `steps`: maximaal 5 voorgestelde stappen die de GEBRUIKER zelf kan doen. Elke stap begint met een werkwoord (bijv. \"Open\", \"Controleer\", \"Maak\").",
  "- Een stap is nooit 'geef deze bundel aan de agent' en verwijst nooit naar geheimen.",
].join("\n");

/** Build the bullet list of the current situation for the LLM context. */
export function describeState(state: HelpAgentState): string {
  const lines = [
    `- Veilige modus actief: ${state.safeMode ? "ja" : "nee"}`,
    `- Netwerk gepauzeerd: ${state.networkPaused ? "ja" : "nee"}`,
    `- Vault aanwezig: ${state.vaultExists ? "ja" : "nee"}`,
    `- Vault ontgrendeld: ${state.vaultUnlocked ? "ja" : "nee"}`,
  ];
  return lines.join("\n");
}

/** Truncate a doc's plain text to a bounded context window. */
function docContext(doc: HelpDoc): string {
  const body = docPlainText(doc.markdown);
  const clipped =
    body.length > DOC_BODY_CONTEXT_CHARS
      ? `${body.slice(0, DOC_BODY_CONTEXT_CHARS).trimEnd()}\u2026`
      : body;
  return [
    `Document "${doc.title}"`,
    `  Samenvatting: ${doc.summary}`,
    `  Trefwoorden: ${doc.keywords.join(", ")}`,
    `  Tekst: ${clipped}`,
  ].join("\n");
}

/** Best-effort extraction of the JSON object the model was asked for. */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to the bracket scan below
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function clampString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    return "";
  }
  const text = value.trim();
  if (text.length === 0) {
    return "";
  }
  return text.length > maxLength ? text.slice(0, maxLength).trimEnd() : text;
}

export class HelpAgent {
  constructor(
    private readonly ai: HelpAgentAI,
    private readonly state: () => HelpAgentState,
    /** Injectable corpus for tests; defaults to the shared SDK knowledge base. */
    private readonly docs: HelpDoc[] = HELP_CENTER_DOCS,
  ) {}

  /** True when an AI provider is configured (key present or a local endpoint). */
  async available(): Promise<boolean> {
    try {
      return await this.ai.isConfigured();
    } catch {
      return false;
    }
  }

  /**
   * Answer one operator question. Never throws for domain reasons; an
   * unreachable/misconfigured AI or an unusable model reply becomes a typed
   * {@link HelpAgentResult} instead.
   */
  async ask(question: unknown): Promise<HelpAgentResult> {
    if (typeof question !== "string" || question.trim().length === 0) {
      return {
        ok: false,
        error: {
          code: "invalid-question",
          detail: "Stel eerst een vraag in het tekstveld.",
        },
      };
    }
    const clean = question.trim().slice(0, MAX_AGENT_QUESTION_LENGTH);

    if (!(await this.available())) {
      return {
        ok: false,
        error: {
          code: "ai-not-configured",
          detail:
            "De help-agent heeft een AI-provider nodig. Configureer er een in de Vault- of AI-instellingen (ai.apiKey / ai.baseUrl) en probeer opnieuw.",
        },
      };
    }

    const hits = searchDocs(this.docs, clean).slice(0, TOP_DOCS);
    const context = hits.map((h) => docContext(h.doc)).join("\n\n");
    const state = describeState(this.state());
    const prompt = [
      `Vraag van de gebruiker: "${clean}"`,
      "",
      "Situatie van de app op dit moment:",
      state,
      "",
      "Kennisbank-fragmenten die relevant kunnen zijn:",
      context,
    ].join("\n");

    let raw: string;
    try {
      raw = await this.ai.generateText({
        prompt,
        system: SYSTEM_PROMPT,
        temperature: 0.2,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      if (/quota|AI request failed|fetch failed|network/i.test(message)) {
        return {
          ok: false,
          error: {
            code: "ai-unavailable",
            detail: `De AI-provider kon niet worden bereikt (${message}). Probeer het later opnieuw.`,
          },
        };
      }
      return {
        ok: false,
        error: {
          code: "ai-unavailable",
          detail: "De AI-provider gaf geen bruikbaar antwoord. Probeer het opnieuw.",
        },
      };
    }

    const parsed = extractJsonObject(raw);
    const answer = clampString(parsed?.answer, MAX_AGENT_ANSWER_LENGTH);
    const rawSteps = Array.isArray(parsed?.steps) ? parsed.steps : [];
    const steps = rawSteps
      .map((s) => clampString(s, MAX_AGENT_STEP_LENGTH))
      .filter((s) => s.length > 0)
      .slice(0, MAX_AGENT_STEPS);

    if (answer.length === 0) {
      // The model did not return the requested JSON envelope — degrade to the
      // raw text rather than showing an empty answer, but never fabricate steps.
      return {
        ok: true,
        proposal: {
          question: clean,
          answer: clampString(raw, MAX_AGENT_ANSWER_LENGTH),
          steps: [],
          sources: hits.map((h) => ({ docId: h.doc.id, title: h.doc.title })),
        },
      };
    }

    return {
      ok: true,
      proposal: {
        question: clean,
        answer,
        steps,
        sources: hits.map((h) => ({ docId: h.doc.id, title: h.doc.title })),
      },
    };
  }
}
