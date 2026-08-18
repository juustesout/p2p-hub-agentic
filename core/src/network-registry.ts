import type { NetworkProvider } from "@p2p-hub/sdk";

/**
 * Registry of available network providers and the selection of the single
 * provider that should currently be active.
 */
export class NetworkRegistry {
  private readonly providers = new Map<string, NetworkProvider>();

  register(provider: NetworkProvider): void {
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): void {
    this.providers.delete(id);
  }

  list(): NetworkProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): NetworkProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Returns the ready provider with the highest priority, or `null` when no
   * provider is ready. A provider that cannot transport tasks (stage-1
   * status-only providers) is never selected, regardless of priority.
   */
  selectActive(): NetworkProvider | null {
    let active: NetworkProvider | null = null;
    for (const provider of this.providers.values()) {
      if (!provider.isReady()) {
        continue;
      }
      if (provider.canTransportTasks === false) {
        continue;
      }
      if (active === null || provider.priority > active.priority) {
        active = provider;
      }
    }
    return active;
  }
}
