import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  NetworkPeer,
  NetworkProvider,
  TaskHandler,
  TaskRequest,
  TaskResult,
} from "@p2p-hub/sdk";

const execFileAsync = promisify(execFile);

/**
 * Status of the local `agentanycastd` daemon.
 */
export type AgentAnycastStatus = "not-installed" | "installed-not-running" | "ready";

const BINARY_NAME = "agentanycastd";

const DEFAULT_ADDRESS = process.env.AGENTANYCAST_ADDRESS ?? "localhost:50051";

/**
 * Provider backed by the `agentanycastd` daemon.
 *
 * In stage 1 this provider only detects whether the daemon is installed and
 * reachable; task transport over gRPC is intentionally not implemented yet.
 */
export class AgentAnycastProvider implements NetworkProvider {
  readonly id = "network-agentanycast";
  readonly priority = 100;
  /**
   * Stage 1 only probes the daemon; it cannot exchange tasks yet. Marking this
   * false keeps the registry from ever selecting this provider as the active
   * transport (which would throw on every `discover`/`sendTask`/`onTask`).
   */
  readonly canTransportTasks = false;

  private status: AgentAnycastStatus = "not-installed";
  private started = false;

  constructor(private readonly address: string = DEFAULT_ADDRESS) {}

  async start(): Promise<void> {
    this.status = await this.checkStatus();
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  isReady(): boolean {
    return this.started && this.status === "ready";
  }

  /**
   * Detect the daemon state. The first check that succeeds wins:
   * 1. Unix domain socket (SDK automanage default, skipped on win32);
   * 2. TCP address from a manually configured `grpc_listen`;
   * 3. binary on PATH -> "installed-not-running";
   * 4. otherwise -> "not-installed".
   */
  async checkStatus(): Promise<AgentAnycastStatus> {
    if (process.platform !== "win32" && (await this.isReachableViaSocket())) {
      // Matched via unix domain socket (SDK automanage).
      return "ready";
    }
    if (await this.isReachable()) {
      // Matched via TCP address (manual `grpc_listen` config).
      return "ready";
    }
    if (await this.isOnPath()) {
      return "installed-not-running";
    }
    return "not-installed";
  }

  private async isReachableViaSocket(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = net.connect({ path: this.socketPath, timeout: 1500 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  private get socketPath(): string {
    return (
      process.env.AGENTANYCAST_SOCKET ??
      path.join(os.homedir(), ".agentanycast", "daemon.sock")
    );
  }

  private async isReachable(): Promise<boolean> {
    const { host, port } = this.parseAddress(this.address);
    return new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port, timeout: 1500 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  private async isOnPath(): Promise<boolean> {
    const lookup = process.platform === "win32" ? "where" : "which";
    try {
      await execFileAsync(lookup, [BINARY_NAME]);
      return true;
    } catch {
      return false;
    }
  }

  private parseAddress(address: string): { host: string; port: number } {
    const idx = address.lastIndexOf(":");
    if (idx === -1) {
      return { host: address, port: 50051 };
    }
    const host = address.slice(0, idx);
    const port = Number(address.slice(idx + 1));
    return {
      host: host || "localhost",
      port: Number.isFinite(port) ? port : 50051,
    };
  }

  async discover(_skill: string): Promise<NetworkPeer[]> {
    throw new Error("discover is not implemented in stage 1");
  }

  async sendTask(_peer: NetworkPeer, _task: TaskRequest): Promise<TaskResult> {
    throw new Error("sendTask is not implemented in stage 1");
  }

  onTask(_handler: TaskHandler): void {
    throw new Error("onTask is not implemented in stage 1");
  }
}
