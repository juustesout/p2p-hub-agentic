import type { NetworkPeer, NetworkProvider } from "@p2p-hub/sdk";
import type {
  EventEmitBody,
  EventMessageHandler,
  SubAckBody,
  SubReqBody,
} from "./types";

/**
 * The provider surface the Stap 5 hub/adapter need. This is deliberately NOT
 * the full {@link NetworkProvider} contract: it is the event-capable subset,
 * duck-typed onto whatever provider the {@link NetworkRegistry} reports as
 * active (see {@link resolveEventNetwork}). A transport that cannot carry
 * events (e.g. `network-libp2p` today) simply resolves to `null` and the
 * host wires a fail-closed stub instead.
 */
export interface EventNetwork {
  readonly id: string;
  isReady(): boolean;
  /** Every currently discovered peer (with verified peerIds where known). */
  listPeers(): NetworkPeer[];
  /**
   * Resolve the discovered {@link NetworkPeer} carrying the transport-verified
   * `peerId`, or `undefined`. Used to fan events out to a subscriber.
   */
  getPeer(peerId: string): NetworkPeer | undefined;
  /** Register the inbound event-message handler (sub_req → hub, event_emit → adapter). */
  onEventMessage(handler: EventMessageHandler): void;
  /** Send a `sub_req` and await the peer's `sub_ack` (never throws). */
  sendSubReq(peer: NetworkPeer, body: SubReqBody): Promise<SubAckBody | null>;
  /** Publish an `event_emit` to a subscribed peer, fire-and-forget (never throws). */
  sendEvent(peer: NetworkPeer, body: EventEmitBody): Promise<boolean>;
}

type EventCapableProvider = Pick<
  EventNetwork,
  "onEventMessage" | "sendSubReq" | "sendEvent"
>;

/**
 * Fail-closed duck-typing: returns an {@link EventNetwork} adapter only when
 * the provider actually implements the event-transport surface. Missing any of
 * the three methods ⇒ `null` (never a partial/crashing adapter).
 */
export function resolveEventNetwork(
  provider: NetworkProvider,
): EventNetwork | null {
  const candidate = provider as unknown as EventCapableProvider;
  if (
    typeof candidate.onEventMessage !== "function" ||
    typeof candidate.sendSubReq !== "function" ||
    typeof candidate.sendEvent !== "function"
  ) {
    return null;
  }
  return {
    id: provider.id,
    isReady: () => provider.isReady(),
    listPeers: () => provider.listPeers?.() ?? [],
    getPeer: (peerId) =>
      (provider.listPeers?.() ?? []).find((peer) => peer.peerId === peerId),
    onEventMessage: (handler) => candidate.onEventMessage(handler),
    sendSubReq: (peer, body) => candidate.sendSubReq(peer, body),
    sendEvent: (peer, body) => candidate.sendEvent(peer, body),
  };
}
