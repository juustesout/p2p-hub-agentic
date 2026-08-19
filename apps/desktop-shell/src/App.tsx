import { useEffect, useState } from "react";
import { useApp } from "./state/AppState";
import { pluginBridge } from "./services/plugin-bridge";
import { Taskbar } from "./components/Taskbar";
import { StartMenu } from "./components/StartMenu";
import { PeerInspector } from "./components/PeerInspector";
import { HermesSidebar } from "./components/HermesSidebar";
import { VaultModal } from "./components/VaultModal";
import { SettingsWindow } from "./components/SettingsWindow";
import { Toasts } from "./components/Toasts";
import { WindowManager, type ManagedWindow } from "./components/WindowManager";

export default function App() {
  const { capabilities } = useApp();
  const [startOpen, setStartOpen] = useState(false);
  const [hermesOpen, setHermesOpen] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [windows, setWindows] = useState<ManagedWindow[]>([]);

  // Register each plugin's skills with the secure plugin bridge so a plugin
  // iframe can only ever call its own declared capabilities.
  useEffect(() => {
    if (!capabilities) {
      return;
    }
    const byPlugin = new Map<string, string[]>();
    for (const skill of capabilities.local.skills) {
      const list = byPlugin.get(skill.pluginId) ?? [];
      list.push(skill.skill);
      byPlugin.set(skill.pluginId, list);
    }
    for (const [pluginId, skills] of byPlugin) {
      pluginBridge.registerCapability(pluginId, skills);
    }
  }, [capabilities]);

  const openWindow = (id: string, title: string, render: () => React.ReactNode) => {
    setWindows((prev) => {
      if (prev.some((w) => w.id === id)) {
        return prev.map((w) => (w.id === id ? { ...w, minimized: false } : w));
      }
      const count = prev.length;
      return [
        ...prev,
        {
          id,
          title,
          x: 120 + (count % 4) * 40,
          y: 80 + (count % 4) * 32,
          w: 720,
          h: 480,
          minimized: false,
          render,
        },
      ];
    });
  };

  const openPeerInspector = () =>
    openWindow("peer-inspector", "Peer & Capability Inspector", () => (
      <PeerInspector />
    ));

  const openSettings = () =>
    openWindow("settings", "Settings", () => <SettingsWindow />);

  return (
    <div className="relative h-full w-full overflow-hidden bg-slate-950">
      {/* Desktop backdrop */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(56,189,248,0.18),transparent_50%),radial-gradient(ellipse_at_bottom_right,rgba(129,140,248,0.16),transparent_50%)]" />

      <WindowManager windows={windows} setWindows={setWindows} />

      <HermesSidebar
        open={hermesOpen}
        onToggle={() => setHermesOpen((v) => !v)}
      />

      <Toasts />

      {startOpen && (
        <StartMenu
          onClose={() => setStartOpen(false)}
          onOpenVault={() => {
            setVaultOpen(true);
            setStartOpen(false);
          }}
          onOpenInspector={() => {
            openPeerInspector();
            setStartOpen(false);
          }}
          onOpenSettings={() => {
            openSettings();
            setStartOpen(false);
          }}
        />
      )}

      <VaultModal open={vaultOpen} onClose={() => setVaultOpen(false)} />

      <Taskbar
        startOpen={startOpen}
        onToggleStart={() => setStartOpen((v) => !v)}
        hermesOpen={hermesOpen}
        onToggleHermes={() => setHermesOpen((v) => !v)}
        onOpenVault={() => setVaultOpen(true)}
        onOpenInspector={openPeerInspector}
        onOpenSettings={openSettings}
      />
    </div>
  );
}
