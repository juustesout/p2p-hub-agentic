import type { NetworkPeer } from "@p2p-hub/sdk";
import type { EventNetwork } from "./event-network";
import type {
  EventEmitBody,
  EventMessageHandler,
  SubAckBody,
  SubReqBody,
} from "./types";

/** A fake peer that "owns" a verified peerId. */
export function fakePeer(peerId: string, id = `inst-${peerId.slice(0, 6)}`): NetworkPeer {
  return {
    id,
    address: "127.0.0.1:0",
    skills: [],
    peerId,
  };
}

export interface RecordedEvent {
  peer: NetworkPeer;
  body: EventEmitBody;
}

/**
 * In-memory {@link EventNetwork} double. Records every outbound frame and lets
 * the test script `sub_ack`/`sendEvent` results.
 */
export class FakeEventNetwork implements EventNetwork {
  readonly id = "fake-events";
  peers = new Map<string, NetworkPeer>();
  subAcks = new Map<string, SubAckBody | null>();
  sendEventResult = true;
  onEventMessageHandler: EventMessageHandler | null = null;
  sentSubReqs: Array<{ peer: NetworkPeer; body: SubReqBody }> = [];
  sentEvents: RecordedEvent[] = [];
  isReadyValue = true;

  isReady(): boolean {
    return this.isReadyValue;
  }

  listPeers(): NetworkPeer[] {
    return [...this.peers.values()];
  }

  getPeer(peerId: string): NetworkPeer | undefined {
    return this.peers.get(peerId);
  }

  onEventMessage(handler: EventMessageHandler): void {
    this.onEventMessageHandler = handler;
  }

  async sendSubReq(peer: NetworkPeer, body: SubReqBody): Promise<SubAckBody | null> {
    this.sentSubReqs.push({ peer, body });
    return this.subAcks.get(body.subscriptionId) ?? this.subAcks.get("default") ?? null;
  }

  async sendEvent(peer: NetworkPeer, body: EventEmitBody): Promise<boolean> {
    this.sentEvents.push({ peer, body });
    return this.sendEventResult;
  }

  /** Feed an inbound frame through the attached handler (as the transport would). */
  async deliver(msg: Parameters<EventMessageHandler>[0]): Promise<SubAckBody | null> {
    if (!this.onEventMessageHandler) {
      return null;
    }
    return (await this.onEventMessageHandler(msg)) ?? null;
  }
}
