import type { NetworkProvider } from "@p2p-hub/sdk";
import { TaskBroker } from "./task-broker";

/**
 * Connect a running {@link NetworkProvider} to a {@link TaskBroker} so that
 * incoming tasks are routed through the broker. The caller wires them
 * explicitly — `PluginHost` does so when networking is enabled, and the real
 * application entrypoint (or a test) wires a provider it constructs itself.
 * Providers never wire themselves.
 *
 * Network tasks go through {@link TaskBroker.handleRemote}, which rejects
 * skills registered as `localOnly`, so sensitive skills (e.g. `vault.*`) are
 * never reachable over the wire.
 */
export function wireNetworkToBroker(
  provider: NetworkProvider,
  broker: TaskBroker,
): void {
  provider.onTask((task) => broker.handleRemote(task));
}
