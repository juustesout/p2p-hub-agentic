import { useState } from "react";
import { useApp } from "../state/AppState";
import type { RemotePeer } from "../types";
import {
  Server,
  Network,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  Activity,
} from "lucide-react";

export function PeerInspector() {
  const { capabilities } = useApp();
  const peers = capabilities?.remote.peers ?? [];
  const skills = capabilities?.local.skills ?? [];
  const plugins = capabilities?.local.plugins ?? [];
  const events = capabilities?.local.events ?? [];

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 text-sm">
      <header>
        <h2 className="flex items-center gap-2 text-base font-semibold text-slate-100">
          <Network size={18} className="text-sky-400" />
          Peer & Capability Inspector
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Local plugins and skills, plus discovered P2P peers and their advertised
          capabilities.
        </p>
      </header>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Remote peers ({peers.length})
        </h3>
        {peers.length === 0 && (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-slate-500">
            No peers discovered. Peers appear here via mDNS discovery once they
            advertise compatible skills on the LAN.
          </p>
        )}
        <div className="flex flex-col gap-2">
          {peers.map((peer) => (
            <PeerCard key={peer.id} peer={peer} />
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Local plugins ({plugins.length})
        </h3>
        <div className="flex flex-col gap-2">
          {plugins.map((plugin) => (
            <div
              key={plugin.id}
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-3"
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 font-medium text-slate-200">
                  <Server size={14} className="text-sky-400" />
                  {plugin.name}
                </span>
                <span className="text-[10px] text-slate-500">
                  {plugin.kind} · v{plugin.version}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {skills
                  .filter((s) => s.pluginId === plugin.id)
                  .map((s) => (
                    <span
                      key={s.skill}
                      className={`rounded-md px-2 py-0.5 text-[11px] ${
                        s.localOnly
                          ? "bg-slate-700/60 text-slate-300"
                          : "bg-emerald-500/20 text-emerald-300"
                      }`}
                    >
                      {s.skill}
                    </span>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          <Activity size={12} />
          Exposed events
        </h3>
        <div className="flex flex-wrap gap-1">
          {events.map((event) => (
            <span
              key={event}
              className="rounded-md bg-white/5 px-2 py-0.5 font-mono text-[11px] text-sky-200"
            >
              {event}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

function PeerCard({ peer }: { peer: RemotePeer }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="font-medium text-slate-200">{peer.name}</span>
        </div>
        <span className="flex items-center gap-1 text-[10px] text-slate-500">
          <ShieldCheck size={12} className="text-emerald-400" />
          {peer.trust}
        </span>
      </button>
      <div className="mt-1 pl-6 text-xs text-slate-500">
        <span className="font-mono">{peer.address}</span>
      </div>
      {open && (
        <div className="mt-2 pl-6">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
            Transport
          </p>
          <p className="text-xs text-slate-300">{peer.transport}</p>
          <p className="mt-2 mb-1 text-[10px] uppercase tracking-wider text-slate-500">
            Advertised skills
          </p>
          <div className="flex flex-wrap gap-1">
            {peer.skills.map((skill) => (
              <span
                key={skill}
                className="rounded-md bg-white/10 px-2 py-0.5 font-mono text-[11px] text-sky-200"
              >
                {skill}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
