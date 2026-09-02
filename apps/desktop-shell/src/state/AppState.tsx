import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ActivityEvent,
  Capabilities,
  ConnectionState,
  ExecuteRequest,
  HelpNavRequest,
  TaskResult,
  Toast,
  VaultGateState,
  VaultKeyMeta,
  VaultModelInfo,
} from "../types";
import { coreBridge, initialLockHint } from "../services/core-bridge";
import { activityBus } from "../services/activity-bus";
import { pluginBridge } from "../services/plugin-bridge";
import { notificationsService } from "../services/notifications";
import { attachTrayEvents, type TrayHandlers } from "../services/tray";

interface VaultState {
  keys: VaultKeyMeta[];
  model: VaultModelInfo;
  masterKeyConfigured: boolean;
}

interface AppState {
  capabilities: Capabilities | null;
  connection: ConnectionState;
  activities: ActivityEvent[];
  toasts: Toast[];
  vault: VaultState;
  /** Vault lock-gate + network state (Slice 2). `locked` gates the UI. */
  vaultGate: VaultGateState;
  /** True once `/api/health` has been read at least once. Until then the UI
   *  must not render anything — it cannot know whether the vault is locked. */
  gateKnown: boolean;
  refreshCapabilities: () => Promise<void>;
  refreshVault: () => Promise<void>;
  refreshHealth: () => Promise<void>;
  unlockVault: (masterKey: string) => Promise<{ ok: boolean; error?: string }>;
  lockVault: () => Promise<void>;
  setNetworkPaused: (paused: boolean) => Promise<void>;
  execute: (req: ExecuteRequest) => Promise<TaskResult>;
  vaultSet: (key: string, value: string) => Promise<void>;
  vaultDelete: (key: string) => Promise<void>;
  dismissToast: (id: string) => void;
}

const emptyVault: VaultState = {
  keys: [],
  model: { hasModel: false, hasBaseUrl: false, hasApiKey: false },
  masterKeyConfigured: false,
};

/**
 * Fail-closed default: assume the vault is locked until `/api/health` is read.
 * `gateKnown` flips true on the first successful read; until then the shell
 * renders nothing (it cannot know whether the vault needs unlocking).
 */
const closedVaultGate: VaultGateState = {
  locked: true,
  vaultExists: false,
  networkPaused: false,
};

