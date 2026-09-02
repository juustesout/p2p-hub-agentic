import { useState } from "react";
import type { HelpAgentProposal, HelpSourceRef } from "../../types";
import { coreBridge } from "../../services/core-bridge";
import {
  agentAskFailure,
  AGENT_QUESTION_MAX_LENGTH,
  validateAgentQuestion,
} from "./support";
import {
  AlertTriangle,
  Bot,
  BookOpen,
  Loader2,
  ListChecks,
  Send,
  Sparkles,
} from "lucide-react";

/**
 * The "Help-agent" tab (Brief 7D): a read-only assistant that reasons over the
 * same offline documentation the user reads, plus a secret-free snapshot of
 * the server state. Propose-then-confirm: it answers with a proposal and
 * numbered steps the *operator* carries out themselves — there is no button
 * that lets the agent touch the system, and its question is the only text that
 * ever leaves the machine (to the operator-configured AI provider).
 */
export function HelpAgentTab({ onOpenDoc }: { onOpenDoc: (docId: string) => void }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<HelpAgentProposal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    const invalid = validateAgentQuestion(question);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await coreBridge.helpAgentAsk(question.trim());
      if (result.ok) {
        setProposal(result.proposal);
      } else {
        setProposal(null);
        setError(agentAskFailure(result));
      }
    } catch (err) {
      setProposal(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
            <Sparkles size={14} className="shrink-0 text-sky-400" />
            <input
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void ask();
                }
              }}
              placeholder="Stel een vraag over de app, bijvoorbeeld: 'de app start niet meer'"
              maxLength={AGENT_QUESTION_MAX_LENGTH}
              className="w-full bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => void ask()}
            disabled={busy || !question.trim()}
            className="flex items-center gap-1.5 rounded-xl bg-sky-500 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-40"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Stel vraag
          </button>
        </div>
        <p className="flex items-center gap-1.5 text-[10px] leading-relaxed text-slate-500">
          <AlertTriangle size={11} className="shrink-0 text-amber-400/70" />
          De agent leest alleen documentatie en geeft een voorstel — hij voert
          niets zelf uit. Stuur nooit geheimen of een bundel via deze agent:
          je vraag gaat naar de geconfigureerde AI-provider.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!proposal && !error && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Bot size={30} className="text-sky-500/40" />
            <p className="max-w-sm text-xs leading-relaxed text-slate-500">
              De help-agent beantwoordt vragen met de offline documentatie als
              bron. Vind je het antwoord niet, dan kun je daarna alsnog een
              diagnose-bundel maken en die naar de helpdesk sturen.
            </p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2.5 text-xs text-amber-200/90">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {proposal && (
          <div className="space-y-4">
            <section className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Antwoord
              </p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-100">
                {proposal.answer}
              </p>
            </section>

            {proposal.steps.length > 0 && (
              <section className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <ListChecks size={12} />
                  Stel voor, voer zelf uit
                </p>
                <ol className="space-y-2">
                  {proposal.steps.map((step, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-slate-200">
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-[10px] font-semibold text-sky-300">
                        {i + 1}
                      </span>
                      <span className="leading-relaxed">{step}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {proposal.sources.length > 0 && (
              <section className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Bronnen in de documentatie
                </p>
                <ul className="space-y-1.5">
                  {proposal.sources.map((source) => (
                    <SourceRow key={source.docId} source={source} onOpenDoc={onOpenDoc} />
                  ))}
                </ul>
              </section>
            )}

            <button
              type="button"
              onClick={() => {
                setProposal(null);
                setQuestion("");
              }}
              className="text-xs text-slate-500 transition-colors hover:text-slate-300"
            >
              Nieuwe vraag
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SourceRow({
  source,
  onOpenDoc,
}: {
  source: HelpSourceRef;
  onOpenDoc: (docId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenDoc(source.docId)}
        title="Open in Documentatie"
        className="flex w-full items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-1.5 text-left text-xs text-slate-300 transition-colors hover:bg-white/[0.06]"
      >
        <BookOpen size={12} className="shrink-0 text-sky-400/70" />
        <span className="min-w-0 flex-1 truncate">{source.title}</span>
      </button>
    </li>
  );
}
