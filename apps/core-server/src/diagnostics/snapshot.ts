/**
 * Diagnostic snapshot collector (HelpCenter Pijler B.1 / Brief 7B).
 *
 * One click → always the same shape: OS + hardware + runtime + the core OS
 * state (provider, vault, plugins, boot) in a single structured payload that
 * is useful for triage without ever holding a secret.
 *
 * Redaction is applied by the bundler/route on the whole payload (shared SDK
 * filter) — this module only *collects* data, and it deliberately never reads
 * a secret value: vault state is `locked`/`masterKeyConfigured` (existence),
 * plugins are id/name/version/kind + signature/certification status, peers are
 * a count. No peerIds, no keys, no tokens are ever put in here.
 *
 * Hardware/GPU is best-effort and fail-closed (HelpCenter Pijler B.1): the
 * core-server is a Node process with no WebGL/Canvas, so GPU fields default to
 * null and the desktop shell (Tauri webview) can fill the WebGL/scale-factor
 * hooks in a later slice. The OS-level GPU probe (`lspci` on Linux) is read-only
 * and wrapped so any probe failure yields null, never a crash.
 */

import { execFile } from "node:child_process";
import * as os from "node:os";

/**
 * Everything the snapshot needs from the live server. Kept as a narrow,
 * read-only interface so the collector itself never touches the vault, the
 * network transports or the plugin host — the CoreServer wires this closure.
 */
export interface SnapshotStateSource {
  bootState: "locked" | "ready";
  networkingEnabled: boolean;
  wanEnabled: boolean;
  vault: {
    locked: boolean;
    vaultExists: boolean;
    networkPaused: boolean;
    /** True when a real master key is configured (never the key itself). */
    masterKeyConfigured: boolean;
  };
  provider: {
    id: string;
    ready: boolean;
    peerCount: number;
    port: number;
  } | null;
  wan: { id: string; ready: boolean } | null;
  plugins: Array<{
    id: string;
    name?: string;
    version: string;
    kind: string;
    signature?: "signed" | "unsigned";
    certification?: "certified" | "uncertified";
    state?: string;
  }>;
}

export interface SnapshotSystemInfo {
  platform: NodeJS.Platform;
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
  /** `__P2P_HUB_CORE_VERSION__`, stamped by the SEA build. */
  coreVersion: string;
  /** Best-effort Tauri/Webview version flags (null outside the shell). */
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
  /** Vendor string when the OS probe could identify it (e.g. "NVIDIA"). */
  vendor: string | null;
  /** Renderer/device string (e.g. "NVIDIA GeForce RTX 3080"). */
  renderer: string | null;
  source: "lspci" | "shell" | null;
}

export interface SnapshotHardwareInfo {
  /** Best-effort OS-level GPU info; null when no probe was available. */
  gpu: SnapshotGpuInfo | null;
  /**
   * WebGL/Canvas renderer + scale factor + hardware-acceleration hooks. The
   * core server has no browser context, so these stay null; the desktop shell
   * (Tauri webview) fills them in a later HelpCenter slice.
   */
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
  vault: SnapshotStateSource["vault"];
  boot: {
    bootState: "locked" | "ready";
    networkingEnabled: boolean;
    bootFlags: string[];
  };
  plugins: SnapshotPluginInfo[];
}

/** Resolved at module load (a dev tsc build has no esbuild define). */
declare const __P2P_HUB_CORE_VERSION__: string | undefined;
function coreVersion(): string {
  return typeof __P2P_HUB_CORE_VERSION__ !== "undefined"
    ? __P2P_HUB_CORE_VERSION__
    : "0.0.0-dev";
}

function collectSystem(): SnapshotSystemInfo {
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptime: os.uptime(),
    totalmem: os.totalmem(),
    freemem: os.freemem(),
    cpus: os.cpus().map((c) => ({ model: c.model, speed: c.speed })),
    loadavg: os.loadavg(),
  };
}

function collectRuntime(): SnapshotRuntimeInfo {
  const mem = process.memoryUsage();
  return {
    nodeVersion: process.version,
    pid: process.pid,
    coreVersion: coreVersion(),
    tauriVersion: null,
    webviewVersion: null,
    memoryUsage: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
    },
  };
}

