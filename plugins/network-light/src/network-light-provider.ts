import * as tls from "node:tls";
import * as crypto from "node:crypto";
import Bonjour from "bonjour-service";
import type { Browser, Service, ServiceConfig } from "bonjour-service";
import * as forge from "node-forge";
import { detectLanIPv4 } from "./lan-interface";
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
  encodeEventEmit,
  encodeHello,
  encodeHelloAck,
  encodeResult,
  encodeSubAck,
  encodeSubReq,
  encodeTask,
  mDNS_PROTOCOL_VERSION,
  supportedVersion,
  normalizeFingerprint,
  parseEnvelope,
  randomNonce,
  verifyIdentityBinding,
  type EventEmitBody,
  type HelloAckBody,
  type HelloBody,
  type HelloHints,
  type IdentityBinding,
  type SubAckBody,
  type SubReqBody,
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
   * Persistent identity. Required: {@link start} fails loudly without it. Its
   * `peerId` is advertised in the mDNS TXT record alongside (not instead of)
   * the session `certFingerprint`. The claim is proven over the wire — see
   * {@link NetworkLightOptions.identitySigner}. There is no anonymous mode.
   */
  identity?: PeerIdentity;
  /**
   * Capability that signs bytes with the Ed25519 private key behind
   * {@link NetworkLightOptions.identity}. Required: {@link start} fails loudly
   * without it. It is used for the Fase 1B identity binding (client `auth` and
   * server `hello_ack.identity`). The private key stays with the caller
   * (typically core's `IdentityManager`) — the provider only ever receives
   * signed bytes.
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
  /**
   * Explicit IPv4 multicast interface for the mDNS socket (passed through to
   * `bonjour-service` as the `interface` option, which drives both
   * `addMembership` and `setMulticastInterface`). Defaults to the physical
   * LAN IPv4 detected by {@link detectLanIPv4} (the fix for the one-sided
   * mDNS discovery problem on Windows). Set to a specific address to pin the
   * interface, or pass any non-empty value to force a particular one.
   */
  mdnsInterface?: string;
  /**
   * Proactive unicast reply ("proactive peer handshake"): when an mDNS
   * announcement is heard from a peer, connect back to its advertised P2P
   * address and complete a verified hello+auth handshake so the peer can
   * register us even if our own outbound multicast never reaches it. Also
   * re-pings throttled on each re-announcement so a reverse-registered route
   * stays fresh. Defaults to `true`.
   */
  unicastPing?: boolean;
  /** Minimum gap between unicast pings to the same peer instance. */
  unicastPingMinIntervalMs?: number;
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

/**
 * A Stap 5 inbound event-transport message. `peerId` is always the Fase 1B
 * authenticated connection identity — the provider sets it, never the peer.
 */
export type InboundEventMessage =
  | { peerId: string; type: "sub_req"; body: SubReqBody }
  | { peerId: string; type: "event_emit"; body: EventEmitBody };

/**
 * Inbound event-message handler (the core SubscriptionHub/RemoteEventAdapter
 * side). Returning a `SubAckBody` answers a `sub_req` on the same connection;
 * returning `null` (the normal answer to an `event_emit`) writes nothing.
 */
