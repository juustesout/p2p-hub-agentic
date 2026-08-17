import type { NetworkProvider } from "@p2p-hub/sdk";
import { TaskBroker } from "./task-broker";

/**
 * Connect a running {@link NetworkProvider} to a {@link TaskBroker} so that
 * incoming tasks are routed through the broker. Deliberately not called
 * automatically from `PluginHost` or the providers themselves — the caller
 * (a test, or later the real application entrypoint) wires them explicitly.
 */
export function wireNetworkToBroker(
  provider: NetworkProvider,
  broker: TaskBroker,
): void {
  provider.onTask((task) => broker.handle(task));
}
