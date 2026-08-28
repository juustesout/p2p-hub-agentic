# 001 – WAN-transport via operator circuit-relay (network-libp2p)

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 |
| **Opdracht/brief** | WAN-slice: netwerklaag uitbreiden voorbij LAN (plan.md "Slice 1: WAN-wiring") |
| **Commits** | `e64da91` (libp2p WAN-provider + broker-wide rate limiting), `72ea415` (core-server-wiring + identity-unificatie) |
| **Wiki-sectie** | `docs/wiki/03-wan-networking-and-relays.md` |

## Context

Tot deze slice was `network-light` (mDNS + TLS) de enige transportlaag: goed voor
LAN, onbruikbaar voor peers achter NAT/CGNAT. De WAN-richting voegt
`plugins/network-libp2p` toe — een circuit-relay v2-gedreven transport — en draad
die in `@p2p-hub/core-server` achter een strikte opt-in flag. De **LAN-only
default-boot blijft ongewijzigd**: WAN is uit tenzij expliciet aangezet
(`P2P_HUB_WAN_ENABLED`, zelf gated op `networking !== false`).

De relay op `144.172.102.63:4002` (`/ip4/144.172.102.63/tcp/4002/p2p/12D3KooW…`)
is **first-party eigendom** van de developer (VPS betaald t/m juli 2027), live
geverifieerd: bereikbaar, encrypted reservation + relayed multiaddr geadverteerd.
Ops-kant van het relay-beheer blijft bij de operator.

## Besluiten

### 001.1 — Optie B identity-unificatie: `transportPublicKeyHex === identity.peerId`

Geen losse transport-sleutels. De libp2p-transport-PeerId is cryptografisch één
met de p2p-hub-Ed25519-identiteit die ook over mDNS wordt geadverteerd en in de
Fase 1B-handshake wordt bewezen. Mechanism: `IdentityManager.exportLibp2pKeySeed()`
(`core/src/identity/identity-manager.ts`) geeft een 64-byte `seed ‖ publicKey`-buffer
af, JWK-intern afgeleid; de provider wordt gebouwd met `privateKeyFromRaw`
(`plugins/network-libp2p/src/network-libp2p-provider.ts`). De PKCS8-PEM **verlaat
de klasse nooit** — dit is de enige, purpose-built uitzondering op "private key
blijft binnen IdentityManager" (CLAUDE.md #6: "een component die een secret leest
is de enige die dat mag").

Gevolg: `peerFingerprint` = `SHA-256(libp2p PeerId)` wordt over de wire als
transport-identity-pin ondertekend en door `checkPeerAccess`-consumers herkend als
dezelfde identiteit als de mDNS-cerFingerprint-keten — identiteit en routing zijn
niet meer te ontkoppelen.

### 001.2 — DHT-afwijzing: geen Kademlia-DHT, geen GossipSub

De open discovery-route is structureel afgewezen en als architectuur-guard
geborgd (harde block op `@libp2p/kad-dht` en gossipsub in
`plugins/network-libp2p/src/dependency-surface.test.ts`). Redenering, in volgorde
van sterkte:

1. **Het probleem bestaat hier niet** — de fixed relay geeft elke contact een
   stabiele `/p2p-circuit`-multiaddr, onafhankelijk van veranderend thuis-IP;
   peer-adresmobiliteit (de canonieke DHT-use-case) is al opgelost.
2. **Paradigm shift** — een open overlay schendt deny-by-default en het
   invite-only trustmodel; zelfs een client-mode node lekt aan de bevraagde DHT-node
   *welke peers* deze node kent.
3. **Vanilla Kademlia is niet veilig** — Sybil/Eclipse; S/Kademlia of crypto-puzzle
   ID-generatie zou een voorwaarde zijn.
4. **Nieuwe verdedigingslaag nodig** — open discovery forceert transport-level
   TCP/Noise-handshakes van onbekende peers *vóór* de broker er een budget op
   legt; de bestaande per-peer rate limiter raakt dat vlak niet.

### 001.3 — Relay-rol: E2E-encrypted bytepipe, geen inspectie

De relay verifieert geen applicatiedata en routeert uitsluitend op `/p2p-circuit`
multiaddrs. De Noise XX-handshake wordt door de relay nooit getermineerd, dus een
relay kan geen eigen PeerId substitueren — de MITM die een self-signed-cert-pin
tegen moest gaan, bestaat hier niet. **Accepteerde trade-off**: de relay is wél
een single point of *metadata* — het observeert endpoints en volume/timing van
versleutelde streams (nooit inhoud). Channel binding is daarom bewust een
transport-*identity*-pin (SHA-256 van de langlevende PeerId), geen per-sessie
TLS-cert-fingerprint: js-libp2p-Nosie exposeert geen sessie-transcript-hash aan de
applicatie (geverifieerd tegen `@chainsafe/libp2p-noise@17`).

### 001.4 — Opt-in wiring met broker-preconditions (defense-in-depth)

`apps/core-server/src/wan-provider.ts` importeert de ESM-only provider dynamisch
(CJS→ESM via de bestaande escape-hatch), registreert hem in **beide** registries
(server-registry én host-registry zodat `ctx.network` hem ziet) en draad hem door
`wireNetworkToBroker`. De TaskBroker blijft daarmee het enige autorisatiepunt;
`hasBrokerRateLimiting` (de broker-wide per-peer rate limiter uit `e64da91`) is een
**harde start-precondition**. De provider heeft geen `onEventMessage`-surface en
dialt uitsluitend operator-geconfigureerde relays/listen-adressen — geen
discovery-surface. `wanEnabled: false` laat de default-boot byte-gelijk aan
voorheen.

## Alternatieven overwogen

- **Optie A (random libp2p-transportkey)** — transport-PeerId los van de
  p2p-hub-identiteit; bleef als default behouden wanneer geen seed wordt
  geleverd, maar de gewirede default is Optie B: twee identiteiten per node
  maken audit en contact-koppeling dubbel.
- **Kademlia-DHT / open global discovery** — zie 001.2; definitief afgewezen.
- **`rejectUnauthorized: false` of ongeleide cert-pinning** — nooit; de
  transport-identity-pin vervangt de TLS-cert-pin die `network-light` per-sessie
  roteerde (CLAUDE.md #4).

## Gevolgen & grenzen

- Relay is een metadata-single-point; documentatie wijst op eigen relays
  (circuit-relay-node ≈ 20 regels) en redundantie voor volledige soevereiniteit.
- Libp2p-ecosysteem is een lopende dependency-onderhoudslast: exacte pinnen,
  ESM-only build, `dependency-surface`-test bij elke bump.
- De optionele `wireEventsToProvider`-koppeling bestaat niet voor libp2p — events
  over WAN zijn een latere slice.
- Toekomstige "relay-privacy" (onion/cascade-routing) is bewust uit scope.

## Status & testbewijs

Gebouwd en gewired. `apps/core-server/src/wan.test.ts` bewijst de
identity-unificatie end-to-end (transport-PeerId === p2p-hub-identiteit);
`dependency-surface.test.ts` borgt de anti-DHT-guard. Default-boot onveranderd:
alle pre-WAN-tests groen. Suite: **999 tests / 0 fail** (`npm run build && npm test`).

## Gerelateerd

- `004` (Fase 1: identity binding — de keten die de PeerId bewijst)
- `014` (netwerklaag: one-sided mDNS + `ctx.network`-wiring)
- CLAUDE.md sectie "libp2p is een ongoing dependency-maintenance burden" + DHT-notitie
- README.md "Run against a relay"
