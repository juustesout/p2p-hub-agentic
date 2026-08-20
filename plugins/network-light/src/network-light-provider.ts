import * as tls from "node:tls";
import * as crypto from "node:crypto";
import Bonjour from "bonjour-service";
import type { Browser, Service } from "bonjour-service";
import * as forge from "node-forge";
import type {
  NetworkPeer,
  NetworkProvider,
  PeerIdentity,
  TaskHandler,
  TaskRequest,
  TaskResult,
} from "@p2p-hub/sdk";
import { validateJsonNestingDepth, validateObjectDepth, validatePayloadSize } from "@p2p-hub/sdk";
import {
  HANDSHAKE_TIMEOUT_MS,
  MAX_CAPABILITIES,
  MAX_PAYLOAD_BYTES,
  NETWORK_PROTOCOL_VERSION,
  buildIdentityBindingMessage,
  encodeAuth,
  encodeHello,
  encodeHelloAck,
  encodeResult,
  encodeTask,
  mDNS_PROTOCOL_VERSION,
  negotiateVersion,
  normalizeFingerprint,
  parseEnvelope,
  randomNonce,
  verifyIdentityBinding,
  type HelloAckBody,
  type HelloBody,
  type IdentityBinding,
  type TaskBody,
} from "./wire-contract";
import {
  DEFAULT_PEER_LIMITS,
  PeerLimiter,
  type PeerLimitConfig,
} from "./peer-limiter";

const SERVICE_TYPE = "p2p-hub";
const RESPONSE_TIMEOUT_MS = 10_000;
/** Peers silent this long are treated as gone even without an mDNS "down". */
const HEARTBEAT_TTL_MS = 30_000;
const SWEEP_INTERVAL_MS = 15_000;
/** After a failed capability probe, do not retry that peer for this long. */
const PROBE_RETRY_MS = 10_000;

export interface NetworkLightOptions {
  /** Port to listen on. Defaults to 0 (ephemeral). */
  port?: number;
  /** Bind host. Defaults to 0.0.0.0. */
  host?: string;
  /** Advertised service name. Defaults to a random name. */
  name?: string;
  /** Skills this instance can serve. */
  skills?: string[];
  /**
   * Optional persistent identity. When present, its `peerId` is advertised in
   * the mDNS TXT record alongside (not instead of) the session
   * `certFingerprint`. The claim is proven over the wire: see
   * {@link NetworkLightOptions.identitySigner}.
   */
  identity?: PeerIdentity;
  /**
   * Capability that signs bytes with the Ed25519 private key behind
   * {@link NetworkLightOptions.identity}. Required to take part in the Fase 1B
   * identity binding (client `auth` and server `hello_ack.identity`). The
   * private key stays with the caller (typically core's `IdentityManager`) —
   * the provider only ever receives signed bytes. Omit to run anonymous.
   */
  identitySigner?: (data: Buffer) => Promise<Buffer>;
  /**
   * Per-peer abuse limits (Fase 1C). When provided, keys are merged over
   * {@link DEFAULT_PEER_LIMITS}. A peer that exceeds any limit is refused,
   * never queued.
   */
  peerLimits?: Partial<PeerLimitConfig>;
  /**
   * Maximum serialized envelope length this instance accepts on a single
   * incoming message. Advertised in the handshake as `limits.maxPayloadBytes`
   * so a compliant peer refuses to send anything larger. Defaults to
   * {@link MAX_PAYLOAD_BYTES}.
   */
  maxPayloadBytes?: number;
  /** Time in ms a peer may stay silent before it is pruned. Defaults to 30s. */
  heartbeatTtlMs?: number;
  /** How often to sweep stale peers. Defaults to half the TTL. */
  sweepIntervalMs?: number;
  /** Invoked whenever a peer is removed because it went silent. */
  onPeerDisconnected?: (peer: DiscoveredPeer) => void;
}

export interface DiscoveredPeer extends NetworkPeer {
  name?: string;
  /** SHA-256 fingerprint of the peer's self-signed cert, announced via mDNS. */
  certFingerprint?: string;
  /**
   * Persistent peer identity. Filled from the mDNS TXT claim at discovery
   * time, but only trusted once the Fase 1B handshake verified it — see
   * {@link DiscoveredPeer.peerIdVerified}.
   */
  peerId?: string;
  /**
   * True when `peerId` was cryptographically verified over the handshake
   * (identity binding: Ed25519 signature bound to the presented certificate).
   * False/absent for a peer that never authenticated or that only claims an id
   * over unauthenticated mDNS.
   */
  peerIdVerified?: boolean;
  /** Protocol version announced via mDNS (informational; the wire handshake gates). */
  protocolVersion?: string;
  /** Last time this peer was heard from (epoch ms). Internal only. */
  lastSeen?: number;
}