/** Probe the GPU on Linux via `lspci` (read-only, fail-closed → null). */
function probeGpu(): Promise<SnapshotGpuInfo | null> {
  if (process.platform !== "linux") {
    return Promise.resolve(null);
  }
  return new Promise<SnapshotGpuInfo | null>((resolve) => {
    execFile(
      "lspci",
      ["-nn"],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        for (const line of stdout.split("\n")) {
          const lower = line.toLowerCase();
          if (
            lower.includes("vga") ||
            lower.includes("3d controller") ||
            lower.includes("display controller")
          ) {
            const rest = line.split(":")[1] ?? line;
            const vendorMatch = rest.match(/\[([0-9a-f]{4}:[0-9a-f]{4})\]/);
            resolve({
              vendor: vendorMatch ? vendorMatch[1] : null,
              renderer: rest.trim(),
              source: "lspci",
            });
            return;
          }
        }
        resolve(null);
      },
    );
  });
}

function collectHardware(): SnapshotHardwareInfo {
  return {
    gpu: null,
    webglRenderer: null,
    hardwareAcceleration: null,
    windowScaleFactor: null,
  };
}

/**
 * Collect a fresh, redaction-safe diagnostic snapshot. The OS probe (`lspci`)
 * is async and fail-closed; the rest is synchronous. `bootFlags` comes from
 * the engine (e.g. `["safe-mode"]`).
 */
export async function collectSnapshot(
  state: SnapshotStateSource,
  bootFlags: string[] = [],
): Promise<DiagnosticSnapshot> {
  const [gpu] = await Promise.all([probeGpu()]);
  const hardware = collectHardware();
  hardware.gpu = gpu;

  const network: SnapshotNetworkInfo = state.provider
    ? {
        providerId: state.provider.id,
        providerReady: state.provider.ready,
        peerCount: state.provider.peerCount,
        boundPort: state.provider.port,
        wanEnabled: state.wanEnabled,
        wanReady: state.wan?.ready ?? false,
        transportMode: state.wanEnabled
          ? state.wan?.ready
            ? "wan"
            : "lan"
          : state.provider.ready
            ? "lan"
            : "none",
      }
    : {
        providerId: null,
        providerReady: false,
        peerCount: 0,
        boundPort: 0,
        wanEnabled: state.wanEnabled,
        wanReady: false,
        transportMode: "none",
      };

  return {
    takenAt: Date.now(),
    system: collectSystem(),
    runtime: collectRuntime(),
    hardware,
    network,
    vault: state.vault,
    boot: {
      bootState: state.bootState,
      networkingEnabled: state.networkingEnabled,
      bootFlags,
    },
    plugins: state.plugins.map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      version: p.version,
      kind: p.kind,
      signature: p.signature ?? "unsigned",
      certification: p.certification ?? "uncertified",
      state: p.state ?? "ACTIVE",
    })),
  };
}

/**
 * The snapshot's section list (used by the bundler preview to show exactly
 * which fields are included). Every key maps to a top-level snapshot field.
 */
export const SNAPSHOT_SECTIONS = [
  "system",
  "runtime",
  "hardware",
  "network",
  "vault",
  "boot",
  "plugins",
] as const;

/** Human-readable, redacted single-line summary of the snapshot. */
export function snapshotSummary(snapshot: DiagnosticSnapshot): string {
  const net =
    snapshot.network.transportMode === "none"
      ? "geen netwerk"
      : `${snapshot.network.transportMode} (${snapshot.network.peerCount} peers)`;
  const provider = snapshot.network.providerId
    ? ` via ${snapshot.network.providerId}`
    : "";
  return [
    `${snapshot.system.platform} ${snapshot.system.release} ${snapshot.system.arch}`,
    `node ${snapshot.runtime.nodeVersion} core ${snapshot.runtime.coreVersion}`,
    `netwerk: ${net}${provider}`,
    `vault: ${snapshot.vault.locked ? "locked" : "unlocked"}` +
      (snapshot.vault.masterKeyConfigured ? "" : " (dev-key)"),
    `plugins: ${snapshot.plugins.length}`,
    snapshot.hardware.gpu?.renderer ? `gpu: ${snapshot.hardware.gpu.renderer}` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(" | ");
}
