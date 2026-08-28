import { wireNetworkToBroker } from "@p2p-hub/core";
import type { NetworkRegistry, PluginHost, TaskBroker } from "@p2p-hub/core";
import type { NetworkProvider } from "@p2p-hub/sdk";

/**
 * The `@p2p-hub/network-libp2p` provider is an ESM-only package (the libp2p
 * v3 dependency graph is ESM-only), while core-server compiles to CommonJS.
 * tsc rewrites a static `import()` under `module: commonjs` into `require()`,
 * which cannot load ESM here, so the provider is fetched through the same
 * dynamic-import escape hatch the plugin loader uses for its sandboxed
 * plugin bundles (see `plugin-loader.ts` `new Function("specifier",
 * "return import(specifier)")`).
 */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<Record<string, unknown>>;

/** Options type of the dynamic-imported `NetworkLibp2pProvider`. */
interface WanProviderConstructorOptions {
  listenAddresses?: string[];
  relayAddresses?: string[];
  skills?: string[];
  identity: { peerId: string; publicKeyHex: string };
  identitySigner: (data: Buffer) => Promise<Buffer>;
  hasBrokerRateLimiting: () => boolean;
  privateKeyRaw: Uint8Array;
}

/**
 * The dynamic-imported provider satisfies the full `NetworkProvider` contract
 * (the plugin implements it) plus the Optie B getter.
 */
type WanProviderInstance = NetworkProvider & {
  transportPublicKeyHex: string | null;
};

/**
 * Structural handle to the WAN provider. Deliberately not the plugin's
 * concrete type: core-server must not statically depend on the ESM transport
 * package, and only needs these few surfaces to drive start/stop and to expose
 * the identity-match property for the acceptance test.
 */
export interface WanProviderHandle {
  readonly id: string;
  isReady(): boolean;
  stop(): Promise<void>;
  /** Raw public-key hex of the transport PeerId, when available (Optie B). */
  transportPublicKeyHex: string | null;
}

/** Dependencies for wiring the WAN transport into a running core-server. */
export interface StartWanProviderDeps {
  broker: TaskBroker;
  host: PluginHost;
  registry: NetworkRegistry;
  relayAddr?: string;
  listenAddrs?: string[];
}

/**
 * Start the WAN transport (network-libp2p) next to the LAN transport, sharing
 * the same p2p-hub identity (Optie B / unification): the provider is built
 * from `IdentityManager.exportLibp2pKeySeed()`, so the libp2p PeerId equals
 * the Ed25519 identity used over mDNS — the raw seed is derived *inside*
 * IdentityManager and never floats around this module (CLAUDE.md #6).
 *
 * The transport is a pure bytepipe for the existing wire contract (hello →
 * auth → task → result) and discovers nothing: it dials only operator-configured
 * relays/listen addresses. `wireNetworkToBroker` makes the TaskBroker the single
 * enforcement point for who may invoke a skill over it (a network-exposed skill
 * without a `remote` policy is denied before dispatch), and the hard
 * `hasBrokerRateLimiting` precondition keeps a WAN-facing transport behind the
 * same broker-level per-peer task budget as the LAN transport.
 *
 * Unlike network-light, the libp2p provider has no `onEventMessage` surface, so
 * the event-transport bridge (`host.wireEventsToProvider`) is intentionally not
 * wired here — there is no inbound event frame channel to route.
 */
export async function startWanProvider(
  deps: StartWanProviderDeps,
): Promise<WanProviderHandle> {
  const remoteSkills = deps.broker
    .listSkills()
    .filter((s) => !s.localOnly)
    .map((s) => s.skill);

  const module = await dynamicImport("@p2p-hub/network-libp2p");
  const ProviderCtor = module.NetworkLibp2pProvider as new (
    options: WanProviderConstructorOptions,
  ) => WanProviderInstance;

  const identityManager = deps.host.identityManager();
  const identity = await identityManager.getOrCreateIdentity();

  const provider = new ProviderCtor({
    listenAddresses: deps.listenAddrs,
    relayAddresses: deps.relayAddr ? [deps.relayAddr] : undefined,
    skills: remoteSkills,
    identity,
    identitySigner: (data) => identityManager.sign(data),
    hasBrokerRateLimiting: () => deps.broker.hasRateLimiting(),
    privateKeyRaw: await identityManager.exportLibp2pKeySeed(),
  });

  deps.registry.register(provider);
  // Same reasoning as startNetworking: the host boots without `enableNetworking`
  // so plugin `ctx.network` resolves against ITS registry. Register the WAN
  // provider there too so remote skill calls over libp2p route through the same
  // capability. The WAN provider is lower-priority than the LAN provider, so
  // `selectActive()` keeps preferring the LAN transport when both are up.
  deps.host.networkRegistry().register(provider);
  wireNetworkToBroker(provider, deps.broker);
  await provider.start();

  return provider;
}
