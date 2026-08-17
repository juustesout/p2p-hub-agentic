import { useEffect, useState } from "react";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { PeerBadge } from "./PeerBadge";
import {
  Grid2x2,
  Search,
  Network,
  KeyRound,
  Bot,
  Settings,
} from "lucide-react";

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="flex flex-col items-end leading-tight px-2 text-right">
      <span className="text-xs font-medium text-slate-200 tabular-nums">
        {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
      <span className="text-[10px] text-slate-400">
        {now.toLocaleDateString([], { month: "short", day: "numeric" })}
      </span>
    </div>
  );
}

interface TaskbarProps {
  startOpen: boolean;
  onToggleStart: () => void;
  hermesOpen: boolean;
  onToggleHermes: () => void;
  onOpenVault: () => void;
  onOpenInspector: () => void;
}

export function Taskbar({
  startOpen,
  onToggleStart,
  hermesOpen,
  onToggleHermes,
  onOpenVault,
  onOpenInspector,
}: TaskbarProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 z-40 flex items-center justify-center px-3 pb-2">
      <div className="glass-strong flex h-14 w-full max-w-5xl items-center gap-1 rounded-2xl px-2">
        {/* Start */}
        <button
          onClick={onToggleStart}
          className={`flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
            startOpen ? "bg-white/20" : "hover:bg-white/10"
          }`}
          aria-label="Start"
        >
          <Grid2x2 size={22} className="text-sky-400" />
        </button>

        <div className="mx-1 h-8 w-px bg-white/10" />

        {/* Pinned apps */}
        <button
          onClick={onOpenInspector}
          className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-300 transition-colors hover:bg-white/10"
          aria-label="Peer inspector"
          title="Peer & Capability Inspector"
        >
          <Network size={20} />
        </button>
        <button
          onClick={onOpenVault}
          className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-300 transition-colors hover:bg-white/10"
          aria-label="Vault"
          title="Zero-trust vault"
        >
          <KeyRound size={20} />
        </button>
        <button
          onClick={onToggleHermes}
          className={`flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
            hermesOpen ? "bg-white/20 text-sky-300" : "text-slate-300 hover:bg-white/10"
          }`}
          aria-label="Hermes orchestrator"
          title="Hermes MCP orchestrator"
        >
          <Bot size={20} />
        </button>
        <button
          className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-300 transition-colors hover:bg-white/10"
          aria-label="Search"
          title="Search"
        >
          <Search size={20} />
        </button>
        <button
          className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-300 transition-colors hover:bg-white/10"
          aria-label="Settings"
          title="Settings"
        >
          <Settings size={20} />
        </button>

        {/* Right cluster */}
        <div className="ml-auto flex items-center gap-2 pr-1">
          <PeerBadge />
          <ConnectionIndicator />
          <Clock />
        </div>
      </div>
    </div>
  );
}
