import { useEffect, useState } from "react";
import type { HelpTabId } from "../../types";
import {
  currentHelpRequest,
  subscribeHelp,
  type HelpNavRequest,
} from "../../services/help-nav";
import { DiagnoseTab } from "./DiagnoseTab";
import { DocsTab } from "./DocsTab";
import { LogsTab } from "./LogsTab";
import { Activity, BookOpen, ScrollText } from "lucide-react";

interface TabDef {
  id: HelpTabId;
  label: string;
  hint: string;
  icon: React.ReactNode;
}

const TABS: TabDef[] = [
  { id: "diagnose", label: "Diagnose", hint: "Status & bundel", icon: <Activity size={15} /> },
  { id: "logs", label: "Logs", hint: "Bronnen & regels", icon: <ScrollText size={15} /> },
  { id: "docs", label: "Documentatie", hint: "Offline hulp", icon: <BookOpen size={15} /> },
];

/**
 * The "Help & Diagnostiek" window (Pijler C / Brief 7C). A thin chrome around
 * three tabs — Diagnose, Logs and Documentatie — that also follows targeted
 * nav requests (openLogs on source X) published by the shell's entry points.
 */
export function HelpCenterWindow() {
  const [tab, setTab] = useState<HelpTabId>(() => currentHelpRequest().tab);
  const [nav, setNav] = useState<HelpNavRequest | null>(null);

  useEffect(() => {
    const unsub = subscribeHelp((request) => {
      setTab(request.tab);
      setNav(request);
    });
    return unsub;
  }, []);

  return (
    <div className="flex h-full flex-col bg-slate-950/40">
      {/* Tab bar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 px-3 pt-2">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTab(t.id);
                setNav(null);
              }}
              aria-selected={active}
              role="tab"
              className={`flex items-center gap-2 rounded-t-lg px-3 py-2 text-xs transition-colors ${
                active
                  ? "border-b-2 border-sky-400 bg-white/5 text-slate-100"
                  : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
              }`}
            >
              <span className={active ? "text-sky-400" : ""}>{t.icon}</span>
              <span className="font-medium">{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1">
        {tab === "diagnose" && <DiagnoseTab />}
        {tab === "logs" && <LogsTab key={nav?.sourceId ?? "none"} requestedSourceId={nav?.sourceId ?? null} />}
        {tab === "docs" && <DocsTab />}
      </div>
    </div>
  );
}