const AppContext = createContext<AppState | null>(null);

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(
    coreBridge.getState(),
  );
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [vault, setVault] = useState<VaultState>(emptyVault);
  const [vaultGate, setVaultGate] = useState<VaultGateState>(closedVaultGate);
  const [gateKnown, setGateKnown] = useState(false);

  // Mirror for the tray handlers: they must read the *current* pause state
  // without forcing the whole effect to re-run on every health poll.
  const vaultGateRef = useRef(vaultGate);
  vaultGateRef.current = vaultGate;

  // Seed the lock state from the boot-handshake hint (Slice 2). This is a
  // startup hint only — `/api/health` in `refreshHealth` is authoritative and
  // flips `gateKnown` once read.
  useEffect(() => {
    let cancelled = false;
    void initialLockHint().then((hint) => {
      if (!cancelled && hint !== null) {
        setVaultGate((g) => ({ ...g, locked: hint }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const pushToast = useCallback(
    (
      title: string,
      body: string,
      kind: Toast["kind"] = "info",
      details?: HelpNavRequest | null,
    ) => {
      const toast: Toast = {
        id: makeId(),
        title,
        body,
        kind,
        ts: Date.now(),
        ...(details ? { details } : {}),
      };
      setToasts((prev) => [...prev.slice(-4), toast]);
      return toast.id;
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const refreshCapabilities = useCallback(async () => {
    try {
      const caps = await coreBridge.getCapabilities();
      setCapabilities(caps);
    } catch (err) {
      // Server not reachable yet; keep last-known state. Log so the client
      // diagnostics forwarder can surface it in the on-disk log.
      console.error("[shell] refreshCapabilities failed", err);
    }
  }, []);

  const refreshVault = useCallback(async () => {
    try {
      const [keys, model] = await Promise.all([
        coreBridge.vaultKeys(),
        coreBridge.vaultModel(),
      ]);
      setVault({
        keys: keys.keys,
        model,
        masterKeyConfigured: keys.masterKeyConfigured,
      });
    } catch (err) {
      console.error("[shell] refreshVault failed", err);
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const gate = await coreBridge.getHealth();
      setVaultGate(gate);
      setGateKnown(true);
      if (gate.locked) {
        // The vault surface is gated while locked — don't leak a stale
        // unlocked vault view into the lock screen.
        setVault(emptyVault);
      }
    } catch (err) {
      // Core-server not reachable yet; keep last-known gate.
      console.error("[shell] refreshHealth failed", err);
    }
  }, []);

  const unlockVault = useCallback(
    async (masterKey: string) => {
      try {
        const result = await coreBridge.unlockVault(masterKey);
        if (result.ok) {
          await refreshHealth();
          await refreshVault();
          void refreshCapabilities();
        } else {
          console.error("[shell] unlock rejected", result.error);
        }
        return result;
      } catch (err) {
        console.error("[shell] unlockVault failed", err);
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [refreshHealth, refreshVault, refreshCapabilities],
  );

  const lockVault = useCallback(async () => {
    await coreBridge.lockVault();
    await refreshHealth();
    setVault(emptyVault);
  }, [refreshHealth]);

  const setNetworkPaused = useCallback(
    async (paused: boolean) => {
      await coreBridge.setNetworkPaused(paused);
      await refreshHealth();
    },
    [refreshHealth],
  );

  useEffect(() => {
    pluginBridge.attach();
    coreBridge.connect();
    notificationsService.attach();

    const offState = coreBridge.onStateChange(setConnection);
    const offEvents = activityBus.subscribeAll((event) => {
      setActivities(activityBus.recent());
      routeEvent(event);
    });

    function routeEvent(event: ActivityEvent) {
      switch (event.event) {
        case "vault:unlocked":
          setVaultGate((g) => ({ ...g, locked: false }));
          void refreshVault();
          void refreshCapabilities();
          break;
        case "vault:locked":
          setVaultGate((g) => ({ ...g, locked: true }));
          setVault(emptyVault);
          break;
        case "network:paused":
          setVaultGate((g) => ({ ...g, networkPaused: true }));
          break;
        case "network:resumed":
          setVaultGate((g) => ({ ...g, networkPaused: false }));
          break;
        case "calendar:eventAdded": {
          const payload = event.payload as { title?: unknown } | null;
          pushToast("Calendar", `New event: ${String(payload?.title ?? "untitled")}`, "success");
          break;
        }
        case "peer:connected": {
          const payload = event.payload as { name?: unknown } | null;
          pushToast("Peer connected", String(payload?.name ?? "unknown peer"), "success");
          break;
        }
        case "peer:disconnected": {
          pushToast("Peer disconnected", "A peer left the network", "info");
          break;
        }
        case "vault:updated": {
          const payload = event.payload as { key?: unknown; action?: unknown } | null;
          pushToast("Vault", `${String(payload?.action ?? "updated")} ${String(payload?.key ?? "")}`, "info");
          void refreshVault();
          break;
        }
        case "core:ready":
          void refreshCapabilities();
          break;
        case "task:completed": {
          const payload = event.payload as { status?: unknown } | null;
          if (payload?.status === "error") {
            pushToast(
              "Task failed",
              "A task completed with an error",
              "error",
              // Contextual HelpCenter open: the error surface is the Logs tab.
              { tab: "logs" },
            );
          }
          break;
        }
        default:
          break;
      }
    }

    let unlistenTray: (() => void) | undefined;
    const trayHandlers: TrayHandlers = {
      onLockVault: () => {
        void lockVault();
      },
      onToggleNetwork: () => {
        void setNetworkPaused(!vaultGateRef.current.networkPaused);
      },
    };
    void attachTrayEvents(trayHandlers).then((un) => {
      unlistenTray = un;
    });

    void refreshHealth();
    void refreshCapabilities();
    void refreshVault();

    // Re-poll capabilities on a timer to pick up peer churn and any plugins
    // that appear without emitting events.
    const interval = window.setInterval(() => {
      void refreshCapabilities();
      void refreshHealth();
    }, 10_000);

    return () => {
      window.clearInterval(interval);
      unlistenTray?.();
      notificationsService.detach();
      offState();
      offEvents();
      coreBridge.disconnect();
    };
  }, [pushToast, refreshCapabilities, refreshVault, refreshHealth, lockVault, setNetworkPaused]);

  const execute = useCallback(
    async (req: ExecuteRequest): Promise<TaskResult> => {
      try {
        return await coreBridge.execute(req);
      } catch (err) {
        return {
          taskId: req.requestId ?? makeId(),
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [],
  );

  const vaultSet = useCallback(
    async (key: string, value: string) => {
      await coreBridge.vaultSet(key, value);
      await refreshVault();
    },
    [refreshVault],
  );

  const vaultDelete = useCallback(
    async (key: string) => {
      await coreBridge.vaultDelete(key);
      await refreshVault();
    },
    [refreshVault],
  );

  const value = useMemo<AppState>(
    () => ({
      capabilities,
      connection,
      activities,
      toasts,
      vault,
      vaultGate,
      gateKnown,
      refreshCapabilities,
      refreshVault,
      refreshHealth,
      unlockVault,
      lockVault,
      setNetworkPaused,
      execute,
      vaultSet,
      vaultDelete,
      dismissToast,
    }),
    [
      capabilities,
      connection,
      activities,
      toasts,
      vault,
      vaultGate,
      gateKnown,
      refreshCapabilities,
      refreshVault,
      refreshHealth,
      unlockVault,
      lockVault,
      setNetworkPaused,
      execute,
      vaultSet,
      vaultDelete,
      dismissToast,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useApp must be used within AppProvider");
  }
  return ctx;
}
