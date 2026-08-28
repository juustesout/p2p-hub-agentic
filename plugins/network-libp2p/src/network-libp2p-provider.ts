import * as crypto from "node:crypto";
import type { Connection, PeerId, Stream } from "@libp2p/interface";
import { createLibp2p } from "libp2p";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { tcp } from "@libp2p/tcp";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { autoNAT } from "@libp2p/autonat";
import { dcutr } from "@libp2p/dcutr";
import { identify } from "@libp2p/identify";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import type {
  NetworkPeer,
  NetworkProvider,
  PeerIdentity,
  TaskHandler,
  TaskRequest,
  TaskResult,
} from "@p2p-hub/sdk";
import {
  MAX_PAYLOAD_BYTES,
  validateJsonNestingDepth,
  validateObjectDepth,
  validatePayloadSize,
} from "@p2p-hub/sdk";
// Reuse the existing wire contract verbatim — this transport is a *pipe* for
// the exact same `hello → hello_ack → auth → task → result` protocol that
// network-light runs over TLS. No rewrites, no parallel identity protocol.
import {
  HANDSHAKE_TIMEOUT_MS,
  NETWORK_PROTOCOL_VERSION,
  buildIdentityBindingMessage,
  encodeAuth,
  encodeHello,
  encodeHelloAck,
  encodeResult,
  encodeTask,
  supportedVersion,
  normalizeFingerprint,
  parseEnvelope,
  randomNonce,
  verifyIdentityBinding,
  type HelloAckBody,
  type HelloBody,
  type IdentityBinding,
  type TaskBody,
} from "@p2p-hub/network-light/dist/wire-contract.js";

/**
 * libp2p protocol id for the p2p-hub task stream. This is transport-level
 * routing (like a TCP port) — it carries no identity or authorization meaning.
 * The identity/authorization layer is the wire contract's Ed25519 identity
 * binding, exactly as over network-light's TLS session.
 */
const STREAM_PROTOCOL = "/p2p-hub/network/1.0.0";

/** How long a client waits for the server's `result` after sending a task. */
const RESPONSE_TIMEOUT_MS = 10_000;

export interface NetworkLibp2pOptions {
  /** Skills this instance can serve (already filtered to network-exposed). */
  skills?: string[];
  /**
   * Persistent p2p-hub identity. Required: {@link start} fails loudly without
   * it. This is the identity that authorizes tasks (the Ed25519 `peerId`
   * verified over the wire) — it is completely independent of libp2p's own
   * long-lived PeerId, which is used only as the transport-binding
   * `certFingerprint` (a transport-*identity* pin, not a per-session channel
   * binding — see the class docblock "Channel binding" section).
   */
  identity?: PeerIdentity;
  /**
   * Capability that signs bytes with the Ed25519 private key behind
   * {@link NetworkLibp2pOptions.identity}. Required: {@link start} fails
   * loudly without it. The private key stays with the caller (typically core's
   * `IdentityManager`); the provider only ever receives signed bytes.
   */
  identitySigner?: (data: Buffer) => Promise<Buffer>;
  /**
   * TCP listen addresses (multiaddr strings). Defaults to a loopback ephemeral
   * port only — a WAN deployment must pass explicit addresses. Never binds
   * 0.0.0.0 implicitly (deny by default).
   */
  listenAddresses?: string[];
  /**
   * Relay node multiaddrs (e.g. `/ip4/x.x.x.x/tcp/4001/p2p/<relayPeerId>`).
   * Dialed at start so the node obtains circuit-relay v2 reservations and
   * becomes reachable behind NAT. A relay that is down does not fail start —
   * the node simply stays reachable only on its direct addresses.
   */
  relayAddresses?: string[];
  /**
   * Deel 1 gate: called by {@link start} to confirm the wired TaskBroker
   * enforces broker-wide per-peer rate limiting (`broker.hasRateLimiting()`).
   * The transport refuses to start when this is absent or falsy — a WAN-facing
   * transport without a broker-level task budget would be its own flood
   * surface, so the gate is hard and fail-closed.
   */
  hasBrokerRateLimiting?: () => boolean;
  /**
   * Optie B (identity unification): the raw 64-byte Ed25519 key
   * (`seed ‖ publicKey`) that the p2p-hub `IdentityManager` exports via
   * `exportLibp2pKeySeed()`. When present, libp2p's node is created with this
   * exact private key so the libp2p PeerId *equals* the p2p-hub Ed25519
   * identity (same public key, same peerId over LAN and WAN). Absent (default)
   * = libp2p generates its own random transport key (Optie A / gescheiden).
   * The value is a purpose-built Uint8Array; the PKCS8 PEM never leaves
   * `IdentityManager` (CLAUDE.md principle #6).
   */
  privateKeyRaw?: Uint8Array;
  /**
   * Maximum serialized envelope length this instance accepts on a single
   * incoming message. Advertised in the handshake as `limits.maxPayloadBytes`
   * so a compliant peer refuses to send anything larger. Defaults to
   * {@link MAX_PAYLOAD_BYTES}.
   */
  maxPayloadBytes?: number;
}

