import { useEffect, useRef, useState } from "react";
import { useApp } from "../state/AppState";
import { Bot, Send, Sparkles, X, Zap } from "lucide-react";

interface ChatEntry {
  role: "user" | "assistant" | "error";
  text: string;
  ts: number;
}

interface HermesSidebarProps {
  open: boolean;
  onToggle: () => void;
}

const QUICK_ACTIONS: Array<{ label: string; serviceId: string; method: string; args: unknown }> = [
  { label: "List events", serviceId: "calendar", method: "listEvents", args: null },
  { label: "Ping core", serviceId: "core", method: "echo", args: { hello: "world" } },
];

export function HermesSidebar({ open, onToggle }: HermesSidebarProps) {
  const { activities, capabilities, execute } = useApp();
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [history, activities]);

  const skills = capabilities?.local.skills ?? [];

  const push = (entry: ChatEntry) => setHistory((prev) => [...prev, entry]);

  const runCommand = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    push({ role: "user", text: trimmed, ts: Date.now() });
    setInput("");
    setBusy(true);
    try {
      // If the text names a known skill, resolve it through the TaskBroker.
      const named = skills.find((s) => s.skill === trimmed || trimmed.startsWith(`${s.skill} `));
      if (named) {
        const [serviceId, ...rest] = named.skill.split(".");
        const method = rest.join(".");
        const args = trimmed === named.skill ? null : trimmed.slice(named.skill.length + 1);
        const result = await execute({ serviceId, method, arguments: args });
        push({
          role: result.status === "ok" ? "assistant" : "error",
          text: result.status === "ok" ? formatResult(result.result) : `Error: ${result.error}`,
          ts: Date.now(),
        });
        return;
      }

      // Otherwise route the natural-language request to the AI provider
      // (which reads its key from the vault — never exposed to this UI).
      const result = await execute({
        serviceId: "core.ai",
        method: "generateText",
        arguments: { prompt: trimmed },
      });
      push({
        role: result.status === "ok" ? "assistant" : "error",
        text: result.status === "ok" ? String(result.result) : `Error: ${result.error}`,
        ts: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  };

  const taskActivities = activities.filter(
    (a) => a.event === "task:started" || a.event === "task:completed",
  );

  if (!open) {
    return null;
  }

  return (
    <div className="absolute right-0 top-0 z-40 flex h-full w-[400px] flex-col border-l border-white/10 bg-slate-900/90 backdrop-blur-2xl">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/20 text-sky-300">
            <Bot size={18} />
          </span>
          <div>
            <p className="text-sm font-semibold text-slate-100">Hermes</p>
            <p className="text-[10px] text-slate-500">MCP orchestrator</p>
          </div>
        </div>
        <button
          onClick={onToggle}
          className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10"
          aria-label="Close Hermes"
        >
          <X size={18} />
        </button>
      </div>

      {/* Chat */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {history.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-slate-500">
            Ask Hermes to orchestrate a task. It routes through the TaskBroker to
            a local plugin, a remote peer, or the AI provider.
          </div>
        )}
        {history.map((entry, index) => (
          <div
            key={index}
            className={`flex ${entry.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                entry.role === "user"
                  ? "bg-sky-500/20 text-sky-100"
                  : entry.role === "error"
                    ? "bg-red-500/15 text-red-200"
                    : "bg-white/5 text-slate-200"
              }`}
            >
              {entry.text}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Sparkles size={12} className="animate-pulse" /> routing…
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-1.5 px-4 pb-2">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            onClick={() =>
              void runCommand(`${action.serviceId}.${action.method}`)
            }
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 hover:bg-white/10"
          >
            {action.label}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="border-t border-white/10 p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runCommand(input);
          }}
          className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe a task or name a skill…"
            className="w-full bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg p-1.5 text-sky-300 hover:bg-white/10 disabled:opacity-40"
            aria-label="Send"
          >
            <Send size={16} />
          </button>
        </form>
      </div>

      {/* Live action feed */}
      <div className="border-t border-white/10 px-4 py-3">
        <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          <Zap size={11} className="text-amber-300" />
          Live action feed
        </p>
        <div className="max-h-28 space-y-1 overflow-y-auto">
          {taskActivities.length === 0 && (
            <p className="text-xs text-slate-600">No tasks yet.</p>
          )}
          {taskActivities.slice(-12).map((activity, index) => {
            const payload = activity.payload as { method?: unknown; status?: unknown; peerId?: unknown };
            return (
              <div key={index} className="flex items-center gap-2 text-[11px] text-slate-400">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    activity.event === "task:started" ? "bg-sky-400" : "bg-emerald-400"
                  }`}
                />
                <span className="font-mono">{String(payload.method ?? "?")}</span>
                <span className="text-slate-600">{activity.event.replace("task:", "")}</span>
                {payload.peerId ? (
                  <span className="text-slate-600">→ peer</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  return JSON.stringify(result, null, 2);
}
