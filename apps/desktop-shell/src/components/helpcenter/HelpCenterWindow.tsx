import { useEffect, useMemo, useState } from "react";
import type { DocsFocus, HelpTabId } from "../../types";
import {
  currentHelpRequest,
  subscribeHelp,
  type HelpNavRequest,
} from "../../services/help-nav";
import { coreBridge } from "../../services/core-bridge";
import { DiagnoseTab } from "./DiagnoseTab";
import { DocsTab } from "./DocsTab";
import { LogsTab } from "./LogsTab";
import { SupportChatTab } from "./SupportChatTab";
import { HelpAgentTab } from "./HelpAgentTab";
import { Activity, BookOpen, Bot, Headset, ScrollText } from "lucide-react";

interface TabDef {
  id: HelpTabId;
  label: string;
  hint: string;
  icon: React.ReactNode;
}

const TAB_BAR: TabDef[] = [
  { id: "diagnose", label: "Diagnose", hint: "Status & bundel", icon: <Activity size={15} /> },
  { id: "logs", label: "Logs", hint: "Bronnen & regels", icon: <ScrollText size={15} /> },
  { id: "chat", label: "Chat met ons", hint: "Helpdesk", icon: <Headset size={15} /> },
  {
    id: "agent",
    label: "Help-agent",
    hint: "Vraag & antwoord",
    icon: <Bot size={15} />,
  },
  { id: "docs", label: "Documentatie", hint: "Offline hulp", icon: <BookOpen size={15} /> },
];

/**
 * The "Help & Diagnostiek" window (Pijler C / Brief 7C, uitgebreid in 7D). A
 * thin chrome around the tabs — Diagnose, Logs, "Chat met ons", Help-agent and
 * Documentatie. The Help-agent tab is only shown when the server reports an AI
 * provider is configured; the chat tab fails closed on its own when no support
 * contact is configured. The window follows targeted nav requests (openLogs on
 * source X, open a doc) published by the shell's entry points and other tabs.
 */
export function HelpCenterWindow() {
  const [tab, setTab] = useState<HelpTabId>(() => currentHelpRequest().tab);
  const [nav, setNav] = useState<HelpNavRequest | null>(null);
  const [agentAvailable, setAgentAvailable] = useState<boolean | null>(null);
  const [docsFocus, setDocsFocus] = useState<DocsFocus | null>(null);

  useEffect(() => {
    const unsub = subscribeHelp((request) => {
      setTab(request.tab);
      setNav(request);
    });
    return unsub;
  }, []);

  // The help-agent tab requires an AI provider; query it once on mount and
  // fail closed (hide the tab) when the server has none configured.
  useEffect(() => {
    let cancelled = false;
    void coreBridge
      .helpAgentStatus()
      .then((status) => {
        if (!cancelled) {
          setAgentAvailable(status.available);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAgentAvailable(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tabs = useMemo(() => {
    if (agentAvailable === true) {
      return TAB_BAR;
    }
    return TAB_BAR.filter((t) => t.id !== "agent");
  }, [agentAvailable]);

  // Never strand the window on a tab that is unavailable (e.g. a stale nav
  // request to "agent" arriving while no AI is configured).
  useEffect(() => {
    if (tab === "agent" && agentAvailable === false) {
      setTab("diagnose");
    }
  }, [tab, agentAvailable]);

  const openDoc = (docId: string) => {
    setDocsFocus({ docId, token: Date.now() });
    setTab("docs");
  };

  return (
    <div className="flex h-full flex-col bg-slate-950/40">
      {/* Tab bar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 px-3 pt-2">
        {tabs.map((t) => {
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
        {tab === "chat" && <SupportChatTab />}
        {tab === "agent" && agentAvailable === true && <HelpAgentTab onOpenDoc={openDoc} />}
        {tab === "docs" && (
          <DocsTab key={docsFocus?.token ?? "none"} focus={docsFocus ?? null} />
        )}
      </div>
    </div>
  );
}
