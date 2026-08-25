import * as crypto from "node:crypto";
import type { PluginContext, SkillInvocationContext } from "@p2p-hub/core";
import {
  checkPeerAccess,
  PEER_ID_RE,
  PeerStreamViolationError,
  TelemetryGate,
} from "@p2p-hub/core";
import type {
  PeerAccessContext,
  PeerAccessOptions,
  StreamCheckResult,
  StreamDenyReason,
  StreamRateConfig,
} from "@p2p-hub/core";
import type { MediaKind, TaskResult } from "@p2p-hub/sdk";
import {
  MEDIA_SIGNAL_SCOPE,
  MAX_CALL_ID_LENGTH,
  MAX_CALLS,
  MAX_CANDIDATES_PER_CALL,
  encodeSignalMessage,
  guardSignalPayload,
  parseSignalMessage,
} from "./signal-contract";
import type { IceCandidate, SignalAnswer } from "./signal-contract";

/**
 * P2P Media — WebRTC signaling capability (v1).
 *
 * This plugin handles ONLY the SDP/ICE exchange between two peers. The actual
 * audio/video bytes run through WebRTC's own `RTCPeerConnection` outside the
 * TaskBroker once the connection is up; there is no video widget or UI here
 * (that is a later etappe).
 *
 * Authorization is the same fail-closed gate for BOTH directions, so an
 * inbound offer never gets a free head start over a locally initiated call:
 *   1. `checkPeerAccess` (verified contact or a valid `media-signal` access
 *      pass) — the same policy the broker enforces before dispatch, kept
 *      in-handler as defence-in-depth for the in-process API.
 *   2. A Tier-2 native media confirmation. The plugin does not hold the
 *      `TrustConfirmation` itself: it emits a `media:accessRequested` hook
 *      event and waits for the host (core-server) to resolve it via
 *      {@link MediaPlugin.resolveMediaAccess} — the exact peersite
 *      `resolveAccessRequest` pattern. A confirmation is NEVER skipped, not
 *      even for an already-`verified` contact: contact trust is not consent
 *      for camera/mic access.
 *
 * ICE candidates flow through the broker's telemetry rate limiter
 * (`capabilityType: "telemetry"`) rather than the request/response action
 * limiter — high-frequency, lightweight traffic gets a per-peer frequency cap.
 *
 * Stap 4 adds the *session* (World/Media capability): a local-operator
 * `requestSession` ceremony that runs the same two gates once, then registers a
 * per-session {@link TelemetryGate} channel. Once a session is open its
 * telemetry rides that channel (per-peer, per-channel sliding-window budget —
 * drop, never queue) instead of the per-frame gate ceremony. The session
 * lifecycle skills are `httpBridgeOnly` (a local operator privilege, never
 * reachable over the network).
 */

export interface InitiateCallInput {
  /** Persistent peerId (64-hex Ed25519 public key) of the callee. */
  peerId: string;
  /** Device class the caller is asking about. Defaults to "camera". */
  kind?: MediaKind;
}

export type InitiateCallResult =
  | { ok: true; callId: string; sdp: string }
  | { ok: false; error: string; reason?: string };

export interface SendCandidateInput {
  callId: string;
  candidate: IceCandidate;
}

export interface HangupInput {
  peerId: string;
}

export interface MediaStatus {
  activeCalls: number;
  pendingAccessRequests: number;
  peerId: string;
}

export interface MediaPlugin {
  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;
  /** Resolve a pending `media:accessRequested` request (host → plugin). */
  resolveMediaAccess(requestId: string, granted: boolean): Promise<boolean>;
  sendIceCandidate(input: SendCandidateInput): Promise<TaskResult>;
  hangup(input: HangupInput): Promise<{ ok: true; closed: number }>;
  status(): Promise<MediaStatus>;
  /** Open a media session with `peerId` (checkPeerAccess + MediaGate). */
  requestSession(input: RequestSessionInput): Promise<RequestSessionResult>;
  /** Tear down a session and its telemetry stream. */
  closeSession(sessionId: string): Promise<CloseSessionResult>;
  /** Report a session's state and telemetry-stream accounting. */
  getStreamStatus(sessionId: string): Promise<GetStreamStatusResult>;
  /** Route one frame through a session's TelemetryGate channel (drop, never queue). */
  consumeStreamFrame(sessionId: string, byteSize: number): Promise<ConsumeFrameResult>;
}

