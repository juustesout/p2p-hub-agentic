export type ConnectionState =
  | "connected"
  | "degraded"
  | "reconnecting"
  | "offline";

export type {
  EffectiveSettings,
  RiskAssessment,
  RiskFinding,
  RiskSeverity,
} from "@p2p-hub/sdk";

export interface CapabilityPluginUi {
  entry: string;
  defaultWidth?: number;
  defaultHeight?: number;
  /**
   * Manifest-declared bridge allowlist: the only skills this plugin's UI may
   * invoke through the postMessage bridge. Never derived from the full skill
   * list — a plugin declares exactly what its UI is allowed to call.
   */
  skills: string[];
}

export interface CapabilityPlugin {
  id: string;
  name: string;
  kind: string;
  version: string;
  ui: CapabilityPluginUi | null;
}

export interface CapabilitySkill {
  skill: string;
  localOnly: boolean;
  httpExposed: boolean;
  httpBridgeOnly: boolean;
  pluginId: string;
}

export interface RemotePeer {
  id: string;
  /** Persistent peer identity (Ed25519 hex) when the peer advertises one. */
  peerId?: string | null;
  name: string;
  address: string;
  skills: string[];
  transport: string;
  trust: string;
}

export interface LocalCapabilities {
  plugins: CapabilityPlugin[];
  skills: CapabilitySkill[];
  events: string[];
  connection: {
    providerId: string | null;
    ready: boolean;
  };
}

export interface Capabilities {
  local: LocalCapabilities;
  remote: { peers: RemotePeer[] };
}

export interface ExecuteRequest {
  peerId?: string;
  serviceId: string;
  method: string;
  requestId?: string;
  arguments?: unknown;
}

export interface TaskResult {
  taskId: string;
  status: "ok" | "error";
  result?: unknown;
  error?: string;
}

export interface ActivityEvent {
  event: string;
  payload: unknown;
  ts: number;
}

export interface VaultKeyMeta {
  key: string;
  updatedAt: string | null;
}

export interface VaultModelInfo {
  hasModel: boolean;
  hasBaseUrl: boolean;
  hasApiKey: boolean;
}

export interface Toast {
  id: string;
  title: string;
  body: string;
  kind: "info" | "success" | "error";
  ts: number;
}

/**
 * Vault lock-gate + network state as reported by `/api/health`. `locked` gates
 * the whole desktop UI (Slice 2): while true, nothing P2P or storage-backed is
 * reachable and the shell renders the unlock screen.
 */
export interface VaultGateState {
  locked: boolean;
  vaultExists: boolean;
  networkPaused: boolean;
}

/**
 * A fully sanitized OS-notification spec. The shell constructs these from
 * bridged events via {@link sanitizeNotification} — it never contains message
 * text, secret values or raw payload fields (lock-screen privacy).
 */
export interface NotificationSpec {
  title: string;
  body: string;
}
