import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  ActivityEvent,
  Capabilities,
  ConnectionState,
  ExecuteRequest,
  TaskResult,
  Toast,
  VaultKeyMeta,
  VaultModelInfo,
} from "../types";
import { coreBridge } from "../services/core-bridge";
import { activityBus } from "../services/activity-bus";
import { pluginBridge } from "../services/plugin-bridge";

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
  refreshCapabilities: () => Promise<void>;
  refreshVault: () => Promise<void>;
  execute: (req: ExecuteRequest) => Promise<TaskResult>;
  vaultSet: (key: string, value: string) => Promise<void>;
  vaultDelete: (key: string) => Promise<void>;
  dismissToast: (id: string) => void;
}

const emptyVault: VaultState = {
  keys: [],
  model: { model: null, baseUrl: null, hasApiKey: false },
  masterKeyConfigured: false,
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

  const pushToast = useCallback(
    (title: string, body: string, kind: Toast["kind"] = "info") => {
      const toast: Toast = { id: makeId(), title, body, kind, ts: Date.now() };
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
    } catch {
      // Server not reachable yet; keep last-known state.
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
    } catch {
      // Ignore transient failures.
    }
  }, []);

  useEffect(() => {
    pluginBridge.attach();
    coreBridge.connect();

    const offState = coreBridge.onStateChange(setConnection);
    const offEvents = activityBus.subscribeAll((event) => {
      setActivities(activityBus.recent());
      routeEvent(event);
    });

    function routeEvent(event: ActivityEvent) {
      switch (event.event) {
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
            pushToast("Task failed", "A task completed with an error", "error");
          }
          break;
        }
        default:
          break;
      }
    }

    void refreshCapabilities();
    void refreshVault();

    // Re-poll capabilities on a timer to pick up peer churn and any plugins
    // that appear without emitting events.
    const interval = window.setInterval(() => {
      void refreshCapabilities();
    }, 10_000);

    return () => {
      window.clearInterval(interval);
      offState();
      offEvents();
      coreBridge.disconnect();
    };
  }, [pushToast, refreshCapabilities, refreshVault]);

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
      refreshCapabilities,
      refreshVault,
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
      refreshCapabilities,
      refreshVault,
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