/**
 * Stap 4 — the media *session* (World/Media capability). A session is the
 * operator-facing authorization ceremony for a media relationship with a peer:
 *
 *   1. `checkPeerAccess` — the same fail-closed gate signaling uses
 *      (verified contact or a `media-signal` access pass).
 *   2. The Tier-2 native media confirmation (MediaGate) — never skipped.
 *
 * Once open, a session is the *fast-path* for the relationship's telemetry:
 * every stream frame is consumed through the session's own {@link TelemetryGate}
 * channel (per-peer, per-channel sliding-window budget) instead of re-running
 * the gate ceremony per frame. Overflow drops — never queues, never
 * error-spams, never closes the session; a sustained >2x burst pinches the
 * channel. A session is deliberately a separate concept from a call: it is the
 * transport-level frequency gate (the design doc's "fast-path") a live stream
 * rides, while offer/answer/ICE keep their broker-level gates.
 */
export interface RequestSessionInput {
  /** Persistent peerId (64-hex Ed25519 public key) of the session's peer. */
  peerId: string;
  /** Device class the session asks about. Defaults to "camera". */
  kind?: MediaKind;
  /**
   * Optional bounded telemetry-budget override for the session's stream
   * channel. Every value is clamped to the plugin's hard bounds, so a caller
   * can tune the frequency cap down (e.g. for tests or a slow link) but never
   * disable it — a missing/invalid override falls back to the fail-closed
   * default budget.
   */
  telemetry?: Partial<
    Pick<StreamRateConfig, "maxMessagesPerSecond" | "maxBytesPerSecond">
  >;
}

export type RequestSessionResult =
  | {
      ok: true;
      sessionId: string;
      peerId: string;
      kind: MediaKind;
      channelId: string;
    }
  | { ok: false; error: string; reason?: string };

export type CloseSessionResult =
  | { ok: true; closed: number }
  | { ok: false; error: string };

export interface SessionStreamStatus {
  ok: true;
  sessionId: string;
  peerId: string;
  kind: MediaKind;
  status: "active";
  createdAt: number;
  channelId: string;
  config: StreamRateConfig;
  /** Frames admitted through the session's TelemetryGate channel. */
  frames: number;
  /** Frames dropped by the gate (message/byte cap, or a pinched channel). */
  dropped: number;
  /** Times the gate raised a `PeerStreamViolationError` on this channel. */
  violations: number;
}

export type GetStreamStatusResult =
  | SessionStreamStatus
  | { ok: false; error: string };

export type ConsumeFrameResult =
  | { allowed: true }
  | { allowed: false; reason: StreamDenyReason | "no-session" | "invalid" };

/** Hook event emitted whenever a media-access confirmation is required. */
const ACCESS_REQUESTED_EVENT = "media:accessRequested";
/** How long a pending access request stays resolvable before it fails closed. */
const ACCESS_REQUEST_TTL_MS = 60 * 1000;
/** How long the initiator waits for the callee's answer before giving up. */
const ANSWER_TIMEOUT_MS = 30 * 1000;

/** Upper bound on the number of sessions tracked in one plugin instance. */
const MAX_SESSIONS = 16;
/** Channel prefix for a session's telemetry stream. */
const MEDIA_SESSION_CHANNEL_PREFIX = "media-session";
/** Fail-closed default stream budget for a session's telemetry channel. */
const SESSION_STREAM_DEFAULTS: StreamRateConfig = {
  windowMs: 1_000,
  maxMessagesPerSecond: 60,
  maxBytesPerSecond: 64 * 1024,
};
/** Hard bounds on the per-session telemetry budget (clamped, never disabled). */
const MIN_MESSAGES_PER_SECOND = 1;
const MAX_MESSAGES_PER_SECOND = 120;
const MIN_BYTES_PER_SECOND = 1024;
const MAX_BYTES_PER_SECOND = 1024 * 1024;

