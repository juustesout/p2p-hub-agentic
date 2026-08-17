import type { ActivityEvent } from "../types";
import { coreBridge } from "./core-bridge";

const MAX_BUFFER = 100;

type Subscriber = (event: ActivityEvent) => void;

/**
 * Central activity bus. Subscribes to raw events from the CoreBridge and
 * distributes them to per-event subscribers and a rolling action feed. The
 * same event can simultaneously drive toasts, peer indicators and the Hermes
 * action feed without any coupling between those consumers.
 */
export class ActivityBus {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly allSubscribers = new Set<Subscriber>();
  private readonly buffer: ActivityEvent[] = [];

  private readonly unsubscribeBridge: () => void;

  constructor() {
    this.unsubscribeBridge = coreBridge.onEvent((event) => this.dispatch(event));
  }

  subscribe(event: string, subscriber: Subscriber): () => void {
    const set = this.subscribers.get(event) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.subscribers.set(event, set);
    return () => {
      set.delete(subscriber);
      if (set.size === 0) {
        this.subscribers.delete(event);
      }
    };
  }

  subscribeAll(subscriber: Subscriber): () => void {
    this.allSubscribers.add(subscriber);
    return () => this.allSubscribers.delete(subscriber);
  }

  recent(count = MAX_BUFFER): ActivityEvent[] {
    return this.buffer.slice(-count);
  }

  dispose(): void {
    this.unsubscribeBridge();
    this.subscribers.clear();
    this.allSubscribers.clear();
    this.buffer.length = 0;
  }

  private dispatch(event: ActivityEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.shift();
    }
    for (const subscriber of this.subscribers.get(event.event) ?? []) {
      subscriber(event);
    }
    for (const subscriber of this.allSubscribers) {
      subscriber(event);
    }
  }
}

export const activityBus = new ActivityBus();