/** Capabilities and limits learned from a peer via the handshake. */
interface PeerCapabilities {
  skills: string[];
  limits: { maxPayloadBytes?: number } | null;
  /** Peer identity verified over the Fase 1B handshake (if it has one). */
  peerId?: string;
  fetchedAt: number;
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
 * Fase 1A: every connection starts with a protocol handshake (`hello` →
 * `hello_ack`) negotiated over the fingerprint-verified TLS session. The
 * handshake exchanges the wire protocol version, offered capabilities and
 * limits; an unknown protocol/version, a `task` before `hello`, or a malformed
 * message closes the connection (default-deny). Capabilities learned in the
 * handshake feed {@link discover} so peer discovery filters by what a peer
 * actually offers — without ever announcing capability names over mDNS (Fase
 * 0C).
 */
export class NetworkLightProvider implements NetworkProvider {
  readonly id = "network-light";
  readonly priority = 10;

  private readonly host: string;
  private readonly configuredPort: number;
  private readonly name: string;
  private readonly skills: string[];
  private readonly maxPayloadBytes: number;
  private readonly instanceId: string;
  private readonly identity: PeerIdentity | null;
  private readonly identitySigner: ((data: Buffer) => Promise<Buffer>) | null;
  private readonly limiter: PeerLimiter;
  private readonly heartbeatTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly onPeerDisconnected: ((peer: DiscoveredPeer) => void) | null;

