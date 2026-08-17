import * as tls from "node:tls";
import * as crypto from "node:crypto";
import Bonjour from "bonjour-service";
import type { Browser, Service } from "bonjour-service";
import * as forge from "node-forge";
import type {
  NetworkPeer,
  NetworkProvider,
  TaskHandler,
  TaskRequest,
  TaskResult,
} from "@p2p-hub/sdk";

const SERVICE_TYPE = "p2p-hub";
const FRAME_MAX = 16 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 10_000;

export interface NetworkLightOptions {
  /** Port to listen on. Defaults to 0 (ephemeral). */
  port?: number;
  /** Bind host. Defaults to 0.0.0.0. */
  host?: string;
  /** Advertised service name. Defaults to a random name. */
  name?: string;
  /** Skills this instance can serve. */
  skills?: string[];
}

interface WireMessage {
  type: "task" | "result";
  task?: TaskRequest;
  result?: TaskResult;
}

interface DiscoveredPeer extends NetworkPeer {
  name?: string;
  /** SHA-256 fingerprint of the peer's self-signed cert, announced via mDNS. */
  certFingerprint?: string;
}

function encodeFrame(payload: string | Buffer): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function generateSelfSignedCert(): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(16));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  const attrs: forge.pki.CertificateField[] = [
    { name: "commonName", value: "p2p-hub" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

/**
 * Lightweight LAN transport: mDNS discovery + encrypted (TLS) TCP for tasks.
 *
 * Uses npm-only, pure-JS libraries. Each instance generates a self-signed
 * certificate at startup and encrypts every task connection with it; this is
 * end-to-end encrypted but not production-grade PKI.
 */
export class NetworkLightProvider implements NetworkProvider {
  readonly id = "network-light";
  readonly priority = 10;

  private readonly host: string;
  private readonly port: number;
  private readonly name: string;
  private readonly skills: string[];
  private readonly instanceId: string;

  private server: tls.Server | null = null;
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;
  private boundPort = 0;
  private ready = false;
  private certFingerprint = "";
  private taskHandler: TaskHandler | null = null;
  private readonly discovered = new Map<string, DiscoveredPeer>();

  constructor(options: NetworkLightOptions = {}) {
    this.host = options.host ?? "0.0.0.0";
    this.port = options.port ?? 0;
    this.name =
      options.name ?? `p2p-hub-${crypto.randomBytes(4).toString("hex")}`;
    this.skills = [...(options.skills ?? [])];
    this.instanceId = crypto.randomUUID();
  }

  isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    if (this.ready) {
      return;
    }

    const { key, cert } = generateSelfSignedCert();
    const certInfo = new crypto.X509Certificate(cert);
    this.certFingerprint = certInfo.fingerprint256;

    this.server = tls.createServer({ key, cert }, (socket) => {
      this.handleConnection(socket);
    });

    this.boundPort = await new Promise<number>((resolve, reject) => {
      const server = this.server!;
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        const address = server.address();
        resolve(
          typeof address === "object" && address !== null
            ? address.port
            : this.port,
        );
      });
    });

    this.bonjour = new Bonjour();
    this.bonjour.publish({
      name: this.name,
      type: SERVICE_TYPE,
      port: this.boundPort,
      txt: {
        id: this.instanceId,
        skills: JSON.stringify(this.skills),
        certFingerprint: this.certFingerprint,
      },
    });

    this.browser = this.bonjour.find({ type: SERVICE_TYPE }, (service) => {
      this.onServiceUp(service);
    });
    this.browser.on("down", (service) => {
      this.onServiceDown(service);
    });

    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;

    try {
      this.browser?.stop();
    } catch {
      // ignore
    }
    this.browser = null;

    try {
      this.bonjour?.unpublishAll();
    } catch {
      // ignore
    }
    try {
      this.bonjour?.destroy();
    } catch {
      // ignore
    }
    this.bonjour = null;

    await new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });

    this.discovered.clear();
    this.taskHandler = null;
  }

  async discover(skill: string): Promise<NetworkPeer[]> {
    const peers: NetworkPeer[] = [];
    for (const peer of this.discovered.values()) {
      if (peer.skills.includes(skill)) {
        peers.push({
          id: peer.id,
          address: peer.address,
          skills: peer.skills,
          name: peer.name,
        });
      }
    }
    return peers;
  }

  /**
   * Return every currently discovered peer regardless of the skills it
   * advertises. Useful for capability/inspector UIs that need the full peer
   * set, not just the peers that serve one specific skill.
   */
  listPeers(): NetworkPeer[] {
    const peers: NetworkPeer[] = [];
    for (const peer of this.discovered.values()) {
      peers.push({
        id: peer.id,
        address: peer.address,
        skills: peer.skills,
        name: peer.name,
      });
    }
    return peers;
  }

  onTask(handler: TaskHandler): void {
    this.taskHandler = handler;
  }

  async sendTask(peer: NetworkPeer, task: TaskRequest): Promise<TaskResult> {
    const { host, port } = parseAddress(peer.address);
    const expectedFingerprint = this.discovered.get(peer.id)?.certFingerprint;

    return new Promise<TaskResult>((resolve) => {
      const finish = (result: TaskResult) => {
        clearTimeout(timer);
        resolve(result);
      };

      const socket = tls.connect(
        { host, port, rejectUnauthorized: false },
        () => {
          if (!expectedFingerprint) {
            socket.destroy();
            finish({
              taskId: task.id,
              status: "error",
              error: "no certificate fingerprint on record for peer",
            });
            return;
          }
          const presented = socket.getPeerCertificate().fingerprint256 ?? "";
          if (!fingerprintsMatch(expectedFingerprint, presented)) {
            socket.destroy();
            finish({
              taskId: task.id,
              status: "error",
              error: "certificate fingerprint mismatch",
            });
            return;
          }
          socket.write(encodeFrame(JSON.stringify({ type: "task", task })));
        },
      );

      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        finish({
          taskId: task.id,
          status: "error",
          error: "timed out waiting for response",
        });
      }, RESPONSE_TIMEOUT_MS);

      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const message = tryDecodeFrame(buffer);
        if (message === null) {
          return;
        }
        buffer = message.rest;
        if (message.value.type === "result" && message.value.result) {
          socket.destroy();
          finish(message.value.result);
        }
      });

      socket.once("error", (err) => {
        finish({ taskId: task.id, status: "error", error: err.message });
      });
    });
  }

  private handleConnection(socket: tls.TLSSocket): void {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let message = tryDecodeFrame(buffer);
      while (message !== null) {
        buffer = message.rest;
        void this.handleMessage(socket, message.value);
        message = tryDecodeFrame(buffer);
      }
    });
    socket.on("error", () => {
      socket.destroy();
    });
  }

  private async handleMessage(
    socket: tls.TLSSocket,
    message: WireMessage,
  ): Promise<void> {
    if (message.type !== "task" || !message.task) {
      return;
    }
    const result = await this.dispatchTask(message.task);
    socket.write(encodeFrame(JSON.stringify({ type: "result", result })));
  }

  private async dispatchTask(task: TaskRequest): Promise<TaskResult> {
    if (!this.taskHandler) {
      return {
        taskId: task.id,
        status: "error",
        error: "no task handler registered",
      };
    }
    try {
      return await this.taskHandler(task);
    } catch (err) {
      return {
        taskId: task.id,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private onServiceUp(service: Service): void {
    const id = service.txt?.id as string | undefined;
    if (!id || id === this.instanceId) {
      return;
    }
    const address = this.serviceAddress(service);
    if (!address) {
      return;
    }
    let skills: string[] = [];
    try {
      skills = JSON.parse(service.txt?.skills ?? "[]") as string[];
    } catch {
      skills = [];
    }
    const certFingerprint = service.txt?.certFingerprint as string | undefined;
    this.discovered.set(id, {
      id,
      address,
      skills,
      name: service.name,
      certFingerprint,
    });
  }

  private onServiceDown(service: Service): void {
    const id = service.txt?.id as string | undefined;
    if (id) {
      this.discovered.delete(id);
    }
  }

  private serviceAddress(service: Service): string | null {
    const port = service.port;
    const addresses = service.addresses ?? [];
    const ip =
      addresses.find((address) => address.includes(".")) ??
      addresses[0] ??
      service.host;
    if (!ip || !port) {
      return null;
    }
    return `${ip}:${port}`;
  }
}

interface DecodedFrame {
  value: WireMessage;
  rest: Buffer<ArrayBufferLike>;
}

function tryDecodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 4) {
    return null;
  }
  const length = buffer.readUInt32BE(0);
  if (length > FRAME_MAX) {
    throw new Error("frame exceeds maximum allowed size");
  }
  if (buffer.length < 4 + length) {
    return null;
  }
  const body = buffer.subarray(4, 4 + length);
  const rest = buffer.subarray(4 + length);
  try {
    const value = JSON.parse(body.toString("utf8")) as WireMessage;
    return { value, rest };
  } catch {
    return { value: { type: "result" }, rest };
  }
}

function parseAddress(address: string): { host: string; port: number } {
  const idx = address.lastIndexOf(":");
  if (idx === -1) {
    throw new Error(`invalid peer address: ${address}`);
  }
  const host = address.slice(0, idx);
  const port = Number(address.slice(idx + 1));
  if (!host || !Number.isInteger(port)) {
    throw new Error(`invalid peer address: ${address}`);
  }
  return { host, port };
}

function normalizeFingerprint(fingerprint: string | undefined | null): string {
  return (fingerprint ?? "").replace(/:/g, "").toLowerCase();
}

function fingerprintsMatch(expected: string, presented: string): boolean {
  const normalizedExpected = normalizeFingerprint(expected);
  const normalizedPresented = normalizeFingerprint(presented);
  return normalizedExpected.length > 0 && normalizedExpected === normalizedPresented;
}