export type EventMessageHandler = (
  msg: InboundEventMessage,
) => Promise<SubAckBody | null> | SubAckBody | null;

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
  private readonly mdnsInterface: string | null;
  private readonly unicastPingEnabled: boolean;
  private readonly pingMinIntervalMs: number;

  private server: tls.Server | null = null;
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;
  private boundPort = 0;
  private ready = false;
  private tlsKey = "";
  private tlsCert = "";
  private certFingerprint = "";
  private taskHandler: TaskHandler | null = null;
  private eventMessageHandler: EventMessageHandler | null = null;
  private readonly discovered = new Map<string, DiscoveredPeer>();
  private readonly peerCapabilities = new Map<string, PeerCapabilities>();
  private readonly capabilityProbes = new Map<string, Promise<PeerCapabilities | null>>();
  private readonly probeFailures = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private publishedService: Service | null = null;
  private reannounceTimer: ReturnType<typeof setInterval> | null = null;
  private announceSeq = 0;
  /** Last unicast-ping time per peer instance id (reverse-registration). */
  private readonly pingedAt = new Map<string, number>();

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
    this.mdnsInterface = options.mdnsInterface ?? null;
    this.unicastPingEnabled = options.unicastPing ?? true;
    this.pingMinIntervalMs =
      options.unicastPingMinIntervalMs ??
      Math.max(1_000, Math.floor(this.heartbeatTtlMs / 2));
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Reverse-registration hints carried in every outbound `hello` (when we have
   * a bound port): our mDNS instance id and listening port. The peer uses them
   * to register us into its discovered map after it has verified our identity
   * over `auth` — the proactive-peer-handshake route that keeps discovery
   * working even when our outbound multicast is blocked.
   */
  private helloHints(): HelloHints | undefined {
    return this.boundPort > 0
      ? { instanceId: this.instanceId, listenPort: this.boundPort }
      : undefined;
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

    if (!this.identity || !this.identitySigner) {
      throw new Error(
        "NetworkLightProvider requires identity and identitySigner — " +
          "transport identity is mandatory, there is no anonymous mode",
      );
    }

    const { key, cert } = generateSelfSignedCert();
    this.tlsKey = key;
    this.tlsCert = cert;
    const certInfo = new crypto.X509Certificate(cert);
    this.certFingerprint = certInfo.fingerprint256;

    // requestCert + rejectUnauthorized:false (Fase 1B): ask every client for its
    // certificate but do not hard-fail the TLS handshake when it has none. A
    // client without a certificate presents an empty fingerprint, so it can
    // never produce a valid `auth` binding (the signature must match both the
    // advertised cert fingerprint and the presented one) and its tasks are
    // refused by default-deny. Identity is mandatory. Never flip
    // rejectUnauthorized on: pinning is done via the mDNS fingerprint +
    // identity signature instead.
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

    // Explicit multicast-interface fix: multicast-dns's default interface is
    // "0.0.0.0" on non-darwin platforms, which on Windows can pick a virtual
    // adapter (Hyper-V/WSL/VPN) instead of the physical NIC — the classic
    // one-sided mDNS discovery problem. Passing `interface` makes the mDNS
    // socket bind to a concrete LAN address so both `addMembership` and
    // `setMulticastInterface` use that adapter deterministically. An explicit
    // `mdnsInterface` option wins over the detected physical LAN IPv4.
    const mdnsInterface = this.mdnsInterface ?? detectLanIPv4() ?? undefined;
    // `interface` and `bind` are not part of bonjour-service's TS
    // `ServiceConfig`, but both are passed straight through to multicast-dns
    // (verified in the installed mdns-server.js and multicast-dns index.js).
    // multicast-dns uses `opts.interface` for BOTH the socket bind and the
    // addMembership/setMulticastInterface calls. Binding the socket to a
    // specific adapter IP breaks loopback multicast delivery (two in-process
    // peers on the same host can no longer hear each other), which is what
    // the discovery tests and local-only setups rely on. So we bind wildcard
    // (`bind: "0.0.0.0"`) and restrict only membership + egress
    // (`interface`) to the physical LAN adapter — that is the actual
    // one-sided-discovery fix: the socket still receives on every adapter,
    // but queries and responses go out the physical NIC and the group is
    // joined on it, never on a virtual adapter.
    const bonjourOptions: Partial<ServiceConfig> & { interface?: string; bind?: string } = {};
    if (mdnsInterface) {
      bonjourOptions.interface = mdnsInterface;
      bonjourOptions.bind = "0.0.0.0";
    }
    this.bonjour = new Bonjour(bonjourOptions);
    // `probe: false`: this instance owns its name on this host, and skipping
    // the probe lets us re-announce the same service on a heartbeat below
    // without a spurious "name already in use" teardown.
    this.publishedService = this.bonjour.publish({
      name: this.name,
      type: SERVICE_TYPE,
      port: this.boundPort,
      probe: false,
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

    this.browser = this.bonjour.find({ type: SERVICE_TYPE });
    this.browser.on("up", (service) => this.onServiceUp(service));
    this.browser.on("down", (service) => this.onServiceDown(service));
    // bonjour-service only announces once with an exponential backoff that
    // stops entirely after a few minutes; without a heartbeat our
    // `heartbeatTtlMs` prune would then remove every live peer. A peer's
    // re-announcement carries a monotonic `announceSeq` in its TXT, so each
    // one surfaces here as a `txt-update` and refreshes `lastSeen`.
    this.browser.on("txt-update", (service) => this.onServiceHeartbeat(service));
    this.browser.on("srv-update", (service) => this.onServiceHeartbeat(service));

    this.reannounceTimer = setInterval(() => this.reannounce(), this.sweepIntervalMs);
    this.reannounceTimer.unref?.();

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

    if (this.reannounceTimer) {
      clearInterval(this.reannounceTimer);
      this.reannounceTimer = null;
    }
    this.publishedService = null;

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
    this.pingedAt.clear();
    this.limiter.clear();
    this.taskHandler = null;
    this.eventMessageHandler = null;
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
   * Register the Stap 5 inbound event-message handler (subscription requests
   * and published events). The provider performs only transport-level routing
   * and identity binding; every authorization decision lives in the handler
   * (the core hub), never here.
   */
  onEventMessage(handler: EventMessageHandler): void {
    this.eventMessageHandler = handler;
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
    // Fase 1B: our identity proof (auth message) is mandatory; the handshake
    // nonce anchors it.
    const clientNonce = randomNonce();

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
                clientNonce,
                this.helloHints(),
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
              // Fase 1B: the server MUST prove its identity — a valid Ed25519
              // signature over the binding message AND a cert fingerprint
              // matching the certificate actually presented. No anonymous
              // servers; a missing/invalid identity is refused.
              const presentedCertFp = normalizeFingerprint(
                socket.getPeerCertificate().fingerprint256 ?? "",
              );
              const validBinding = this.verifyIdentity(
                body.identity,
                clientNonce,
                body.nonce,
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
              const verifiedServerPeerId = body.identity.peerId;
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
              const authFrame = await this.buildAuthFrame(clientNonce, body.nonce);
              socket.write(encodeFrame(authFrame));
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

  /**
   * Stap 5: send a `sub_req` (subscribe/unsubscribe) to a peer over a fresh
   * handshake connection and await its `sub_ack`. Returns the ack, or `null`
   * (never throws) on any transport/handshake failure or when the peer rejects
   * the request. A peer-advertised `maxPayloadBytes` limit is honored locally
   * before the frame is put on the wire.
   */
  async sendSubReq(peer: NetworkPeer, body: SubReqBody): Promise<SubAckBody | null> {
    const session = await this.connectForEvent(peer);
    if (!session) {
      return null;
    }
    const { socket } = session;
    const frame = encodeSubReq(body);
    if (!this.withinPeerLimit(peer, frame)) {
      socket.destroy();
      return null;
    }

    return new Promise<SubAckBody | null>((resolve) => {
      let settled = false;
      const finish = (ack: SubAckBody | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(ack);
      };

      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      const timer = setTimeout(() => finish(null), RESPONSE_TIMEOUT_MS);

      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
          const message = tryDecodeFrame(buffer);
          if (message === null) {
            return;
          }
          const ack = parseEnvelope(message.value);
          if (!ack || ack.type !== "sub_ack") {
            finish(null);
            return;
          }
          finish(ack.body as SubAckBody);
        } catch {
          finish(null);
        }
      });

      socket.once("error", () => finish(null));
      socket.once("close", () => finish(null));

      try {
        socket.write(encodeFrame(frame));
      } catch {
        finish(null);
      }
    });
  }

  /**
   * Stap 5: publish an `event_emit` to a subscribed peer over a fresh
   * handshake connection. Fire-and-forget — there is no event ack; the
   * receiver's telemetry gate is what bounds abuse. Resolves to `true` when
   * the frame was flushed to the socket, `false` (never throws) on any
   * transport/handshake failure or an oversized frame.
   */
  async sendEvent(peer: NetworkPeer, body: EventEmitBody): Promise<boolean> {
    const session = await this.connectForEvent(peer);
    if (!session) {
      return false;
    }
    const { socket } = session;
    const frame = encodeEventEmit(body);
    if (!this.withinPeerLimit(peer, frame)) {
      socket.destroy();
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), RESPONSE_TIMEOUT_MS);
      socket.once("error", () => finish(false));
      try {
        socket.write(encodeFrame(frame), (err) => {
          if (err) {
            finish(false);
            return;
          }
          socket.end();
          finish(true);
        });
      } catch {
        finish(false);
      }
    });
  }

  /** Honor the peer's advertised `maxPayloadBytes` before sending a frame. */
  private withinPeerLimit(peer: NetworkPeer, frame: string): boolean {
    const limits = this.peerCapabilities.get(peer.id)?.limits;
    const max = limits?.maxPayloadBytes;
    return max === undefined || frame.length <= max;
  }

  /**
   * Open a fresh connection to `peer`, run the full Fase 1B handshake
   * (fingerprint check → hello → verified hello_ack → our auth) and resolve
   * with the ready socket. The event frame is written by the caller; `auth`
   * has already been flushed so the peer can verify us. Returns `null` (never
   * throws) on any failure.
   */
  private connectForEvent(peer: NetworkPeer): Promise<{
    socket: tls.TLSSocket;
    clientNonce: string;
    serverNonce: string;
  } | null> {
    const { host, port } = parseAddress(peer.address);
    const expectedFingerprint = this.discovered.get(peer.id)?.certFingerprint;
    const clientNonce = randomNonce();

    return new Promise<{
      socket: tls.TLSSocket;
      clientNonce: string;
      serverNonce: string;
    } | null>((resolve) => {
      let settled = false;
      const finish = (
        value: { socket: tls.TLSSocket; clientNonce: string; serverNonce: string } | null,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.off("data", dataHandler);
        resolve(value);
      };

      const socket = tls.connect(
        {
          host,
          port,
          rejectUnauthorized: false,
          ...(this.tlsKey && this.tlsCert ? { key: this.tlsKey, cert: this.tlsCert } : {}),
        },
        () => {
          if (!expectedFingerprint) {
            socket.destroy();
            finish(null);
            return;
          }
          const presented = socket.getPeerCertificate().fingerprint256 ?? "";
          if (!fingerprintsMatch(expectedFingerprint, presented)) {
            socket.destroy();
            finish(null);
            return;
          }
          socket.write(
            encodeFrame(
              encodeHello(
                [NETWORK_PROTOCOL_VERSION],
                this.skills,
                clientNonce,
                this.helloHints(),
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

      const dataHandler = (chunk: Buffer) => {
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
          if (body.version !== NETWORK_PROTOCOL_VERSION) {
            socket.destroy();
            finish(null);
            return;
          }
          const presentedCertFp = normalizeFingerprint(
            socket.getPeerCertificate().fingerprint256 ?? "",
          );
          if (
            !this.verifyIdentity(
              body.identity,
              clientNonce,
              body.nonce,
              presentedCertFp,
            )
          ) {
            socket.destroy();
            finish(null);
            return;
          }
          void this.buildAuthFrame(clientNonce, body.nonce)
            .then((authFrame) => {
              socket.write(encodeFrame(authFrame));
              finish({ socket, clientNonce, serverNonce: body.nonce });
            })
            .catch(() => {
              socket.destroy();
              finish(null);
            });
        } catch {
          socket.destroy();
          finish(null);
        }
      };
      socket.on("data", dataHandler);
      socket.once("error", () => finish(null));
      socket.once("close", () => finish(null));
    });
  }

  /**
   * Verify an identity binding: the signature must be valid under the claimed
   * `peerId` AND the bound certificate fingerprint must equal the certificate
   * this socket actually presented. Verification needs no local signer — the
   * claimed `peerId` is itself the public key.
   */  private verifyIdentity(
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
   * Build the `auth` frame proving our identity. The signature binds both
   * handshake nonces AND our own certificate fingerprint to the claimed
   * `peerId`. `start()` guarantees identity + signer are present, so this
   * never returns null.
   */
  private async buildAuthFrame(
    clientNonce: string,
    serverNonce: string,
  ): Promise<string> {
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
    // Reverse-registration hints from the client's `hello` (proactive peer
    // handshake). Used only to register a discovered route once the client's
    // identity has been verified via `auth` — never before, never for anything
    // security-relevant.
    let helloInstanceId: string | undefined;
    let helloListenPort: number | undefined;
    let presentedCertFp = "";
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
            if (supportedVersion(hello.versions) === null) {
              socket.destroy();
              return;
            }
            helloInstanceId = hello.instanceId;
            helloListenPort = hello.listenPort;
            clearTimeout(handshakeTimer);
            handshakeDone = true;
            clientNonce = hello.nonce;
            serverNonce = randomNonce();
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
                  serverNonce,
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
            presentedCertFp = normalizeFingerprint(
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
            // Reverse registration: only now that the client's identity is
            // verified do we add it to our discovered map (default-deny — an
            // unauthenticated connection registers nothing). The route lets us
            // reach the client back even if its outbound multicast never
            // reached us.
            this.registerReversePeer({
              instanceId: helloInstanceId,
              listenPort: helloListenPort,
              peerId: binding.peerId,
              certFingerprint: presentedCertFp,
              sourceIp: ip,
            });
            continue;
          }
          if (envelope.type === "sub_req") {
            // Default-deny: a subscription request from an unauthenticated
            // connection is refused (same phase discipline as `task`).
            if (authenticatedPeerId === null) {
              socket.destroy();
              return;
            }
            if (!this.limiter.allowRequest(ip)) {
              socket.destroy();
              return;
            }
            if (!this.limiter.tryAcquireTask(ip)) {
              const body = envelope.body as SubReqBody;
              socket.write(
                encodeFrame(
                  encodeSubAck({
                    subscriptionId: body.subscriptionId,
                    topic: body.topic,
                    accepted: false,
                    reason: "too many concurrent requests",
                  }),
                ),
              );
              continue;
            }
            void this.handleSubReqMessage(
              socket,
              envelope.body as SubReqBody,
              authenticatedPeerId,
              ip,
            );
            continue;
          }
          if (envelope.type === "event_emit") {
            // Default-deny: no anonymous event traffic.
            if (authenticatedPeerId === null) {
              socket.destroy();
              return;
            }
            // Publisher identity is never caller-supplied: the wire
            // `publisherPeerId` must equal the Fase 1B authenticated identity
            // of this connection or the frame is a spoof — close.
            const body = envelope.body as EventEmitBody;
            if (body.publisherPeerId !== authenticatedPeerId) {
              socket.destroy();
              return;
            }
            void this.handleEventEmitMessage(socket, body, authenticatedPeerId);
            continue;
          }
          if (envelope.type !== "task") {
            socket.destroy();
            return;
          }
          // Default-deny: a task from an unauthenticated connection is
          // refused. Identity is mandatory — there is no anonymous traffic.
          if (authenticatedPeerId === null) {
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
   * Our identity proof for `hello_ack`. The signature binds both handshake
   * nonces AND our certificate fingerprint to our claimed `peerId`, so the
   * client can verify the full "claimed id ↔ Ed25519 key ↔ transport cert"
   * chain in one step. `start()` guarantees identity + signer are present,
   * so this never returns `undefined`.
   */
  private async buildServerIdentity(
    clientNonce: string,
    serverNonce: string,
  ): Promise<IdentityBinding> {
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

  /**
   * Reverse registration (proactive-peer-handshake receive side): add a peer
   * that just verified its identity over an inbound connection to our
   * discovered map, keyed by the mDNS instance id it announced in `hello`, so
   * we can reach it back even when its outbound multicast never reaches us.
   *
   * Called ONLY after `auth` verification (default-deny: an unauthenticated
   * connection registers nothing). The hints are informational: the registered
   * `peerId` is the *verified* auth identity, the `certFingerprint` is the
   * fingerprint of the certificate actually presented on the wire, and the
   * connect-back address is `remoteAddress:listenPort` (the source IP is the
   * transport's, never a caller-supplied field). A missing/malformed hint
   * registers nothing.
   */
  private registerReversePeer(info: {
    instanceId?: string;
    listenPort?: number;
    peerId: string;
    certFingerprint: string;
    sourceIp: string;
  }): void {
    const { instanceId, listenPort, peerId, certFingerprint, sourceIp } = info;
    if (!instanceId || !listenPort) {
      return;
    }
    if (instanceId === this.instanceId) {
      return;
    }
    const ip = normalizeIPv4(sourceIp);
    if (!ip) {
      return;
    }
    const existing = this.discovered.get(instanceId);
    this.discovered.set(instanceId, {
      id: instanceId,
      address: `${ip}:${listenPort}`,
      skills: existing?.skills ?? [],
      name: existing?.name,
      certFingerprint,
      peerId,
      protocolVersion: String(NETWORK_PROTOCOL_VERSION),
      lastSeen: Date.now(),
    });
  }

  private async handleMessage(
    socket: tls.TLSSocket,
    task: TaskBody,
    authenticatedPeerId: string,
    ip: string,
  ): Promise<void> {
    try {
      const result = await this.dispatchTask({
        id: task.id,
        skill: task.skill,
        payload: task.payload,
        peerId: authenticatedPeerId,
      });
      socket.write(encodeFrame(encodeResult(result)));
    } finally {
      this.limiter.releaseTask(ip);
    }
  }

  /**
   * Answer an inbound `sub_req`: forward it (with the transport-verified
   * peerId) to the registered event handler and write its `sub_ack` back on
   * the same connection. No handler ⇒ fail-closed rejected ack.
   */
  private async handleSubReqMessage(
    socket: tls.TLSSocket,
    body: SubReqBody,
    authenticatedPeerId: string,
    ip: string,
  ): Promise<void> {
    try {
      const handler = this.eventMessageHandler;
      const ack: SubAckBody = handler
        ? (await handler({ peerId: authenticatedPeerId, type: "sub_req", body })) ?? {
            subscriptionId: body.subscriptionId,
            topic: body.topic,
            accepted: false,
            reason: "no event handler",
          }
        : {
            subscriptionId: body.subscriptionId,
            topic: body.topic,
            accepted: false,
            reason: "no event handler",
          };
      socket.write(encodeFrame(encodeSubAck(ack)));
    } finally {
      this.limiter.releaseTask(ip);
    }
  }

  /**
   * Forward an inbound `event_emit` to the registered event handler (with the
   * transport-verified peerId). Fire-and-forget: events have no ack, and the
   * receiver-side telemetry gate is what bounds an abusive publisher.
   */
  private handleEventEmitMessage(
    socket: tls.TLSSocket,
    body: EventEmitBody,
    authenticatedPeerId: string,
  ): void {
    void this.eventMessageHandler?.({ peerId: authenticatedPeerId, type: "event_emit", body });
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

  /**
   * Open a handshake-only connection to a peer, verify its certificate
   * fingerprint (mDNS-announced) and its Fase 1B identity binding, and read
   * its capabilities. When `options.proveIdentity` is set, our own `auth`
   * (identity proof) is sent after `hello_ack` so the peer can register us as
   * a reverse-discovered route — the proactive-peer-handshake reply. This is
   * the shared connection core for {@link probeCapabilities} and
   * {@link unicastPing}; `sendTask` keeps its own flow because it also
   * exchanges a task and a result on the same session.
   *
   * Returns `null` (never throws) on any failure — a probe/ping failure is
   * best-effort and must never break discovery. On success the learned
   * capabilities are cached under `peerId` (the peer's instance id).
   */
  private openHandshake(
    address: string,
    expectedFingerprint: string | undefined,
    options: { proveIdentity?: boolean },
  ): Promise<PeerCapabilities | null> {
    const { host, port } = parseAddress(address);
    const clientNonce = randomNonce();

    return new Promise<PeerCapabilities | null>((resolve) => {
      let settled = false;
      const finish = (caps: PeerCapabilities | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
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
                clientNonce,
                this.helloHints(),
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
          // Fase 1B: the server identity must verify, or the peer is treated
          // as untrustworthy (default-deny) — never probed further. There are
          // no anonymous servers.
          const presentedCertFp = normalizeFingerprint(
            socket.getPeerCertificate().fingerprint256 ?? "",
          );
          if (
            !this.verifyIdentity(
              body.identity,
              clientNonce,
              body.nonce,
              presentedCertFp,
            )
          ) {
            socket.destroy();
            finish(null);
            return;
          }
          const caps: PeerCapabilities = {
            skills: [...body.capabilities].slice(0, MAX_CAPABILITIES),
            limits: body.limits ?? null,
            peerId: body.identity.peerId,
            fetchedAt: Date.now(),
          };
          if (options.proveIdentity) {
            // Prove our identity so the peer can register us (reverse
            // discovery). Once `auth` is flushed we are done — the peer
            // verifies it asynchronously and the connection can close.
            void this.buildAuthFrame(clientNonce, body.nonce).then((authFrame) => {
              socket.write(encodeFrame(authFrame));
              socket.end();
              finish(caps);
            });
            return;
          }
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

  /** Open a handshake-only connection to a peer and read its capabilities. */
  private probeCapabilities(
    peer: DiscoveredPeer,
  ): Promise<PeerCapabilities | null> {
    const caps = this.openHandshake(peer.address, peer.certFingerprint, {});
    void caps.then((result) => {
      if (result) {
        this.peerCapabilities.set(peer.id, result);
      } else {
        this.probeFailures.set(peer.id, Date.now());
      }
    });
    return caps;
  }

  /**
   * Proactive unicast reply ("proactive peer handshake"): complete a verified
   * hello+auth handshake with a peer we discovered via mDNS, so it can
   * register us into its discovered map even when our outbound multicast is
   * blocked (the one-sided Windows mDNS discovery problem). Best-effort: a
   * failure is swallowed — discovery must never depend on it.
   */
  private async unicastPing(peer: DiscoveredPeer): Promise<void> {
    try {
      const caps = await this.openHandshake(peer.address, peer.certFingerprint, {
        proveIdentity: true,
      });
      if (caps) {
        this.peerCapabilities.set(peer.id, caps);
      }
    } catch {
      // best-effort — ignore
    }
  }

  /**
   * Fire a (throttled) unicast ping toward `peer`. Called when its mDNS
   * announcement is first heard and again, at most every
   * `unicastPingMinIntervalMs`, on each re-announcement so a reverse-
   * registered route on the peer stays fresh past its heartbeat TTL.
   */
  private pingPeer(peer: DiscoveredPeer): void {
    if (!this.unicastPingEnabled) {
      return;
    }
    const last = this.pingedAt.get(peer.id) ?? 0;
    if (Date.now() - last < this.pingMinIntervalMs) {
      return;
    }
    this.pingedAt.set(peer.id, Date.now());
    void this.unicastPing(peer);
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
    // Proactive peer handshake: as soon as this announcement is heard, reply
    // with a verified unicast hello+auth so the announcing peer can register
    // us even when our own outbound multicast is blocked.
    this.pingPeer(this.discovered.get(id)!);
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
   * A peer re-announced itself (or changed its SRV records). The identity,
   * certificate and capabilities are unchanged — this is purely a liveness
   * signal — so only `lastSeen` (and a possibly-changed address) is refreshed.
   * Capabilities are deliberately NOT cleared here: a genuine restart gets a
   * fresh instance id and arrives as a regular `up`.
   */
  private onServiceHeartbeat(service: Service): void {
    const id = service.txt?.id as string | undefined;
    if (!id || id === this.instanceId) {
      return;
    }
    const peer = this.discovered.get(id);
    if (!peer) {
      this.onServiceUp(service);
      return;
    }
    const address = this.serviceAddress(service);
    if (address) {
      peer.address = address;
    }
    peer.lastSeen = Date.now();
    // Keep the reverse-registered route on the peer fresh: throttled unicast
    // pings at most every `unicastPingMinIntervalMs`.
    this.pingPeer(peer);
  }

  /**
   * Re-announce our own service so peers keep our `lastSeen` fresh (and late
   * browsers can still find us). bonjour-service's built-in announce chain
   * backs off exponentially and then stops; we re-arm it on a fixed interval
   * instead. The monotonic `announceSeq` in the TXT makes each announcement a
   * distinct record, so a peer's browser surfaces it as a `txt-update`.
   */
  private reannounce(): void {
    const service = this.publishedService;
    if (!service || service.destroyed || !this.ready) {
      return;
    }
    this.announceSeq += 1;
    service.txt = { ...(service.txt ?? {}), announceSeq: this.announceSeq };
    // Drop our earlier registry entry so re-starting does not accumulate
    // duplicates in bonjour's registry, then re-arm the announce chain.
    const registry = (this.bonjour as unknown as { registry?: { services?: Service[] } })
      ?.registry;
    if (registry?.services) {
      const idx = registry.services.indexOf(service);
      if (idx !== -1) {
        registry.services.splice(idx, 1);
      }
    }
    service.activated = false;
    service.start();
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

export interface DecodedFrame {
  value: unknown;
  rest: Buffer<ArrayBufferLike>;
}

/**
 * Decode a complete frame, or return `null` when more bytes are needed.
 * Throws on any invalid frame (oversized or malformed) so the caller can
 * close the connection — malformed input defaults to deny, never to ignore.
 *
 * Exported for the wire-contract fuzz suite (Slice 3): it is the byte-level
 * parser every inbound socket feeds, so the fuzz tests pin the invariant
 * "decode either returns a complete frame, needs more bytes, or throws a
 * bounded, catchable error — it never hangs and never corrupts the buffer".
 */
export function tryDecodeFrame(buffer: Buffer): DecodedFrame | null {
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

/**
 * Normalize a `socket.remoteAddress` to a plain IPv4 string, or `null` when it
 * is not one. IPv6-mapped addresses (`::ffff:a.b.c.d`) are unwrapped so the
 * connect-back address matches the IPv4 form the rest of the stack uses.
 */
function normalizeIPv4(remote: string): string | null {
  const ip = remote.startsWith("::ffff:") ? remote.slice("::ffff:".length) : remote;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) ? ip : null;
}
