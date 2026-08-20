# plan.md — p2p-hub: definitieve routekaart & architectuurbeslissingen

Dit document vervangt de eerdere open beslisvragen. Het is de **technische
opdracht**: niet opnieuw breed herontwerpen; waar details ontbreken eerst code
inspecteren en bestaande security-/architectuurprincipes behouden.

## Doel

Geen "desktop app met wat plugins", maar een **P2P-first desktop suite** waarin
een lokale peer veilig capabilities/services aanbiedt aan andere peers.

```
Identity → Discovery → Authenticated P2P transport → Versioned protocol
        → Scoped capabilities/services → Plugins / Peer Apps
```

P2P-exposure is een primaire protocol-laag, niet alleen HTTP. De later komende
statische-website-functionaliteit is hier een concreet voorbeeld: een peer
publiceert een lokale directory via het P2P-protocol voor geautoriseerde peers,
zonder publieke HTTP-webserver.

## Fase 0 — Fundering en testbaarheid (volledig betrouwbaar vóór nieuw werk)

- **0A Cross-platform CI** — GitHub Actions op Linux + Windows: `tsc -b`,
  alle tests, `cargo check`, relevante smoke/integration tests. Windows-issues
  mogen niet terugkeren.
- **0B Multi-peer testlab** — in de monorepo (`apps/testlab`), meerdere
  onafhankelijke `PluginHost`s, echte netwerkcommunicatie, min. A↔B↔C met een
  network-exposed capability-aanroep. Uitvoerbaar in CI. "378 tests groen" is
  géén bewijs voor correct P2P — multi-peer integration tests zijn een aparte
  kwaliteitslaag.
- **0C mDNS geen capability-lek** — mDNS is uitsluitend discovery/bootstrap.
  Adverteer géén skill-namen; alleen peerId/node-identity, IP, poort,
  protocol/version. Capability-discovery pas na authenticated/encrypted
  handshake. Onbekende LAN-peer kan uit mDNS niet afleiden welke skills bestaan.
- **0D Expliciete network exposure** — `P2P_HUB_HOST=0.0.0.0` mag nooit
  automatisch de bridge publiek maken; expliciete opt-in `P2P_HUB_EXPOSE=1`;
  local-only core-server blijft mogelijk; networking blijft achter dezelfde
  identity/vault/security gates als `PluginHost.boot()`.
- **0E Storage concurrency** — cross-process locking rond het bestaande
  atomic-write (temp → fsync → rename blijft), de hele write onder een
  cross-process lock. Gedrag expliciet verifiëren op Windows én Linux.

## Fase 1 — Protocolcontract vóór verdere uitbreiding

Regel: **een P2P-peer is een onbetrouwbare externe actor**, ook op eigen
machine/LAN.

- **1A Protocol-versionering eerst** — elk externally-triggerable protocol krijgt
  protocol-ID, versie, capabilities, expliciet wire contract; onbekende versies
  default-deny; canonicalisatie expliciet in het contract (geen gedeelde TS
  constructor-afhankelijkheid). Handshake onderhandelt versie/capabilities/limits.
- **1B Daarna identity binding / cert-pinning** — claimed PeerID ↔
  cryptografische identity ↔ transport identity als één verifieerbare keten.
  Bestaande `p2p-hub:peersite:auth:v1` blijft onderdeel. Nooit
  `rejectUnauthorized: false` als oplossing.
- **1C Peer-level abuse protection** — broker-level limits per peer: requests,
  payload-size (hergebruik `validatePayloadSize`), concurrent tasks, eventueel
  bandwidth/queue. Test expliciet met: onbekende identity, replay, malformed,
  oversized payload, flood.

## Fase 2 — Peer Apps en veilige distributie

- **2A peer-app = algemeen capability-model** — Peersite is het prototype. Een
  plugin mag een remote service aanbieden, nooit "remote execute arbitrary
  skill". Gates: verified contact **of** access pass, altijd capability-scoped.
