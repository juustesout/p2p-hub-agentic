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

import type { ClientGpuProbe as SdkClientGpuProbe } from "@p2p-hub/sdk";
export type ClientGpuProbe = SdkClientGpuProbe;

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

/** Which main view of the HelpCenter a nav request targets. */
export type HelpTabId = "diagnose" | "logs" | "docs" | "chat" | "agent";

/**
 * A targeted HelpCenter view request (Pijler C / Brief 7C): open a specific
 * tab and, for Logs, preselect one diagnostics source. Used by the "toon
 * details" toast action and every entry-point that wants a context-aware open.
 */
export interface HelpNavRequest {
  tab: HelpTabId;
  /** Optional diagnostics source id to preselect in the Logs tab. */
  sourceId?: string;
}

export interface Toast {
  id: string;
  title: string;
  body: string;
  kind: "info" | "success" | "error";
  ts: number;
  /**
   * When set, the toast renders a "Toon details" action that opens the
   * HelpCenter on the requested view (error toasts route to the Logs tab).
   */
  details?: HelpNavRequest | null;
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

// ---------------------------------------------------------------------------
// HelpCenter diagnostics (7C) — DTOs mirroring the core-server diagnostics API
// ---------------------------------------------------------------------------

/** A pino log level; `silent` appears only on a disabled source. */
export type DiagnosticsLevelName =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal"
  | "silent";

export interface DiagnosticsSourceInfo {
  id: string;
  name: string;
  /** memory = ring buffer; webview = forwarded shell/plugin logs; file = on-disk. */
  kind: "memory" | "webview" | "file";
  level: string;
  enabled: boolean;
  /** Security-relevant: cannot be disabled by the level/source toggle. */
  secure: boolean;
  capacity: number;
  length: number;
}

export interface DiagnosticsRecordView {
  time: number;
  level: string;
  module: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export interface DiagnosticsLogsResponse {
  ok: boolean;
  sources: DiagnosticsSourceInfo[];
  records: Record<string, DiagnosticsRecordView[]>;
}

/** Body of the shell-initiated logs query (redaction is server-side default). */
export interface DiagnosticsLogsQuery {
  source?: string;
  limit?: number;
  level?: string;
  /** Explicit power-user opt-in — raw output, server-side `unredacted=1`. */
  unredacted?: boolean;
}

export interface SnapshotSystemInfo {
  platform: string;
  release: string;
  arch: string;
  uptime: number;
  totalmem: number;
  freemem: number;
  cpus: Array<{ model: string; speed: number }>;
  loadavg: number[];
}

export interface SnapshotRuntimeInfo {
  nodeVersion: string;
  pid: number;
  coreVersion: string;
  tauriVersion: string | null;
  webviewVersion: string | null;
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
}

export interface SnapshotGpuInfo {
  vendor: string | null;
  renderer: string | null;
  source: "lspci" | "shell" | null;
}

export interface SnapshotHardwareInfo {
  gpu: SnapshotGpuInfo | null;
  webglRenderer: string | null;
  hardwareAcceleration: boolean | null;
  windowScaleFactor: number | null;
}

export interface SnapshotNetworkInfo {
  providerId: string | null;
  providerReady: boolean;
  peerCount: number;
  boundPort: number;
  wanEnabled: boolean;
  wanReady: boolean;
  transportMode: "lan" | "wan" | "none";
}

export interface SnapshotPluginInfo {
  id: string;
  name: string;
  version: string;
  kind: string;
  signature: "signed" | "unsigned";
  certification: "certified" | "uncertified";
  state: string;
}

export interface DiagnosticSnapshot {
  takenAt: number;
  system: SnapshotSystemInfo;
  runtime: SnapshotRuntimeInfo;
  hardware: SnapshotHardwareInfo;
  network: SnapshotNetworkInfo;
  vault: {
    locked: boolean;
    vaultExists: boolean;
    networkPaused: boolean;
    masterKeyConfigured: boolean;
  };
  boot: {
    bootState: "locked" | "ready";
    networkingEnabled: boolean;
    bootFlags: string[];
  };
  plugins: SnapshotPluginInfo[];
}

export interface SnapshotResponse {
  ok: boolean;
  snapshot: DiagnosticSnapshot;
  summary: string;
}

/** Snapshot sections selectable in the Diagnose bundle form. */
export const DIAGNOSTICS_BUNDLE_SECTIONS = [
  "system",
  "runtime",
  "hardware",
  "network",
  "vault",
  "boot",
  "plugins",
] as const;

export type DiagnosticsBundleSection = (typeof DIAGNOSTICS_BUNDLE_SECTIONS)[number];

export interface BundleRequest {
  sections: DiagnosticsBundleSection[];
  sources: string[];
  userNote?: string;
  /** Optional webview GPU probe merged into the bundle's hardware section. */
  clientGpu?: ClientGpuProbe;
}

export interface DiagnosticBundle {
  kind: "p2p-hub-diagnostic-bundle";
  version: number;
  createdAt: number;
  snapshot: Record<string, unknown>;
  logs: Array<{
    sourceId: string;
    level: string;
    limit: number;
    recordCount: number;
    records: DiagnosticsRecordView[];
  }>;
  userNote: string;
  preview: {
    sections: string[];
    logSources: Array<{ sourceId: string; recordCount: number }>;
    hasNote: boolean;
    redacted: true;
  };
  redacted: true;
}

export interface BundleResponse {
  ok: boolean;
  bundle: DiagnosticBundle;
  clipboardText: string;
  preview: DiagnosticBundle["preview"];
}

// ---------------------------------------------------------------------------
// HelpCenter chat + help-agent (7D) — DTOs mirroring the core-server /api/help
// surface and the chat plugin's httpBridgeOnly skills
// ---------------------------------------------------------------------------

/** The baked-in support contact (server-resolved; configured = has a peerId). */
export interface HelpSupportInfo {
  peerId: string | null;
  displayName: string;
  configured: boolean;
}

export interface HelpAgentStatus {
  ok: boolean;
  available: boolean;
}

export interface HelpSourceRef {
  docId: string;
  title: string;
}

/** A read-only proposal: the answer plus steps the operator takes themselves. */
export interface HelpAgentProposal {
  question: string;
  answer: string;
  steps: string[];
  sources: HelpSourceRef[];
}

export type HelpAgentAskResult =
  | { ok: true; proposal: HelpAgentProposal }
  | {
      ok: false;
      code?: string;
      detail?: string;
    };

/** One stored chat message as exposed by the chat plugin's getThread. */
export interface ChatMessageRecordView {
  fromPeerId: string;
  toPeerId: string;
  text: string;
  sentAt: string;
  verified: boolean;
}

export interface ChatThreadSummaryView {
  peerId: string;
  lastMessageAt: string;
  messageCount: number;
}

/** A one-shot "open this article" focus handed to the Documentation tab. */
export interface DocsFocus {
  docId: string;
  /** Bumped per request so the tab re-selects even for the same docId. */
  token: number;
}
