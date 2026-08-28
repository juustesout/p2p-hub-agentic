import { useEffect, useState } from "react";
import { useApp } from "./state/AppState";
import { pluginBridge } from "./services/plugin-bridge";
import { LockScreen } from "./components/LockScreen";
import { Taskbar } from "./components/Taskbar";
import { StartMenu } from "./components/StartMenu";
import { PeerInspector } from "./components/PeerInspector";
import { HermesSidebar } from "./components/HermesSidebar";
import { VaultModal } from "./components/VaultModal";
import { SettingsWindow } from "./components/SettingsWindow";
import { Toasts } from "./components/Toasts";
import { PluginWindow } from "./components/PluginWindow";
import { SiteViewer } from "./components/SiteViewer";
import { WindowManager, type ManagedWindow } from "./components/WindowManager";
import type { CapabilityPlugin } from "./types";

export default function App() {
  const { capabilities, vaultGate, gateKnown } = useApp();
  const [startOpen, setStartOpen] = useState(false);
  const [hermesOpen, setHermesOpen] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [windows, setWindows] = useState<ManagedWindow[]>([]);

  // Register each plugin's *manifest-declared* UI skill allowlist with the
  // secure plugin bridge so a plugin iframe can only ever call the skills its
  // manifest explicitly opted into (`ui.skills`), never the full skill list.
  useEffect(() => {
    pluginBridge.clearCapabilities();
    if (!capabilities) {
      return;
    }
    for (const plugin of capabilities.local.plugins) {
      const skills = plugin.ui?.skills ?? [];
      if (skills.length > 0) {
        pluginBridge.registerCapability(plugin.id, skills);
      }
    }
  }, [capabilities]);

  // Vault lock-gate (Slice 2): before the first `/api/health` read the shell
  // cannot know whether the vault is locked, so it renders a plain backdrop
  // (fail-closed — never the desktop with its stale vault view). While
  // `locked`, the whole desktop is replaced by the unlock screen.
  if (!gateKnown) {
    return <div className="h-full w-full bg-slate-950" />;
  }
  if (vaultGate.locked) {
    return <LockScreen />;
  }

  const openWindow = (
    id: string,
    title: string,
    render: () => React.ReactNode,
    size?: { w?: number; h?: number },
  ) => {
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
          w: size?.w ?? 720,
          h: size?.h ?? 480,
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

  const openPluginWindow = (plugin: CapabilityPlugin) =>
    openWindow(
      `plugin:${plugin.id}`,
      plugin.name,
      () => <PluginWindow plugin={plugin} />,
      { w: plugin.ui?.defaultWidth, h: plugin.ui?.defaultHeight },
    );

  const openSiteWindow = (peerId: string, title: string) =>
    openWindow(
      `site:${peerId}`,
      title,
      () => <SiteViewer peerId={peerId} />,
      { w: 960, h: 640 },
    );

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
          onOpenPlugin={(plugin) => {
            openPluginWindow(plugin);
            setStartOpen(false);
          }}
          onOpenSite={(peerId, title) => {
            openSiteWindow(peerId, title);
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