/** The broker-level remote gate mirror for the in-handler checks. */
const SIGNAL_PEER_ACCESS_OPTIONS: PeerAccessOptions = {
  modes: ["verified-contact", "access-pass"],
  accessPassScope: MEDIA_SIGNAL_SCOPE,
};

interface PendingAccessRequest {
  requestId: string;
  peerId: string;
  kind: MediaKind;
  direction: "outbound" | "inbound";
  expiresInMs: number;
  /** Resolve the awaiting caller. Always called exactly once. */
  resolve: (granted: boolean) => void;
  timer: { dispose(): void };
}

interface CallState {
  callId: string;
  peerId: string;
  role: "initiator" | "callee";
  kind: MediaKind;
  status: "signaling" | "established" | "ended";
  createdAt: number;
  localSdp?: string;
  remoteSdp?: string;
  remoteCandidates: IceCandidate[];
  /** Initiator-only: the waiter for the callee's separate answer task. */
  pendingAnswer?: {
    resolve: (answer: SignalAnswer | null) => void;
    timer: { dispose(): void };
  };
}

interface SessionState {
  sessionId: string;
  peerId: string;
  kind: MediaKind;
  channelId: string;
  status: "active";
  createdAt: number;
  config: StreamRateConfig;
  frames: number;
  dropped: number;
  violations: number;
}

/**
 * A structurally valid but inert session description. This slice is signaling
 * only: the real SDP would be produced by the shell's `RTCPeerConnection`. The
 * placeholder keeps the wire format and call-state machine honest so a future
 * transport can swap in real SDP without changing the signaling contract.
 */
function buildPlaceholderSdp(
  callId: string,
  role: "initiator" | "callee",
  kind: MediaKind,
): string {
  const mediaLine = kind === "camera" ? "m=video 9 UDP/TLS/RTP/SAVPF 96" : "m=audio 9 UDP/TLS/RTP/SAVPF 0";
  return [
    "v=0",
    `o=p2p-hub-media ${role} ${callId} IN IP4 0.0.0.0`,
    "s=p2p-hub media signaling placeholder (real SDP comes from the shell's RTCPeerConnection)",
    "c=IN IP4 0.0.0.0",
    "t=0 0",
    mediaLine,
  ].join("\n");
}