  private server: tls.Server | null = null;
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;
  private boundPort = 0;
  private ready = false;
  private tlsKey = "";
  private tlsCert = "";
  private certFingerprint = "";
  private taskHandler: TaskHandler | null = null;
  private readonly discovered = new Map<string, DiscoveredPeer>();
  private readonly peerCapabilities = new Map<string, PeerCapabilities>();
  private readonly capabilityProbes = new Map<string, Promise<PeerCapabilities | null>>();
  private readonly probeFailures = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: NetworkLightOptions = {}) {
    this.host = options.host ?? "0.0.0.0";
    this.configuredPort = options.port ?? 0;
    this.name =
      options.name ?? `p2p-hub-${crypto.randomBytes(4).toString("hex")}`;
    this.skills = [...(options.skills ?? [])];
    this.maxPayloadBytes = options.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;
    this.instanceId = crypto.randomUUID();
    this.identity = options.identity ?? null;
    this.identitySigner = options.identitySigner ?? null;
    this.limiter = new PeerLimiter({ ...DEFAULT_PEER_LIMITS, ...options.peerLimits });
    this.heartbeatTtlMs = options.heartbeatTtlMs ?? HEARTBEAT_TTL_MS;
    this.sweepIntervalMs =
      options.sweepIntervalMs ??
      Math.max(1, Math.floor(this.heartbeatTtlMs / 2));
    this.onPeerDisconnected = options.onPeerDisconnected ?? null;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Bound listening port (0 before `start()`, or when using port 0). */
  get port(): number {
    return this.boundPort;
  }

  /**
   * The skills this instance is configured to serve. This is the caller-provided
   * capability set (already filtered to exclude local-only skills). It is NOT
   * broadcast over mDNS (Fase 0C) — capabilities are only exchanged in the
   * authenticated handshake (Fase 1A). Exposed read-only so tests and
   * inspectors can see the configured set.
   */
  get capabilities(): string[] {
    return [...this.skills];
  }

  async start(): Promise<void> {
    if (this.ready) {
      return;
    }

    const { key, cert } = generateSelfSignedCert();
    this.tlsKey = key;
    this.tlsCert = cert;
    const certInfo = new crypto.X509Certificate(cert);
    this.certFingerprint = certInfo.fingerprint256;

    // requestCert + rejectUnauthorized:false (Fase 1B): ask every client for its
    // certificate but do not fail the handshake when it has none (anonymous
    // peers stay possible). When a cert is presented, its fingerprint is used to
    // verify the client's `auth` identity binding. Never flip rejectUnauthorized
    // on: pinning is done via the mDNS fingerprint + identity signature instead.
    this.server = tls.createServer(
      { key, cert, requestCert: true, rejectUnauthorized: false },
      (socket) => {
        this.handleConnection(socket);
      },
    );

    this.boundPort = await new Promise<number>((resolve, reject) => {
      const server = this.server!;
      server.once("error", reject);
      server.listen(this.configuredPort, this.host, () => {
        const address = server.address();
        resolve(
          typeof address === "object" && address !== null
            ? address.port
            : this.configuredPort,
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
        // Fase 0C: mDNS is discovery/bootstrap only. No skill names are
        // announced — an unauthenticated LAN listener must not learn which
        // capabilities exist. Capabilities are exchanged in the Fase 1A
        // authenticated handshake.
        version: mDNS_PROTOCOL_VERSION,
        certFingerprint: this.certFingerprint,
        ...(this.identity ? { peerId: this.identity.peerId } : {}),
      },
    });

    this.browser = this.bonjour.find({ type: SERVICE_TYPE }, (service) => {
      this.onServiceUp(service);
    });
    this.browser.on("down", (service) => {
      this.onServiceDown(service);
    });

    this.sweepTimer = setInterval(() => this.pruneStalePeers(), this.sweepIntervalMs);
    this.sweepTimer.unref?.();

    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;

    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

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
    this.peerCapabilities.clear();
    this.capabilityProbes.clear();
    this.probeFailures.clear();
    this.limiter.clear();
    this.taskHandler = null;
  }

  /**
   * Peers that — per the Fase 1A handshake — offer the requested skill. The
   * handshake runs over the fingerprint-verified TLS connection, so a peer is
   * only listed here after it has actually authenticated and claimed the skill.
   * A peer that cannot complete the handshake is never listed (default-deny).
   */
  async discover(skill: string): Promise<NetworkPeer[]> {
    const results = await Promise.all(
      [...this.discovered.values()].map(async (peer): Promise<NetworkPeer | null> => {
        const caps = await this.capabilitiesFor(peer);
        if (!caps || !caps.skills.includes(skill)) {
          return null;
        }
        return {
          id: peer.id,
          address: peer.address,
          skills: [...caps.skills],
          name: peer.name,
          peerId: caps.peerId,
        };
      }),
    );
    return results.filter((peer): peer is NetworkPeer => peer !== null);
  }

  /**
   * Return every currently discovered peer regardless of skill. Useful for
   * capability/inspector UIs that need the full peer set. Skills are filled in
   * where the peer has completed a handshake; peers not yet probed (or that
   * failed the handshake) show an empty set.
   */
  listPeers(): DiscoveredPeer[] {
    const peers: DiscoveredPeer[] = [];
    for (const peer of this.discovered.values()) {
      const caps = this.peerCapabilities.get(peer.id);
      // A verified identity (from the handshake) overrides the unverified
      // mDNS claim; a peer that never completed a handshake keeps its mDNS
      // claim but is marked unverified.
      const verifiedPeerId = caps?.peerId;
      peers.push({
        id: peer.id,
        address: peer.address,
        skills: caps ? [...caps.skills] : [],
        name: peer.name,
        certFingerprint: peer.certFingerprint,
        peerId: verifiedPeerId ?? peer.peerId,
        peerIdVerified: verifiedPeerId !== undefined,
        protocolVersion: peer.protocolVersion,
      });
    }
    return peers;
  }

  onTask(handler: TaskHandler): void {
    this.taskHandler = handler;
  }

  /**
   * Send a task over a fresh connection that first runs the protocol handshake.
   * The connection is refused (error result) when the peer's certificate does
   * not match the fingerprint learned via mDNS, when the peer rejects or
   * stalls the handshake, or when the peer negotiates a version we do not
   * support. A peer-advertised `maxPayloadBytes` limit is honored locally
   * before the task is put on the wire.
   */
  async sendTask(peer: NetworkPeer, task: TaskRequest): Promise<TaskResult> {
    const { host, port } = parseAddress(peer.address);
    const expectedFingerprint = this.discovered.get(peer.id)?.certFingerprint;
    // Fase 1B: our identity proof (auth message) is only sent when we have a
    // signer; the handshake nonce anchors it.
    const clientNonce = this.canProveIdentity() ? randomNonce() : "";

    return new Promise<TaskResult>((resolve) => {
      let settled = false;
      const finish = (result: TaskResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const socket = tls.connect(
        {
          host,
          port,
          rejectUnauthorized: false,
          // Present our own certificate so the server can verify our `auth`
          // identity binding against the certificate it actually saw (Fase 1B).
          ...(this.tlsKey && this.tlsCert ? { key: this.tlsKey, cert: this.tlsCert } : {}),
        },
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
          socket.write(
            encodeFrame(
              encodeHello(
                [NETWORK_PROTOCOL_VERSION],
                this.skills,
                clientNonce || undefined,
              ),
            ),
          );
        },
      );

      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let phase: "hello_ack" | "result" = "hello_ack";
      const timer = setTimeout(() => {
        socket.destroy();
        finish({
          taskId: task.id,
          status: "error",
          error:
            phase === "hello_ack"
              ? "timed out during protocol handshake"
              : "timed out waiting for response",
        });
      }, RESPONSE_TIMEOUT_MS);

      socket.on("data", async (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
          for (;;) {
            const message = tryDecodeFrame(buffer);
            if (message === null) {
              return;
            }
            buffer = message.rest;

            if (phase === "hello_ack") {
              const ack = parseEnvelope(message.value);
              if (!ack || ack.type !== "hello_ack") {
                socket.destroy();
                finish({
                  taskId: task.id,
                  status: "error",
                  error: "peer rejected the protocol handshake",
                });
                return;
              }
              const body = ack.body as HelloAckBody;
              if (body.version !== NETWORK_PROTOCOL_VERSION) {
                socket.destroy();
                finish({
                  taskId: task.id,
                  status: "error",
                  error: `peer negotiated unsupported protocol version ${body.version}`,
                });
                return;
              }
              // Fase 1B: if the server claims an identity, it must prove it —
              // a valid Ed25519 signature over the binding message AND a cert
              // fingerprint matching the certificate actually presented.
              let verifiedServerPeerId: string | undefined;
              if (body.identity) {
                const presentedCertFp = normalizeFingerprint(
                  socket.getPeerCertificate().fingerprint256 ?? "",
                );
                const validBinding = this.verifyIdentity(
                  body.identity,
                  clientNonce,
                  body.nonce ?? "",
                  presentedCertFp,
                );
                if (!validBinding) {
                  socket.destroy();
                  finish({
                    taskId: task.id,
                    status: "error",
                    error: "peer failed identity binding",
                  });
                  return;
                }
                verifiedServerPeerId = body.identity.peerId;
              }
              this.peerCapabilities.set(peer.id, {
                skills: [...body.capabilities].slice(0, MAX_CAPABILITIES),
                limits: body.limits ?? null,
                peerId: verifiedServerPeerId,
                fetchedAt: Date.now(),
              });

              const maxPayload = body.limits?.maxPayloadBytes;
              let taskFrame: string;
              try {
                taskFrame = encodeTask(task);
              } catch {
                socket.destroy();
                finish({
                  taskId: task.id,
                  status: "error",
                  error: "task payload is not JSON-serializable",
                });
                return;
              }
              if (maxPayload !== undefined && taskFrame.length > maxPayload) {
                socket.destroy();
                finish({
                  taskId: task.id,
                  status: "error",
                  error: `payload exceeds peer's limit (${maxPayload} bytes)`,
                });
                return;
              }
              phase = "result";
              // Prove our identity to the server (Fase 1B) before the task.
              const authFrame = await this.buildAuthFrame(
                clientNonce,
                body.nonce ?? "",
              );
              if (authFrame) {
                socket.write(encodeFrame(authFrame));
              }
              socket.write(encodeFrame(taskFrame));
              continue;
            }

            const result = parseEnvelope(message.value);
            if (!result || result.type !== "result") {
              socket.destroy();
              finish({
                taskId: task.id,
                status: "error",
                error: "unexpected message type from peer",
              });
              return;
            }
            socket.destroy();
            finish(result.body as TaskResult);
            return;
          }
        } catch (err) {
          socket.destroy();
          finish({
            taskId: task.id,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      socket.once("error", (err) => {
        finish({ taskId: task.id, status: "error", error: err.message });
      });
      socket.once("close", () => {
        finish({
          taskId: task.id,
          status: "error",
          error:
            phase === "hello_ack"
              ? "peer closed the connection during the protocol handshake"
              : "peer closed the connection before sending a response",
        });
      });
    });
  }

  /** Whether this instance can prove a claimed identity over the wire. */
  private canProveIdentity(): boolean {
    return this.identity !== null && this.identitySigner !== null;
  }

  /**
   * Verify an identity binding: the signature must be valid under the claimed
   * `peerId` AND the bound certificate fingerprint must equal the certificate
   * this socket actually presented. Verification needs no local signer — the
   * claimed `peerId` is itself the public key.
   */
  private verifyIdentity(
    binding: IdentityBinding,
    clientNonce: string,
    serverNonce: string,
    presentedCertFingerprint: string,
  ): boolean {
    return (
      binding.certFingerprint === presentedCertFingerprint &&
      verifyIdentityBinding(
        binding.peerId,
        clientNonce,
        serverNonce,
        binding.certFingerprint,
        binding.signature,
      )
    );
  }

  /**
   * Build the `auth` frame proving our identity, or `null` when we have
   * nothing to prove. The signature binds both handshake nonces AND our own
   * certificate fingerprint to the claimed `peerId`.
   */
  private async buildAuthFrame(
    clientNonce: string,
    serverNonce: string,
  ): Promise<string | null> {
    if (!this.canProveIdentity()) {
      return null;
    }
    const certFingerprint = normalizeFingerprint(this.certFingerprint);
    const signature = await this.identitySigner!(
      buildIdentityBindingMessage(clientNonce, serverNonce, certFingerprint),
    );
    return encodeAuth({
      peerId: this.identity!.peerId,
      certFingerprint,
      signature: signature.toString("hex"),
    });
  }

  private handleConnection(socket: tls.TLSSocket): void {
    const ip = socket.remoteAddress ?? "unknown";
    // Fase 1C: refuse the connection outright when this IP already holds its
    // full connection budget — before any bytes are parsed.
    if (!this.limiter.tryAcquireConnection(ip)) {
      socket.destroy();
      return;
    }

    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let handshakeDone = false;
    let clientNonce = "";
    let serverNonce = "";
    let authenticatedPeerId: string | null = null;
    let sawTask = false;
    const handshakeTimer = setTimeout(() => {
      socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    socket.once("close", () => {
      clearTimeout(handshakeTimer);
      this.limiter.releaseConnection(ip);
    });

    socket.on("data", async (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        for (;;) {
          const message = tryDecodeFrame(buffer);
          if (message === null) {
            return;
          }
          buffer = message.rest;
          const envelope = parseEnvelope(message.value);
          if (!envelope) {
            socket.destroy();
            return;
          }
          if (!handshakeDone) {
            if (envelope.type !== "hello") {
              socket.destroy();
              return;
            }
            // Every handshake + task counts against this IP's request budget.
            if (!this.limiter.allowRequest(ip)) {
              socket.destroy();
              return;
            }
            const hello = envelope.body as HelloBody;
            if (negotiateVersion(hello.versions) === null) {
              socket.destroy();
              return;
            }
            clearTimeout(handshakeTimer);
            handshakeDone = true;
            clientNonce = hello.nonce ?? "";
            serverNonce = this.canProveIdentity() ? randomNonce() : "";
            const identity = await this.buildServerIdentity(
              clientNonce,
              serverNonce,
            );
            socket.write(
              encodeFrame(
                encodeHelloAck(
                  NETWORK_PROTOCOL_VERSION,
                  this.skills,
                  { maxPayloadBytes: this.maxPayloadBytes },
                  serverNonce || undefined,
                  identity,
                ),
              ),
            );
            continue;
          }
          if (envelope.type === "auth") {
            // Only one auth per connection, and never after the first task.
            if (authenticatedPeerId !== null || sawTask) {
              socket.destroy();
              return;
            }
            const binding = envelope.body as IdentityBinding;
            const presentedCertFp = normalizeFingerprint(
              socket.getPeerCertificate().fingerprint256 ?? "",
            );
            if (
              !this.verifyIdentity(
                binding,
                clientNonce,
                serverNonce,
                presentedCertFp,
              )
            ) {
              socket.destroy();
              return;
            }
            authenticatedPeerId = binding.peerId;
            continue;
          }
          if (envelope.type !== "task") {
            socket.destroy();
            return;
          }
          sawTask = true;
          if (!this.limiter.allowRequest(ip)) {
            socket.destroy();
            return;
          }
          if (!this.limiter.tryAcquireTask(ip)) {
            socket.write(
              encodeFrame(
                encodeResult({
                  taskId: (envelope.body as TaskBody).id,
                  status: "error",
                  error: "too many concurrent tasks",
                }),
              ),
            );
            continue;
          }
          void this.handleMessage(
            socket,
            envelope.body as TaskBody,
            authenticatedPeerId,
            ip,
          );
        }
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => {
      socket.destroy();
    });
  }

  /**
   * Our identity proof for `hello_ack`, or `undefined` when anonymous. The
   * signature binds both handshake nonces AND our certificate fingerprint to
   * our claimed `peerId`, so the client can verify the full
   * "claimed id ↔ Ed25519 key ↔ transport cert" chain in one step.
   */
  private async buildServerIdentity(
    clientNonce: string,
    serverNonce: string,
  ): Promise<IdentityBinding | undefined> {
    if (!this.canProveIdentity()) {
      return undefined;
    }
    const certFingerprint = normalizeFingerprint(this.certFingerprint);
    const signature = await this.identitySigner!(
      buildIdentityBindingMessage(clientNonce, serverNonce, certFingerprint),
    );
    return {
      peerId: this.identity!.peerId,
      certFingerprint,
      signature: signature.toString("hex"),
    };
  }

  private async handleMessage(
    socket: tls.TLSSocket,
    task: TaskBody,
    authenticatedPeerId: string | null,
    ip: string,
  ): Promise<void> {
    try {
      const result = await this.dispatchTask({
        id: task.id,
        skill: task.skill,
        payload: task.payload,
        ...(authenticatedPeerId ? { peerId: authenticatedPeerId } : {}),
      });
      socket.write(encodeFrame(encodeResult(result)));
    } finally {
      this.limiter.releaseTask(ip);
    }
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

  /**
   * Return the capabilities a peer offers, probing it over a fresh
   * handshake connection when they are not cached yet. Failures are cached
   * briefly (negative cache) so a down or non-compliant peer is not hammered
   * on every {@link discover} call.
   */
  private async capabilitiesFor(
    peer: DiscoveredPeer,
  ): Promise<PeerCapabilities | null> {
    const cached = this.peerCapabilities.get(peer.id);
    if (cached) {
      return cached;
    }
    const lastFailure = this.probeFailures.get(peer.id);
    if (lastFailure !== undefined && Date.now() - lastFailure < PROBE_RETRY_MS) {
      return null;
    }
    const inflight = this.capabilityProbes.get(peer.id);
    if (inflight) {
      return inflight;
    }
    const probe = this.probeCapabilities(peer).finally(() => {
      this.capabilityProbes.delete(peer.id);
    });
    this.capabilityProbes.set(peer.id, probe);
    return probe;
  }

  /** Open a handshake-only connection to a peer and read its capabilities. */
  private probeCapabilities(
    peer: DiscoveredPeer,
  ): Promise<PeerCapabilities | null> {
    const { host, port } = parseAddress(peer.address);
    const expectedFingerprint = peer.certFingerprint;
    const clientNonce = this.canProveIdentity() ? randomNonce() : "";

    return new Promise<PeerCapabilities | null>((resolve) => {
      let settled = false;
      const finish = (caps: PeerCapabilities | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (!caps) {
          this.probeFailures.set(peer.id, Date.now());
        }
        resolve(caps);
      };

      const socket = tls.connect(
        {
          host,
          port,
          rejectUnauthorized: false,
          ...(this.tlsKey && this.tlsCert ? { key: this.tlsKey, cert: this.tlsCert } : {}),
        },
        () => {
          const presented = socket.getPeerCertificate().fingerprint256 ?? "";
          if (
            !expectedFingerprint ||
            !fingerprintsMatch(expectedFingerprint, presented)
          ) {
            socket.destroy();
            finish(null);
            return;
          }
          socket.write(
            encodeFrame(
              encodeHello(
                [NETWORK_PROTOCOL_VERSION],
                this.skills,
                clientNonce || undefined,
              ),
            ),
          );
        },
      );

      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        finish(null);
      }, HANDSHAKE_TIMEOUT_MS);

      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
          const message = tryDecodeFrame(buffer);
          if (message === null) {
            return;
          }
          const ack = parseEnvelope(message.value);
          if (!ack || ack.type !== "hello_ack") {
            socket.destroy();
            finish(null);
            return;
          }
          const body = ack.body as HelloAckBody;
          // Fase 1B: a claimed server identity must verify, or the peer is
          // treated as untrustworthy (default-deny) — never probed further.
          let verifiedServerPeerId: string | undefined;
          if (body.identity) {
            const presentedCertFp = normalizeFingerprint(
              socket.getPeerCertificate().fingerprint256 ?? "",
            );
            if (
              !this.verifyIdentity(
                body.identity,
                clientNonce,
                body.nonce ?? "",
                presentedCertFp,
              )
            ) {
              socket.destroy();
              finish(null);
              return;
            }
            verifiedServerPeerId = body.identity.peerId;
          }
          const caps: PeerCapabilities = {
            skills: [...body.capabilities].slice(0, MAX_CAPABILITIES),
            limits: body.limits ?? null,
            peerId: verifiedServerPeerId,
            fetchedAt: Date.now(),
          };
          this.peerCapabilities.set(peer.id, caps);
          socket.destroy();
          finish(caps);
        } catch {
          socket.destroy();
          finish(null);
        }
      });

      socket.once("error", () => finish(null));
      socket.once("close", () => finish(null));
    });
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
    const certFingerprint = service.txt?.certFingerprint as string | undefined;
    const peerId = service.txt?.peerId as string | undefined;
    const protocolVersion = service.txt?.version as string | undefined;
    // The peer may have restarted, so capabilities from a previous instance of
    // the same mDNS name are no longer trustworthy.
    this.peerCapabilities.delete(id);
    this.probeFailures.delete(id);
    this.discovered.set(id, {
      id,
      address,
      // mDNS carries no capabilities (Fase 0C); filled in by the Fase 1A
      // handshake.
      skills: [],
      name: service.name,
      certFingerprint,
      peerId,
      protocolVersion,
      lastSeen: Date.now(),
    });
  }

  private onServiceDown(service: Service): void {
    const id = service.txt?.id as string | undefined;
    if (id) {
      this.discovered.delete(id);
      this.peerCapabilities.delete(id);
      this.capabilityProbes.delete(id);
      this.probeFailures.delete(id);
    }
  }

  /**
   * Remove peers that have not announced themselves within the TTL window.
   * Called on a timer by {@link start}, but exposed (with an injectable
   * `now`) so tests can advance time deterministically.
   */
  pruneStalePeers(now: number = Date.now()): DiscoveredPeer[] {
    const pruned: DiscoveredPeer[] = [];
    for (const [id, peer] of this.discovered) {
      const lastSeen = peer.lastSeen ?? now;
      if (now - lastSeen > this.heartbeatTtlMs) {
        this.discovered.delete(id);
        this.peerCapabilities.delete(id);
        this.capabilityProbes.delete(id);
        this.probeFailures.delete(id);
        pruned.push(peer);
      }
    }
    for (const peer of pruned) {
      this.onPeerDisconnected?.(peer);
    }
    return pruned;
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
  value: unknown;
  rest: Buffer<ArrayBufferLike>;
}

/**
 * Decode a complete frame, or return `null` when more bytes are needed.
 * Throws on any invalid frame (oversized or malformed) so the caller can
 * close the connection — malformed input defaults to deny, never to ignore.
 */
function tryDecodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 4) {
    return null;
  }
  const length = buffer.readUInt32BE(0);
  if (buffer.length < 4 + length) {
    // A declared length beyond the cap is malformed no matter how much of the
    // frame has arrived — reject before waiting for bytes that can never be
    // valid (default-deny, fail fast).
    if (length > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `frame exceeds maximum allowed size (${length} > ${MAX_PAYLOAD_BYTES})`,
      );
    }
    return null;
  }
  const body = buffer.subarray(4, 4 + length);
  const rest = buffer.subarray(4 + length);
  // Fase 1C: reuse the SDK's canonical payload-size guard on the real bytes.
  validatePayloadSize(body, MAX_PAYLOAD_BYTES);
  const raw = body.toString("utf8");
  validateJsonNestingDepth(raw);
  const value = JSON.parse(raw) as unknown;
  validateObjectDepth(value);
  return { value, rest };
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

function fingerprintsMatch(expected: string, presented: string): boolean {
  const normalizedExpected = normalizeFingerprint(expected);
  const normalizedPresented = normalizeFingerprint(presented);
  return normalizedExpected.length > 0 && normalizedExpected === normalizedPresented;
}