/**
 * WAN transport over libp2p: TCP + circuit-relay v2 (client) + AutoNAT/dcutr
 * hole punching, carrying the p2p-hub wire contract as a plain bytepipe.
 *
 * The identity model matches network-light, with one *deliberate* channel-binding
 * difference — see "Channel binding" below.
 *
 * - network-light's `certFingerprint` is the SHA-256 fingerprint of the
 *   self-signed TLS cert a peer presented on the connection (a new cert per
 *   boot). Over libp2p there is no TLS certificate, so the wire-contract field
 *   is filled with `peerFingerprint(peerId)` = SHA-256 of the peer's libp2p
 *   PeerId multihash bytes.
 *
 * - libp2p's own PeerId/Noise is a *pipe*, never an identity or authorization
 *   source: authorization stays entirely in the wire contract's Ed25519
 *   identity binding (`peerId` + signature over the nonces + fingerprint).
 *   The p2p-hub `peerId` delivered to the broker comes only from a verified
 *   `auth`/`hello_ack` binding.
 *
 * ### Channel binding (read before changing the fingerprint logic)
 *
 * In network-light the fingerprint was a *rotating* session-ish credential
 * (a fresh self-signed cert per boot). `SHA-256(libp2p PeerId)` is NOT that:
 * the libp2p PeerId is a long-lived identity key, and js-libp2p's Noise
 * exposes no session-specific exporter/transcript hash (verified against
 * `@chainsafe/libp2p-noise@17`: the handshake result is only
 * `{ payload, encrypt, decrypt }`, the internal handshake hash `h` never
 * escapes, and `prologueBytes` is a handshake *input*, not an output).
 * So this transport deliberately does NOT recreate the
 * bind-this-signature-to-this-single-session property. That is an argued
 * decision, not an overlooked substitution:
 *
 * 1. Cross-session replay is already prevented by the per-session nonces
 *    (client nonce + server nonce) that are signed into every identity
 *    binding — the fingerprint was never the replay defense.
 * 2. The transport-level binding the fingerprint *pins* is provided
 *    end-to-end by Noise XX: the Noise handshake authenticates the static
 *    keypair (which IS the libp2p PeerId) into the session transcript, and a
 *    circuit-relay node only forwards bytes — it never terminates the Noise
 *    session — so no relay can substitute its own PeerId/cert for the peer's,
 *    which is the exact MITM a self-signed TLS cert pin existed to defeat.
 *    What remains bound, and what Noise guarantees over the relay, is "this
 *    session belongs to the node holding libp2p key PeerId Y"; the signed
 *    message binds p2p-hub identity X to that Y.
 * 3. Residual gap, accepted: the signed `certFingerprint` is a
 *    *transport-identity* binding, not a *transport-session* binding. A
 *    captured valid auth block is defeated only by the nonce check, never by
 *    a rotated credential. If a per-session transcript binding is ever
 *    wanted, it requires a Noise primitive that does not exist in the current
 *    pinned slice (it would need `h`/exporter exposure or a handshake-hash
 *    prologue, both unavailable) — do not fake it with another hash of the
 *    PeerId.
 *
 * No WAN discovery exists: `discover()` returns nothing and `listPeers()` is
 * empty. Peers are reached only via explicit `(peerId, multiaddr)` pairs — the
 * invite-string concept. `priority` is deliberately low so the registry never
 * auto-promotes this transport over `network-light`.
 */