export default function activate(ctx: PluginContext): MediaPlugin {
  const calls = new Map<string, CallState>();
  const pendingRequests = new Map<string, PendingAccessRequest>();
  const sessions = new Map<string, SessionState>();
  // Stap 4: the transport-level telemetry frequency gate every session's
  // stream rides. Per-plugin (each plugin instance enforces its own budget),
  // per-peer + per-channel keyed, fail-closed by default.
  const telemetryGate = new TelemetryGate();

  const peerAccessContext: PeerAccessContext = {
    contacts: ctx.trust
      ? {
          isVerifiedContact: async (peerId: string) =>
            (await ctx.trust!.getContact(peerId))?.trustState === "verified",
        }
      : undefined,
    accessPasses: {
      // Backed by the same core AccessPassManager the broker's gate consults.
      hasValidPass: (peerId: string, scope: string) => ctx.access.hasPass(peerId, scope),
    },
  };

  function cleanupCall(callId: string): void {
    const call = calls.get(callId);
    if (call?.pendingAnswer) {
      call.pendingAnswer.timer.dispose();
      call.pendingAnswer.resolve(null);
    }
    calls.delete(callId);
  }

  /** Ask the host for a Tier-2 media confirmation. Never resolves `undefined`. */
  function askForMediaAccess(
    peerId: string,
    kind: MediaKind,
    direction: "outbound" | "inbound",
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const requestId = crypto.randomUUID();
      const expiresInMs = ACCESS_REQUEST_TTL_MS;
      const timer = ctx.timers.setTimeout(() => {
        // Denied/expired requests are cleaned up, never left hanging.
        pendingRequests.delete(requestId);
        resolve(false);
      }, expiresInMs);
      const entry: PendingAccessRequest = {
        requestId,
        peerId,
        kind,
        direction,
        expiresInMs,
        resolve: (granted) => {
          pendingRequests.delete(requestId);
          timer.dispose();
          resolve(granted);
        },
        timer,
      };
      pendingRequests.set(requestId, entry);
      // The host (core-server) resolves this via `resolveMediaAccess`. A
      // listener failure is logged by the hook registry and the request fails
      // closed on its timeout.
      void ctx.hooks.emit(ACCESS_REQUESTED_EVENT, {
        requestId,
        peerId,
        kind,
        direction,
        expiresInMs,
      });
    });
  }

  async function resolveMediaAccess(
    requestId: string,
    granted: boolean,
  ): Promise<boolean> {
    if (typeof requestId !== "string" || requestId.length === 0) {
      return false;
    }
    const entry = pendingRequests.get(requestId);
    if (!entry) {
      return false;
    }
    entry.resolve(Boolean(granted));
    return true;
  }

  async function initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const peerId = typeof input?.peerId === "string" ? input.peerId : "";
    const kind: MediaKind = input?.kind === "microphone" ? "microphone" : "camera";
    if (!PEER_ID_RE.test(peerId)) {
      return { ok: false, error: "unauthorized" };
    }
    if (calls.size >= MAX_CALLS) {
      return { ok: false, error: "too many calls" };
    }
    // Gate 1: peer access (verified contact or a valid signaling access pass).
    const decision = await checkPeerAccess(
      peerId,
      SIGNAL_PEER_ACCESS_OPTIONS,
      peerAccessContext,
    );
    if (!decision.granted) {
      return { ok: false, error: "unauthorized", reason: decision.reason };
    }
    // Gate 2: Tier-2 native media confirmation — never skipped.
    const granted = await askForMediaAccess(peerId, kind, "outbound");
    if (!granted) {
      return { ok: false, error: "media-access-denied" };
    }
    if (!ctx.network) {
      return { ok: false, error: "networking unavailable" };
    }
    const callId = crypto.randomUUID().slice(0, MAX_CALL_ID_LENGTH);
    const sdp = buildPlaceholderSdp(callId, "initiator", kind);

    // Register the pending-answer waiter BEFORE sending the offer so a fast
    // callee answer can never be missed.
    let resolveAnswer: (answer: SignalAnswer | null) => void = () => {};
    const answerPromise = new Promise<SignalAnswer | null>((res) => {
      resolveAnswer = res;
    });
    const answerTimer = ctx.timers.setTimeout(() => {
      resolveAnswer(null);
    }, ANSWER_TIMEOUT_MS);
    const call: CallState = {
      callId,
      peerId,
      role: "initiator",
      kind,
      status: "signaling",
      createdAt: Date.now(),
      localSdp: sdp,
      remoteCandidates: [],
      pendingAnswer: { resolve: resolveAnswer, timer: answerTimer },
    };
    calls.set(callId, call);

    const offerResult = await ctx.network.sendTask(peerId, {
      id: crypto.randomUUID(),
      skill: "media.offer",
      payload: encodeSignalMessage({
        kind: "offer",
        callId,
        mediaKind: kind,
        sdp,
      }),
    });
    if (offerResult.status !== "ok") {
      cleanupCall(callId);
      return { ok: false, error: offerResult.error ?? "offer failed" };
    }
    const ack = parseOfferAck(offerResult.result);
    if (!ack) {
      cleanupCall(callId);
      return { ok: false, error: "malformed offer ack" };
    }
    if (!ack.accepted) {
      cleanupCall(callId);
      return { ok: false, error: ack.error ?? "call rejected" };
    }
    const answer = await answerPromise;
    if (!answer) {
      cleanupCall(callId);
      return { ok: false, error: "no answer (timed out)" };
    }
    call.status = "established";
    call.remoteSdp = answer.sdp;
    return { ok: true, callId, sdp };
  }

  async function handleOffer(
    payload: unknown,
    invocation: SkillInvocationContext | undefined,
  ): Promise<unknown> {
    guardSignalPayload(payload);
    const msg = parseSignalMessage(payload, "offer");
    if (!msg) {
      return offerAck(false, "malformed");
    }
    const peerId = invocation?.peerId;
    if (!peerId || !PEER_ID_RE.test(peerId)) {
      return offerAck(false, "unauthorized");
    }
    // Same two checks as the initiator side — an inbound offer never gets a
    // free head start over a locally initiated call.
    const decision = await checkPeerAccess(
      peerId,
      SIGNAL_PEER_ACCESS_OPTIONS,
      peerAccessContext,
    );
    if (!decision.granted) {
      return offerAck(false, "unauthorized");
    }
    if (calls.size >= MAX_CALLS) {
      return offerAck(false, "too many calls");
    }
    for (const call of calls.values()) {
      if (call.peerId === peerId) {
        return offerAck(false, "already in call");
      }
    }
    if (calls.has(msg.callId)) {
      return offerAck(false, "duplicate call");
    }
    const granted = await askForMediaAccess(peerId, msg.mediaKind, "inbound");
    if (!granted) {
      return offerAck(false, "media-access-denied");
    }
    if (!ctx.network) {
      return offerAck(false, "networking unavailable");
    }
    const sdp = buildPlaceholderSdp(msg.callId, "callee", msg.mediaKind);
    const call: CallState = {
      callId: msg.callId,
      peerId,
      role: "callee",
      kind: msg.mediaKind,
      status: "signaling",
      createdAt: Date.now(),
      localSdp: sdp,
      remoteSdp: msg.sdp,
      remoteCandidates: [],
    };
    calls.set(msg.callId, call);
    // The answer is a separate outbound task so `media.answer` is a real,
    // independently gate-able surface — and the initiator's offer task returns
    // as soon as the callee has accepted, not when the answer is ready.
    const answerResult = await ctx.network.sendTask(peerId, {
      id: crypto.randomUUID(),
      skill: "media.answer",
      payload: encodeSignalMessage({ kind: "answer", callId: msg.callId, sdp }),
    });
    if (answerResult.status !== "ok") {
      cleanupCall(msg.callId);
      return offerAck(false, "answer failed");
    }
    call.status = "established";
    return offerAck(true, undefined, msg.callId);
  }

  async function handleAnswer(
    payload: unknown,
    invocation: SkillInvocationContext | undefined,
  ): Promise<unknown> {
    guardSignalPayload(payload);
    const msg = parseSignalMessage(payload, "answer");
    if (!msg) {
      return { ok: false, error: "malformed" };
    }
    const peerId = invocation?.peerId;
    if (!peerId || !PEER_ID_RE.test(peerId)) {
      return { ok: false, error: "unauthorized" };
    }
    const decision = await checkPeerAccess(
      peerId,
      SIGNAL_PEER_ACCESS_OPTIONS,
      peerAccessContext,
    );
    if (!decision.granted) {
      return { ok: false, error: "unauthorized" };
    }
    const call = calls.get(msg.callId);
    if (!call || call.role !== "initiator" || call.peerId !== peerId) {
      return { ok: false, error: "no such call" };
    }
    call.remoteSdp = msg.sdp;
    call.status = "established";
    if (call.pendingAnswer) {
      call.pendingAnswer.timer.dispose();
      call.pendingAnswer.resolve(msg);
      call.pendingAnswer = undefined;
    }
    return { ok: true, callId: msg.callId };
  }

  async function handleCandidate(
    payload: unknown,
    invocation: SkillInvocationContext | undefined,
  ): Promise<unknown> {
    guardSignalPayload(payload);
    const msg = parseSignalMessage(payload, "candidate");
    if (!msg) {
      return { ok: false, error: "malformed" };
    }
    const peerId = invocation?.peerId;
    if (!peerId || !PEER_ID_RE.test(peerId)) {
      return { ok: false, error: "unauthorized" };
    }
    // Telemetry fast-path: an open session is the standing authorization for
    // its own stream — the frame rides the session's frequency cap instead of
    // the per-frame gate ceremony. Without a session the full gate applies.
    const session = findSessionForPeer(peerId);
    if (session) {
      const verdict = await consumeStreamFrame(
        session.sessionId,
        Buffer.byteLength(JSON.stringify(encodeSignalMessage(msg)), "utf8"),
      );
      if (!verdict.allowed) {
        return { ok: false, error: "telemetry-drop", reason: verdict.reason };
      }
    } else {
      const decision = await checkPeerAccess(
        peerId,
        SIGNAL_PEER_ACCESS_OPTIONS,
        peerAccessContext,
      );
      if (!decision.granted) {
        return { ok: false, error: "unauthorized" };
      }
    }
    const call = calls.get(msg.callId);
    if (!call || call.peerId !== peerId) {
      return { ok: false, error: "no such call" };
    }
    call.remoteCandidates.push(msg.candidate);
    if (call.remoteCandidates.length > MAX_CANDIDATES_PER_CALL) {
      call.remoteCandidates.shift();
    }
    return { ok: true, callId: msg.callId };
  }

  async function sendIceCandidate(input: SendCandidateInput): Promise<TaskResult> {
    const callId = typeof input?.callId === "string" ? input.callId : "";
    const candidate: IceCandidate | undefined =
      input?.candidate && typeof input.candidate === "object"
        ? (input.candidate as IceCandidate)
        : undefined;
    if (callId.length === 0 || candidate === undefined) {
      return { taskId: "", status: "error", error: "invalid candidate" };
    }
    const call = calls.get(callId);
    if (!call || call.status === "ended") {
      return { taskId: "", status: "error", error: "no such call" };
    }
    if (!ctx.network) {
      return { taskId: "", status: "error", error: "networking unavailable" };
    }
    const wire = encodeSignalMessage({ kind: "candidate", callId, candidate });
    // Telemetry fast-path: with a session open for the call's peer, the
    // candidate rides the session's frequency cap (drop, never queue). No
    // session → the frame goes out broker-gated as before.
    const session = findSessionForPeer(call.peerId);
    if (session) {
      const verdict = await consumeStreamFrame(
        session.sessionId,
        Buffer.byteLength(JSON.stringify(wire), "utf8"),
      );
      if (!verdict.allowed) {
        return {
          taskId: "",
          status: "error",
          code: "telemetry-drop",
          error: `frame dropped by the session telemetry gate: ${verdict.reason}`,
        };
      }
    }
    return ctx.network.sendTask(call.peerId, {
      id: crypto.randomUUID(),
      skill: "media.iceCandidate",
      payload: wire,
    });
  }

  async function hangup(input: HangupInput): Promise<{ ok: true; closed: number }> {
    const peerId = typeof input?.peerId === "string" ? input.peerId : "";
    let closed = 0;
    for (const callId of [...calls.keys()]) {
      const call = calls.get(callId);
      if (call && call.peerId === peerId) {
        cleanupCall(callId);
        closed += 1;
      }
    }
    return { ok: true, closed };
  }

  async function status(): Promise<MediaStatus> {
    return {
      activeCalls: calls.size,
      pendingAccessRequests: pendingRequests.size,
      peerId: await ctx.identity.peerId(),
    };
  }

  // -------------------------------------------------------------------------
  // Stap 4 — media sessions: checkPeerAccess → MediaGate → TelemetryGate
  // -------------------------------------------------------------------------

  /** Clamp a caller-supplied budget field to the plugin's hard bounds. */
  function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, value));
  }

  function buildSessionStreamConfig(
    override: RequestSessionInput["telemetry"],
  ): StreamRateConfig {
    return {
      windowMs: SESSION_STREAM_DEFAULTS.windowMs,
      maxMessagesPerSecond: clampInt(
        override?.maxMessagesPerSecond,
        SESSION_STREAM_DEFAULTS.maxMessagesPerSecond,
        MIN_MESSAGES_PER_SECOND,
        MAX_MESSAGES_PER_SECOND,
      ),
      maxBytesPerSecond: clampInt(
        override?.maxBytesPerSecond,
        SESSION_STREAM_DEFAULTS.maxBytesPerSecond,
        MIN_BYTES_PER_SECOND,
        MAX_BYTES_PER_SECOND,
      ),
    };
  }

  function findSessionForPeer(peerId: string): SessionState | undefined {
    for (const session of sessions.values()) {
      if (session.peerId === peerId) {
        return session;
      }
    }
    return undefined;
  }

  async function requestSession(
    input: RequestSessionInput,
  ): Promise<RequestSessionResult> {
    const peerId = typeof input?.peerId === "string" ? input.peerId : "";
    const kind: MediaKind = input?.kind === "microphone" ? "microphone" : "camera";
    if (!PEER_ID_RE.test(peerId)) {
      return { ok: false, error: "unauthorized" };
    }
    if (findSessionForPeer(peerId)) {
      return { ok: false, error: "session already open" };
    }
    if (sessions.size >= MAX_SESSIONS) {
      return { ok: false, error: "too many sessions" };
    }
    // Gate 1: peer access — the same fail-closed gate as signaling, so a
    // session with an untrusted peer is impossible from the start.
    const decision = await checkPeerAccess(
      peerId,
      SIGNAL_PEER_ACCESS_OPTIONS,
      peerAccessContext,
    );
    if (!decision.granted) {
      return { ok: false, error: "unauthorized", reason: decision.reason };
    }
    // Gate 2 (MediaGate): the Tier-2 native media confirmation — never skipped,
    // contact trust is not consent for camera/mic access.
    const granted = await askForMediaAccess(peerId, kind, "outbound");
    if (!granted) {
      return { ok: false, error: "media-access-denied" };
    }
    const config = buildSessionStreamConfig(input?.telemetry);
    const sessionId = crypto.randomUUID().slice(0, MAX_CALL_ID_LENGTH);
    const channelId = `${MEDIA_SESSION_CHANNEL_PREFIX}:${sessionId}`;
    telemetryGate.registerStream(peerId, channelId, config);
    sessions.set(sessionId, {
      sessionId,
      peerId,
      kind,
      channelId,
      status: "active",
      createdAt: Date.now(),
      config,
      frames: 0,
      dropped: 0,
      violations: 0,
    });
    return { ok: true, sessionId, peerId, kind, channelId };
  }

  async function closeSession(sessionId: string): Promise<CloseSessionResult> {
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!session) {
      return { ok: false, error: "no such session" };
    }
    telemetryGate.closeStream(session.peerId, session.channelId);
    sessions.delete(sessionId);
    return { ok: true, closed: 1 };
  }

  async function getStreamStatus(
    sessionId: string,
  ): Promise<GetStreamStatusResult> {
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!session) {
      return { ok: false, error: "no such session" };
    }
    return {
      ok: true,
      sessionId: session.sessionId,
      peerId: session.peerId,
      kind: session.kind,
      status: session.status,
      createdAt: session.createdAt,
      channelId: session.channelId,
      config: { ...session.config },
      frames: session.frames,
      dropped: session.dropped,
      violations: session.violations,
    };
  }

  /**
   * The telemetry fast-path: consume one frame through a session's
   * {@link TelemetryGate} channel. The gate drops on overflow (never queues,
   * never error-spams, never closes the session); a sustained >2x burst raises
   * {@link PeerStreamViolationError}, pinches the channel, and every later
   * frame is dropped as a violation. Never throws.
   */
  async function consumeStreamFrame(
    sessionId: string,
    byteSize: number,
  ): Promise<ConsumeFrameResult> {
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!session) {
      return { allowed: false, reason: "no-session" };
    }
    if (typeof byteSize !== "number" || !Number.isInteger(byteSize) || byteSize < 0) {
      return { allowed: false, reason: "invalid" };
    }
    let verdict: StreamCheckResult;
    try {
      verdict = telemetryGate.checkAndConsume(
        session.peerId,
        session.channelId,
        byteSize,
      );
    } catch (err) {
      if (err instanceof PeerStreamViolationError) {
        session.violations += 1;
        session.dropped += 1;
        return { allowed: false, reason: "stream-violation" };
      }
      return { allowed: false, reason: "invalid" };
    }
    if (verdict.allowed) {
      session.frames += 1;
      return { allowed: true };
    }
    session.dropped += 1;
    return { allowed: false, reason: verdict.reason };
  }

  function asSessionId(payload: unknown): string {
    if (typeof payload !== "object" || payload === null) {
      return "";
    }
    const value = (payload as Record<string, unknown>).sessionId;
    return typeof value === "string" ? value : "";
  }

  ctx.skills.register(
    "offer",
    async (payload, invocation) => handleOffer(payload, invocation),
    {
      localOnly: false,
      remote: { gate: ["verified-contact", "access-pass"], scope: MEDIA_SIGNAL_SCOPE },
      capabilityType: "action",
    },
  );
  ctx.skills.register(
    "answer",
    async (payload, invocation) => handleAnswer(payload, invocation),
    {
      localOnly: false,
      remote: { gate: ["verified-contact", "access-pass"], scope: MEDIA_SIGNAL_SCOPE },
      capabilityType: "action",
    },
  );
  ctx.skills.register(
    "iceCandidate",
    async (payload, invocation) => handleCandidate(payload, invocation),
    {
      localOnly: false,
      remote: { gate: ["verified-contact", "access-pass"], scope: MEDIA_SIGNAL_SCOPE },
      capabilityType: "telemetry",
    },
  );
  // Stap 4: the session lifecycle is a local-operator privilege (Hermes / the
  // desktop shell over the local HTTP bridge with the per-boot token) —
  // `httpBridgeOnly` forces `localOnly: true` and drops any remote policy, so
  // a LAN/WAN peer can structurally never open or tear down a session.
  ctx.skills.register(
    "requestSession",
    (payload) => requestSession(payload as RequestSessionInput),
    { httpBridgeOnly: true },
  );
  ctx.skills.register(
    "closeSession",
    (payload) => closeSession(asSessionId(payload)),
    { httpBridgeOnly: true },
  );
  ctx.skills.register(
    "getStreamStatus",
    (payload) => getStreamStatus(asSessionId(payload)),
    { httpBridgeOnly: true },
  );

  return {
    initiateCall,
    resolveMediaAccess,
    sendIceCandidate,
    hangup,
    status,
    requestSession,
    closeSession,
    getStreamStatus,
    consumeStreamFrame,
  };
}

interface OfferAck {
  accepted: boolean;
  error?: string;
  callId?: string;
}

function offerAck(
  accepted: boolean,
  error?: string,
  callId?: string,
): Record<string, unknown> {
  if (callId !== undefined) {
    return { accepted, callId };
  }
  if (error !== undefined) {
    return { accepted, error };
  }
  return { accepted };
}

/** Parse the callee's offer acknowledgement. Returns null on any mismatch. */
function parseOfferAck(payload: unknown): OfferAck | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.accepted !== "boolean") {
    return null;
  }
  if (obj.accepted) {
    // Strict: { accepted, callId }
    if (Object.keys(obj).length !== 2 || typeof obj.callId !== "string") {
      return null;
    }
    return { accepted: true, callId: obj.callId };
  }
  // { accepted } or { accepted, error }
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    return { accepted: false };
  }
  if (keys.length === 2 && typeof obj.error === "string") {
    return { accepted: false, error: obj.error };
  }
  return null;
}
