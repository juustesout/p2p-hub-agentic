import { useMemo, useState } from "react";
import { useApp } from "../state/AppState";
import type { CapabilityPlugin, CapabilitySkill, RemotePeer } from "../types";
import { Search, KeyRound, Network, Puzzle, Settings, Monitor } from "lucide-react";

interface StartMenuProps {
  onClose: () => void;
  onOpenVault: () => void;
  onOpenInspector: () => void;
  onOpenSettings: () => void;
  onOpenPlugin: (plugin: CapabilityPlugin) => void;
  onOpenSite: (peerId: string, title: string) => void;
}

export function StartMenu({
  onClose,
  onOpenVault,
  onOpenInspector,
  onOpenSettings,
  onOpenPlugin,
  onOpenSite,
}: StartMenuProps) {
  const { capabilities, execute } = useApp();
  const [query, setQuery] = useState("");

  const localSkills = useMemo(
    () => capabilities?.local.skills ?? [],
    [capabilities],
  );
  const peers = useMemo(() => capabilities?.remote.peers ?? [], [capabilities]);
  const plugins = useMemo(() => capabilities?.local.plugins ?? [], [capabilities]);

  const filteredSkills = localSkills.filter((s) =>
    s.skill.toLowerCase().includes(query.toLowerCase()),
  );
  const filteredPeers = peers.filter(
    (p) =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.skills.some((s) => s.toLowerCase().includes(query.toLowerCase())),
  );

  const runSkill = (skill: CapabilitySkill) => {
    const [serviceId, ...rest] = skill.skill.split(".");
    void execute({ serviceId, method: rest.join("."), arguments: null });
  };

  const runRemote = (peer: RemotePeer, skill: string) => {
    const [serviceId, ...rest] = skill.split(".");
    void execute({
      peerId: peer.peerId ?? peer.id,
      serviceId,
      method: rest.join("."),
      arguments: null,
    });
  };

  return (
    <div className="absolute bottom-20 left-1/2 z-50 w-[560px] -translate-x-1/2">
      <div className="panel overflow-hidden">
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
          <Search size={18} className="text-slate-400" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins, skills and peers…"
            className="w-full bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none"
          />
        </div>

        <div className="max-h-[420px] overflow-y-auto p-3">
          <SectionLabel icon={<Puzzle size={14} />} label="Local plugins" />
          <div className="grid grid-cols-2 gap-1">
            {plugins.map((plugin) => {
              const openable = plugin.ui !== null;
              const entry = (
                <>
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/20 text-sky-300">
                    {openable ? <Monitor size={16} /> : <Puzzle size={16} />}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-100">{plugin.name}</p>
                    <p className="truncate text-xs text-slate-500">
                      {plugin.id} · v{plugin.version}
                      {openable ? " · open UI" : ""}
                    </p>
                  </div>
                </>
              );
              if (!openable) {
                return (
                  <div
                    key={plugin.id}
                    className="flex items-center gap-3 rounded-xl px-3 py-2 text-left glass-hover"
                  >
                    {entry}
                  </div>
                );
              }
              return (
                <button
                  key={plugin.id}
                  onClick={() => onOpenPlugin(plugin)}
                  className="flex items-center gap-3 rounded-xl px-3 py-2 text-left glass-hover"
                >
                  {entry}
                </button>
              );
            })}
          </div>

          <SectionLabel icon={<Network size={14} />} label="Local skills" />
          <div className="grid grid-cols-1 gap-1">
            {filteredSkills.map((skill) => (
              <button
                key={skill.skill}
                onClick={() => runSkill(skill)}
                className="flex items-center justify-between rounded-xl px-3 py-2 text-left glass-hover"
              >
                <span className="text-sm text-slate-200">{skill.skill}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] ${
                    skill.localOnly
                      ? "bg-slate-700/60 text-slate-300"
                      : "bg-emerald-500/20 text-emerald-300"
                  }`}
                >
                  {skill.localOnly ? "local" : "network"}
                </span>
              </button>
            ))}
          </div>

          <SectionLabel icon={<Network size={14} />} label="Remote peer services" />
          {filteredPeers.length === 0 && (
            <p className="px-3 py-2 text-xs text-slate-500">
              No peers discovered on the local network.
            </p>
          )}
          {filteredPeers.map((peer) => (
            <div key={peer.id} className="mb-1 rounded-xl bg-white/5 px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-200">{peer.name}</span>
                <span className="flex items-center gap-1">
                  {peer.skills.some((s) => s === "peersite.fetchAsset") && (
                    <button
                      onClick={() => onOpenSite(peer.peerId ?? peer.id, `${peer.name} site`)}
                      title="Open this peer's mirrored P2P website"
                      className="rounded-md bg-emerald-500/20 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/30"
                    >
                      View site
                    </button>
                  )}
                  <span className="text-[10px] text-slate-500">{peer.transport}</span>
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {peer.skills.map((skill) => (
                  <button
                    key={skill}
                    onClick={() => runRemote(peer, skill)}
                    className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] text-sky-200 hover:bg-white/20"
                  >
                    {skill}
                  </button>
                ))}
              </div>
            </div>
          ))}

          <SectionLabel icon={<KeyRound size={14} />} label="System" />
          <button
            onClick={onOpenVault}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left glass-hover"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/20 text-amber-300">
              <KeyRound size={16} />
            </span>
            <span className="text-sm text-slate-100">Vault</span>
          </button>
          <button
            onClick={onOpenInspector}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left glass-hover"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/20 text-purple-300">
              <Network size={16} />
            </span>
            <span className="text-sm text-slate-100">Peer & Capability Inspector</span>
          </button>
          <button
            onClick={onOpenSettings}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left glass-hover"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-500/20 text-slate-300">
              <Settings size={16} />
            </span>
            <span className="text-sm text-slate-100">Settings</span>
          </button>
        </div>
      </div>
      <div className="fixed inset-0 -z-10" onClick={onClose} />
    </div>
  );
}

function SectionLabel({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="mt-3 mb-1 flex items-center gap-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
      {icon}
      {label}
    </div>
  );
}
