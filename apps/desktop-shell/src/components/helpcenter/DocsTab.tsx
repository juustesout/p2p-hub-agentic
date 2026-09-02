import { useMemo, useState } from "react";
import { HELP_DOCS } from "../../assets/docs";
import type { HelpDoc } from "./docs";
import { groupDocs, searchDocs } from "./docs";
import { MarkdownDocView } from "./MarkdownView";
import { BookOpen, ChevronRight, LifeBuoy, Search } from "lucide-react";

/**
 * The Documentation tab of the HelpCenter (Pijler E / Brief 7C): an offline,
 * searchable knowledge base bundled into the app. Left column lists the docs
 * (categorized, or ranked search hits); the right column renders the selected
 * article from its bundled markdown.
 */
export function DocsTab() {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const results = useMemo(() => searchDocs(HELP_DOCS, query), [query]);
  const groups = useMemo(() => groupDocs(HELP_DOCS), []);
  const selected = useMemo(
    () => HELP_DOCS.find((doc) => doc.id === selectedId) ?? null,
    [selectedId],
  );

  const showSearch = query.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Search */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-3">
        <div className="flex flex-1 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
          <Search size={14} className="shrink-0 text-slate-500" />
          <input
            autoFocus={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Doorzoek de documentatie…"
            className="w-full bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => setQuery("")}
          className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-slate-400 hover:bg-white/10"
          title="Wis zoekopdracht"
        >
          Wis
        </button>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* List */}
        <aside className="w-64 shrink-0 space-y-2 overflow-y-auto border-r border-white/10 p-3">
          {!showSearch &&
            groups.map((group) => (
              <div key={group.id} className="space-y-1">
                <p className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  {group.label}
                </p>
                {group.docs.map((doc) => (
                  <DocRow
                    key={doc.id}
                    doc={doc}
                    active={doc.id === selectedId}
                    onSelect={() => setSelectedId(doc.id)}
                  />
                ))}
              </div>
            ))}

          {showSearch && (
            <div className="space-y-1">
              <p className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Zoekresultaten ({results.length})
              </p>
              {results.length === 0 && (
                <p className="px-1 text-xs text-slate-500">
                  Geen artikelen gevonden voor "{query.trim()}".
                </p>
              )}
              {results.map((hit) => (
                <DocRow
                  key={hit.doc.id}
                  doc={hit.doc}
                  active={hit.doc.id === selectedId}
                  onSelect={() => setSelectedId(hit.doc.id)}
                />
              ))}
            </div>
          )}
        </aside>

        {/* Article */}
        <section className="min-w-0 flex-1 overflow-y-auto p-5">
          {!selected ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-slate-600">
              <LifeBuoy size={28} className="text-sky-500/40" />
              <p className="max-w-xs text-xs leading-relaxed">
                Kies links een onderwerp, of typ een vraag in het zoekveld. De
                documentatie is volledig offline beschikbaar.
              </p>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
                  {selected.category === "aan-de-slag" ? "Aan de slag" : "Problemen oplossen"}
                </span>
              </div>
              <MarkdownDocView markdown={selected.markdown} title={selected.title} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function DocRow({
  doc,
  active,
  onSelect,
}: {
  doc: HelpDoc;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
        active
          ? "border-sky-500/40 bg-sky-500/10"
          : "border-white/5 bg-white/[0.03] hover:bg-white/[0.07]"
      }`}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
        <BookOpen size={12} className="shrink-0 text-sky-400/70" />
        <span className="min-w-0 flex-1 truncate">{doc.title}</span>
        <ChevronRight size={12} className="shrink-0 text-slate-600" />
      </span>
      <span className="mt-1 block text-[11px] leading-snug text-slate-500">
        {doc.summary}
      </span>
    </button>
  );
}