- **2B Plugin security** — derde-partij plugins geen automatische
  OS/fs/netwerk-rechten; plugin-UI declaratief, geen shell/OS-authoriteit;
  autoriteitsgrens blijft de bestaande capability-matrix
  (UI → scoped bridge → PluginContext → core).
- **2C Plugin distributie** — scaffold, manifest-signing (Ed25519),
  signature-verificatie bij install/load, unieke plugin identity, oplossing voor
  dotted skill-ID-collisions. Géén marketplace vóór signing+identity correct zijn.

## Belangrijke richting: P2P Static Websites (vanaf Fase 2)

Een peer publiceert een lokale directory als P2P-website (bijv.
`C:\Sites\juust.eth\`); een geautoriseerde peer haalt `/juust.eth/about.html`
op via het P2P-protocol. Géén verpakte HTTP-server — een capability bovenop het
transport. Wire protocol bijv. `p2p-hub:website:v1`: expliciete requests, path
validation, payload limits, default-deny; alleen binnen een geconfigureerde
root; absolute paden en `..`-traversal onmogelijk.

## ENS als toekomstige naming/discovery-adapter

Ontwerp nu een adapter-interface zodat ENS later slechts een
resolver/discovery-plugin is ("wie/waar moet ik zoeken?"), los van P2P ("hoe
praat ik met die peer?") en website-service ("welke bestanden mag die peer
zien?"). Geen blockchain-afhankelijkheid als vereiste; de website werkt ook met
directe PeerID/contactrecord.

## Teststrategie (elke fase eindigt met echte multi-peer tests)

- **Fase 0:** 2–3 hosts, LAN discovery, authenticated capability call,
  Windows + Linux.
- **Fase 1:** min. 3 peers (A honest, B honest, C malicious): spoofed identity,
  replay, malformed protocol, unsupported version, capability probing,
  rate flood, oversized payload, concurrent storage access.
- **Fase 2:** 4+ peers: third-party plugin, signed manifest, capability
  permissions, peer-app access, prototype static website service
  (A HTML → P2P → B renderable, zonder publieke HTTP-server).

## Niet doen nu

Marketplace, complexe plugin store, volledige ENS-integratie, blockchain als
runtime dependency, IPFS als verplichte storage, willekeurige remote code
execution, capability discovery via onbeveiligd mDNS, HTTP bridge als
vervanging van het P2P-protocol.

## Kern volgorde

```
Cross-platform → Multi-peer → Explicit protocol → Identity binding
→ Capability security → Peer Apps → P2P Website → ENS naming adapter
```

## Eindcriterium

Geslaagd wanneer een lokale machine veilig kan zeggen: "Dit is mijn peer
identity. Ik expose deze specifieke capability aan deze peer. Eén van mijn
capabilities is een statische website. De website staat lokaal op mijn disk.
Een andere peer kan hem via het P2P-protocol ophalen, zonder dat ik een
publieke webserver hoef te draaien."

## Status / voortgang

- **Fase 0**
  - 0A CI — `.github/workflows/ci.yml` (Linux+Windows, Node 20/22, tsc -b, tests, cargo check). GEDONE.
  - 0B Testlab — `apps/testlab`, A↔B↔C mesh + direct + chained call, test + manual runner. GEDONE.
  - Windows-only test failures opgelost (`d095571`): symlink-EPERM via `canCreateSymlinksSync`-probe (skip alleen als de omgeving geen symlinks kan maken), NTFS-mode-asserties (0600 exact op POSIX, owner-writeable op Windows), core-server peersite harness zonder node_modules-symlink (temp dirs onder `node_modules/.cache`, plugin deps resolven via walk-up), test-MITM-cert naar 2048-bit. (Opgelost.)
  - 0C mDNS-lek — nog niet gestart.
  - 0D Exposure — `decideBindHost`/`P2P_HUB_EXPOSE` bestaat; local-only core-server nog niet.
  - 0E Storage locking — nog niet gestart.
- **Fase 1** — nog niet gestart.
- **Fase 2** — nog niet gestart.
