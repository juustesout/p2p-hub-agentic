import { useApp } from "../state/AppState";
import type { ConnectionState } from "../types";
import { Wifi, WifiOff, RefreshCw, AlertTriangle } from "lucide-react";

const LABELS: Record<ConnectionState, string> = {
  connected: "Connected",
  degraded: "Degraded",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

const ICONS: Record<ConnectionState, typeof Wifi> = {
  connected: Wifi,
  degraded: AlertTriangle,
  reconnecting: RefreshCw,
  offline: WifiOff,
};

const COLORS: Record<ConnectionState, string> = {
  connected: "text-emerald-400",
  degraded: "text-amber-400",
  reconnecting: "text-sky-400",
  offline: "text-slate-500",
};

export function ConnectionIndicator() {
  const { connection } = useApp();
  const Icon = ICONS[connection];
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5">
      <Icon
        size={14}
        className={`${COLORS[connection]} ${connection === "reconnecting" ? "animate-spin" : ""}`}
      />
      <span className="text-xs font-medium text-slate-300">
        {LABELS[connection]}
      </span>
    </div>
  );
}
