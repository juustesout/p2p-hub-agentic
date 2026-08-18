export type ConnectionState =
  | "connected"
  | "degraded"
  | "reconnecting"
  | "offline";

export interface CapabilityPlugin {
  id: string;
  name: string;
  kind: string;
  version: string;
}

export interface CapabilitySkill {
  skill: string;
  localOnly: boolean;
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