export class NetworkLibp2pProvider implements NetworkProvider {
  readonly id = "network-libp2p";
  readonly priority = 1;
  readonly canTransportTasks = true;

  private readonly skills: string[];
  private readonly identity: PeerIdentity | null;
  private readonly identitySigner: ((data: Buffer) => Promise<Buffer>) | null;
  private readonly listenAddresses: string[];
  private readonly relayAddresses: string[];
  private readonly hasBrokerRateLimiting: (() => boolean) | null;
  private readonly privateKeyRaw: Uint8Array | null;
  private readonly maxPayloadBytes: number;

  private node: Awaited<ReturnType<typeof createLibp2p>> | null = null;
  private peerId: PeerId | null = null;
  private certFingerprint = "";
  private ready = false;
  private taskHandler: TaskHandler | null = null;

  constructor(options: NetworkLibp2pOptions = {}) {
    this.skills = [...(options.skills ?? [])];
    this.identity = options.identity ?? null;
    this.identitySigner = options.identitySigner ?? null;
    this.listenAddresses = [...(options.listenAddresses ?? [])];
    this.relayAddresses = [...(options.relayAddresses ?? [])];
    this.hasBrokerRateLimiting = options.hasBrokerRateLimiting ?? null;
    this.privateKeyRaw = options.privateKeyRaw ?? null;
    this.maxPayloadBytes = options.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** This provider's libp2p PeerId string, once started. */
  get transportPeerId(): string | null {
    return this.peerId?.toString() ?? null;
  }

  /**
   * Raw public-key hex of the started node's libp2p PeerId. When the node was
   * created with `privateKeyRaw` (Optie B / unification) this equals the
   * p2p-hub Ed25519 `peerId` — the transport-identity match the WAN wiring
   * guarantees. Null before start or for non-Ed25519 transport keys.
   */
  get transportPublicKeyHex(): string | null {
    const peerId = this.peerId;
    if (!peerId || peerId.type !== "Ed25519") {
      return null;
    }
    return Buffer.from(peerId.publicKey.raw).toString("hex");
  }

  /** Multiaddrs this node currently advertises (direct + relayed circuits). */
  getListeningAddresses(): string[] {
    return this.node?.getMultiaddrs().map((addr) => addr.toString()) ?? [];
  }

  async start(): Promise<void> {
    if (this.ready) {
      return;
    }

    // Deel 1 hard gate: broker-level per-peer rate limiting is a precondition
    // for a WAN-facing transport. Fail closed on absent/falsy/throwing.
    let rateLimited = false;
    try {
      rateLimited = Boolean(this.hasBrokerRateLimiting?.());
    } catch {
      rateLimited = false;
    }
    if (!rateLimited) {
      throw new Error(
        "NetworkLibp2pProvider refuses to start: the wired TaskBroker does not " +
          "report active per-peer rate limiting (broker.hasRateLimiting() returned " +
          "false). Broker-wide per-peer task budgeting (Deel 1) is a hard " +
          "precondition for this transport — fix the wiring, do not weaken it.",
      );
    }

    if (!this.identity || !this.identitySigner) {
      throw new Error(
        "NetworkLibp2pProvider requires identity and identitySigner — " +
          "transport identity is mandatory, there is no anonymous mode",
      );
    }

    const directListen =
      this.listenAddresses.length > 0
        ? [...this.listenAddresses]
        : ["/ip4/127.0.0.1/tcp/0"];
    // A relayed listen address (`<relayAddr>/p2p-circuit`) makes the
    // circuit-relay transport open a reservation with that relay at start, so
    // the node advertises a `/p2p-circuit` address and becomes reachable behind
    // NAT. This is exactly what `getMultiaddrs()`/`getListeningAddresses()`
    // then surfaces, and the address is always derived from an operator-supplied
    // relay — never discovered.
    const relayedListen = this.relayAddresses.map((relayAddr) =>
      multiaddr(relayAddr).encapsulate("/p2p-circuit").toString(),
    );

    // Optie B (identity unification): when the operator wired the p2p-hub
    // identity key, create the libp2p node from it so the transport PeerId IS
    // the p2p-hub Ed25519 identity (same public key as over mDNS). The
    // `privateKey` option is the only way libp2p v3 accepts a fixed key — a
    // `peerId` option does not exist (proven pitfall, see HANDOVER Vraag 2).
    const nodeConfig: Parameters<typeof createLibp2p>[0] = {
      addresses: { listen: [...directListen, ...relayedListen] },
      transports: [
        tcp(),
        circuitRelayTransport({ reservationCompletionTimeout: 5_000 }),
      ],
      streamMuxers: [yamux()],
      connectionEncrypters: [noise()],
      services: {
        autoNAT: autoNAT(),
        dcutr: dcutr(),
        // Required by circuit-relay-v2-transport (it consumes the identify
        // capability to observe relayed/observed addresses). This is the
        // standard libp2p peer-metadata exchange (`/ipfs/id/1.0.0`), not a
        // WAN discovery/routing mechanism, and the plugin never *uses* the
        // peer information it gathers for discovery or reachability beyond
        // what the caller explicitly dials/relays.
        identify: identify(),
      },
      ...(this.privateKeyRaw
        ? { privateKey: privateKeyFromRaw(this.privateKeyRaw) }
        : {}),
    };

    let node: Awaited<ReturnType<typeof createLibp2p>>;
    try {
      node = await createLibp2p(nodeConfig);
      await node.start();
    } catch {
      // A configured relay that is down must not crash start — the node simply
      // stays reachable only on its direct addresses. libp2p already stopped the
      // failed node before rethrowing, so recreate it with direct listen only.
      node = await createLibp2p({
        ...nodeConfig,
        addresses: { listen: directListen },
      });
      await node.start();
    }
    this.node = node;
    this.peerId = node.peerId;
    // The transport-binding fingerprint: SHA-256 of the libp2p PeerId multihash
    // bytes (the node's long-lived identity key, authenticated end-to-end by
    // Noise). Both sides derive it from the authenticated remote PeerId (the
    // dialer from the `/p2p/<peerId>` in the address, the listener from
    // `connection.remotePeer`). Transport-*identity* pin, not a per-session
    // channel binding — see the class docblock.
    this.certFingerprint = peerFingerprint(node.peerId);

    await node.handle(
      STREAM_PROTOCOL,
      (stream, connection) => {
        void this.handleStream(stream, connection);
      },
      { runOnLimitedConnection: true },
    );

    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
    const node = this.node;
    this.node = null;
    this.peerId = null;
    this.certFingerprint = "";
    if (node) {
      try {
        await node.stop();
      } catch {
        // Best-effort teardown.
      }
    }
  }

  /**
   * No WAN discovery by design (Fase 2A / invite-string model). Peers are only
   * ever reached through explicitly provided `(peerId, multiaddr)` pairs.
   */
  async discover(): Promise<NetworkPeer[]> {
    return [];
  }

  /** No peer registry: peers are addressed via explicit invites, not discovery. */
  listPeers(): NetworkPeer[] {
    return [];
  }

  async sendTask(peer: NetworkPeer, task: TaskRequest): Promise<TaskResult> {
    if (!this.node || !this.ready) {
      return {
        taskId: task.id,
        status: "error",
        error: "network-libp2p transport is not started",
      };
    }
    if (!this.identity || !this.identitySigner) {
      return {
        taskId: task.id,
        status: "error",
        error: "network-libp2p transport has no identity",
      };
    }

    let addr: Multiaddr;
    let targetPeerId: PeerId | null;
    try {
      addr = multiaddr(peer.address);
      targetPeerId = peerIdFromAddress(addr);
    } catch {
      return {
        taskId: task.id,
        status: "error",
        error: `invalid peer address: ${peer.address}`,
      };
    }
    if (!targetPeerId) {
      return {
        taskId: task.id,
        status: "error",
        error: `peer address has no /p2p/ peer id: ${peer.address}`,
      };
    }

    let stream: Stream;
    try {
      stream = await this.node.dialProtocol(addr, STREAM_PROTOCOL, {
        runOnLimitedConnection: true,
      });
    } catch (err) {
      return {
        taskId: task.id,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const session = new StreamSession(stream);
    const clientNonce = randomNonce();

    try {
      // hello — the client announces its supported protocol versions.
      if (
        !session.send(
          encodeHello([NETWORK_PROTOCOL_VERSION], this.skills, clientNonce),
        )
      ) {
        throw new Error("failed to send hello");
      }

      // hello_ack — the server proves its identity. The server's transport
      // credential (its libp2p PeerId) is known to us from the dial target,
      // so the fingerprint it signed must match the authenticated PeerId.
      const ack = await session.next(HANDSHAKE_TIMEOUT_MS);
      if (ack.kind === "timeout") {
        throw new Error("timed out during protocol handshake");
      }
      if (ack.kind === "eof") {
        throw new Error("peer closed the connection during the protocol handshake");
      }
      if (ack.kind === "error") {
        throw new Error(`protocol handshake failed: ${ack.error.message}`);
      }
      const envelope = parseEnvelope(ack.value);
      if (!envelope || envelope.type !== "hello_ack") {
        throw new Error("peer rejected the protocol handshake");
      }
      const body = envelope.body as HelloAckBody;
      if (body.version !== NETWORK_PROTOCOL_VERSION) {
        throw new Error(
          `peer negotiated unsupported protocol version ${body.version}`,
        );
      }
      const serverFingerprint = peerFingerprint(targetPeerId);
      if (
        !this.verifyIdentity(body.identity, clientNonce, body.nonce, serverFingerprint)
      ) {
        throw new Error("peer failed identity binding");
      }

      const maxPayload = body.limits?.maxPayloadBytes;
      let taskFrame: string;
      try {
        taskFrame = encodeTask(task);
      } catch {
        throw new Error("task payload is not JSON-serializable");
      }
      if (maxPayload !== undefined && taskFrame.length > maxPayload) {
        throw new Error(`payload exceeds peer's limit (${maxPayload} bytes)`);
      }

      // auth — prove our own identity before the task (mandatory, no anonymous
      // traffic), then send the task.
      const authFrame = await this.buildAuthFrame(clientNonce, body.nonce);
      session.send(authFrame);
      session.send(taskFrame);

      const result = await session.next(RESPONSE_TIMEOUT_MS);
      if (result.kind === "timeout") {
        throw new Error("timed out waiting for response");
      }
      if (result.kind === "eof") {
        throw new Error("peer closed the connection before sending a response");
      }
      if (result.kind === "error") {
        throw new Error(`response read failed: ${result.error.message}`);
      }
      const resultEnvelope = parseEnvelope(result.value);
      if (!resultEnvelope || resultEnvelope.type !== "result") {
        throw new Error("unexpected message type from peer");
      }
      return resultEnvelope.body as TaskResult;
    } catch (err) {
      return {
        taskId: task.id,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      session.abort(new Error("client task session closed"));
    }
  }

  onTask(handler: TaskHandler): void {
    this.taskHandler = handler;
  }

  /**
   * Verify an identity binding exactly as network-light does: the signature
   * must be valid under the claimed `peerId` AND the bound certificate
   * fingerprint must equal the transport credential this peer actually
   * presented (over libp2p: the authenticated remote PeerId's fingerprint).
   */
  private verifyIdentity(
    binding: IdentityBinding,
    clientNonce: string,
    serverNonce: string,
    presentedCertFingerprint: string,
  ): boolean {
    return (
      normalizeFingerprint(binding.certFingerprint) ===
        normalizeFingerprint(presentedCertFingerprint) &&
      verifyIdentityBinding(
        binding.peerId,
        clientNonce,
        serverNonce,
        binding.certFingerprint,
        binding.signature,
      )
    );
  }

  /** Build the client `auth` frame proving our identity. */
  private async buildAuthFrame(
    clientNonce: string,
    serverNonce: string,
  ): Promise<string> {
    const signature = await this.identitySigner!(
      buildIdentityBindingMessage(clientNonce, serverNonce, this.certFingerprint),
    );
    return encodeAuth({
      peerId: this.identity!.peerId,
      certFingerprint: this.certFingerprint,
      signature: signature.toString("hex"),
    });
  }

  /** Build the server `hello_ack` identity proof. */
  private async buildServerIdentity(
    clientNonce: string,
    serverNonce: string,
  ): Promise<IdentityBinding> {
    const signature = await this.identitySigner!(
      buildIdentityBindingMessage(clientNonce, serverNonce, this.certFingerprint),
    );
    return {
      peerId: this.identity!.peerId,
      certFingerprint: this.certFingerprint,
      signature: signature.toString("hex"),
    };
  }

  /**
   * Server-side wire-contract state machine over one inbound stream: refuse
   * anything that is not `hello → hello_ack → auth → task` (default-deny),
   * dispatch the task only after a verified identity binding, and answer with
   * a `result`. The authenticated p2p-hub peerId is handed to the task handler
   * (which routes it to `TaskBroker.handleRemote`) — never anything
   * caller-supplied.
   */
  private async handleStream(
    stream: Stream,
    connection: Connection,
  ): Promise<void> {
    const session = new StreamSession(stream);
    try {
      const hello = await session.next(HANDSHAKE_TIMEOUT_MS);
      if (hello.kind !== "value") {
        return;
      }
      const helloEnvelope = parseEnvelope(hello.value);
      if (!helloEnvelope || helloEnvelope.type !== "hello") {
        return;
      }
      const helloBody = helloEnvelope.body as HelloBody;
      if (supportedVersion(helloBody.versions) === null) {
        return;
      }

      const serverNonce = randomNonce();
      const identity = await this.buildServerIdentity(
        helloBody.nonce,
        serverNonce,
      );
      if (
        !session.send(
          encodeHelloAck(
            NETWORK_PROTOCOL_VERSION,
            this.skills,
            { maxPayloadBytes: this.maxPayloadBytes },
            serverNonce,
            identity,
          ),
        )
      ) {
        return;
      }

      const auth = await session.next(HANDSHAKE_TIMEOUT_MS);
      if (auth.kind !== "value") {
        return;
      }
      const authEnvelope = parseEnvelope(auth.value);
      if (!authEnvelope || authEnvelope.type !== "auth") {
        return;
      }
      const binding = authEnvelope.body as IdentityBinding;
      // The client's transport credential on this connection: the fingerprint
      // of its authenticated libp2p PeerId (analog of the TLS cert it would
      // present to network-light).
      const presentedFingerprint = peerFingerprint(connection.remotePeer);
      if (
        !this.verifyIdentity(
          binding,
          helloBody.nonce,
          serverNonce,
          presentedFingerprint,
        )
      ) {
        return;
      }
      const authenticatedPeerId = binding.peerId;

      const task = await session.next(HANDSHAKE_TIMEOUT_MS);
      if (task.kind !== "value") {
        return;
      }
      const taskEnvelope = parseEnvelope(task.value);
      if (!taskEnvelope || taskEnvelope.type !== "task") {
        return;
      }
      const taskBody = taskEnvelope.body as TaskBody;
      const handler = this.taskHandler;
      if (!handler) {
        session.send(
          encodeResult({
            taskId: taskBody.id,
            status: "error",
            error: "no task handler registered",
          }),
        );
        return;
      }
      const result = await handler({
        id: taskBody.id,
        skill: taskBody.skill,
        payload: taskBody.payload,
        peerId: authenticatedPeerId,
      });
      session.send(encodeResult(result));
    } catch {
      // Default-deny: any malformed/unexpected input closes the stream.
    } finally {
      session.abort(new Error("server task session closed"));
    }
  }
}

// --- framing (transport plumbing, mirrors network-light) ---------------------

function encodeFrame(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

interface DecodedFrame {
  value: unknown;
  rest: Buffer;
}

/**
 * Decode a complete frame, or return `null` when more bytes are needed. Throws
 * on any invalid frame (oversized or malformed) so the caller can close the
 * connection — malformed input defaults to deny, never to ignore. Same guards
 * as network-light's `tryDecodeFrame` (boundary-guard depth + payload caps).
 */
function tryDecodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 4) {
    return null;
  }
  const length = buffer.readUInt32BE(0);
  if (buffer.length < 4 + length) {
    if (length > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `frame exceeds maximum allowed size (${length} > ${MAX_PAYLOAD_BYTES})`,
      );
    }
    return null;
  }
  const body = buffer.subarray(4, 4 + length);
  const rest = buffer.subarray(4 + length);
  validatePayloadSize(body, MAX_PAYLOAD_BYTES);
  const raw = body.toString("utf8");
  validateJsonNestingDepth(raw);
  const value = JSON.parse(raw) as unknown;
  validateObjectDepth(value);
  return { value, rest };
}

/**
 * The transport-binding fingerprint of a libp2p peer: SHA-256 hex of its
 * PeerId multihash bytes. It is signed into the wire-contract identity binding
 * to pin the p2p-hub identity claim to a specific transport peer.
 *
 * NOTE this is a *transport-identity* binding, deliberately NOT a
 * *transport-session* binding: the libp2p PeerId is long-lived and Noise
 * exposes no per-session transcript value to sign. Replay across sessions is
 * prevented by the per-session nonces, and the "this session really belongs
 * to PeerId Y" property is provided end-to-end by the Noise XX handshake
 * itself (the relay only forwards bytes). See the class docblock's "Channel
 * binding" section — do not re-describe this value as a session channel
 * binding or "the TLS analog"; it is a transport-identity pin.
 */
function peerFingerprint(peerId: PeerId): string {
  return crypto.createHash("sha256").update(peerId.toMultihash().bytes).digest("hex");
}

/** Extract the target peer id from a multiaddr (the last `/p2p/` component). */
function peerIdFromAddress(addr: Multiaddr): PeerId | null {
  const components = addr.getComponents();
  for (let i = components.length - 1; i >= 0; i--) {
    const value = components[i].value;
    if (components[i].name === "p2p" && value !== undefined) {
      try {
        return peerIdFromString(value);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function toBuffer(chunk: Uint8Array | unknown): Buffer {
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  // Uint8ArrayList: `.subarray()` yields a contiguous Uint8Array.
  const view = (chunk as { subarray(): Uint8Array }).subarray();
  return Buffer.from(view);
}

type NextResult =
  | { kind: "value"; value: unknown }
  | { kind: "timeout" }
  | { kind: "eof" }
  | { kind: "error"; error: Error };

/**
 * Framed, queue-based reader/writer over one libp2p stream. A background
 * consumer drains the async iterable into a frame queue so `next()` can apply
 * a timeout without blocking on the stream's iterator. Malformed frames
 * surface as an `error` result (default-deny), never silent continuation.
 */
class StreamSession {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly frames: unknown[] = [];
  private readonly waiters: Array<{
    resolve: (result: NextResult) => void;
  }> = [];
  private failed: Error | null = null;
  private eof = false;

  constructor(private readonly stream: Stream) {
    void this.consume();
  }

  private async consume(): Promise<void> {
    try {
      for await (const chunk of this.stream) {
        this.buffer = Buffer.concat([this.buffer, toBuffer(chunk)]);
        for (;;) {
          const frame = tryDecodeFrame(this.buffer);
          if (frame === null) {
            break;
          }
          this.buffer = frame.rest;
          this.frames.push(frame.value);
          this.drain();
        }
      }
    } catch (err) {
      this.failed = err instanceof Error ? err : new Error(String(err));
    }
    this.eof = true;
    this.drain();
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.hasOutput()) {
      const waiter = this.waiters.shift()!;
      if (this.frames.length > 0) {
        waiter.resolve({ kind: "value", value: this.frames.shift()! });
      } else if (this.failed !== null) {
        waiter.resolve({ kind: "error", error: this.failed });
      } else {
        waiter.resolve({ kind: "eof" });
      }
    }
  }

  private hasOutput(): boolean {
    return this.frames.length > 0 || this.failed !== null || this.eof;
  }

  /** Wait for the next decoded frame value, bounded by `timeoutMs`. */
  next(timeoutMs: number): Promise<NextResult> {
    if (this.frames.length > 0) {
      return Promise.resolve({ kind: "value", value: this.frames.shift()! });
    }
    if (this.failed !== null) {
      return Promise.resolve({ kind: "error", error: this.failed });
    }
    if (this.eof) {
      return Promise.resolve({ kind: "eof" });
    }
    return new Promise<NextResult>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        resolve({ kind: "timeout" });
      }, timeoutMs);
      const waiter = {
        resolve: (result: NextResult) => {
          clearTimeout(timer);
          resolve(result);
        },
      };
      this.waiters.push(waiter);
    });
  }

  /** Write one framed message. Returns false when the write failed. */
  send(text: string): boolean {
    try {
      return this.stream.send(encodeFrame(text));
    } catch {
      return false;
    }
  }

  /** Close both ends and stop the consumer. */
  abort(err: Error): void {
    try {
      this.stream.abort(err);
    } catch {
      // Already closed.
    }
  }
}
