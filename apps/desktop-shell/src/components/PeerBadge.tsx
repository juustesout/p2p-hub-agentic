import { useApp } from "../state/AppState";
import { Users } from "lucide-react";

export function PeerBadge() {
  const { capabilities, connection } = useApp();
  const peerCount = capabilities?.remote.peers.length ?? 0;
  const ready = capabilities?.local.connection.ready ?? false;

  return (
    <div
      className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5"
      title={`${ready ? "mDNS/TLS network healthy" : "network transport not ready"} · ${peerCount} peer(s) online`}
    >
      <Users size={14} className={ready ? "text-sky-300" : "text-slate-500"} />
      <span className="text-xs font-medium text-slate-300">{peerCount}</span>
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          connection === "connected" ? "bg-emerald-400" : "bg-slate-500"
        }`}
      />
    </div>
  );
}
