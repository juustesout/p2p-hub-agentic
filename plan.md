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
  - 0C mDNS-lek — GEDONE (minimaal, handshake gedelegeerd naar 1A): `skills` uit de mDNS-TXT-advertentie verwijderd + `version`-veld toegevoegd; `discover(skill)` retourneert alle peers (capability-filtering komt terug met de 1A-handshake); `advertisedSkills` → `capabilities` (niet meer uitgezonden). Tests: ontdekte peers exposen geen skills. Spec-gap vastgelegd: "capability-discovery pas na handshake" vereist de 1A-capability-uitwisseling.
  - 0D Exposure — GEDONE: `P2P_HUB_EXPOSE=1` (bestaand) + nieuw `P2P_HUB_NETWORKING=0` voor een volledig local-only core-server (geen P2P-transport, geen identity, vault wordt nooit aangeraakt — corrupte vault faalt niet op een local-only boot); `CoreServerOptions.networking` default aan.
  - 0E Storage locking — GEDONE: `core/src/storage/file-lock.ts` (cross-process lockfile `.name.lock` per storage-pad, atomair via `O_EXCL`, PID/stale-detectie — dode eigenaar direct vrijgemaakt, live eigenaar nooit gestolen, wachters time-outen luid met `StorageLockTimeoutError`; reentrant binnen één proces). Lock omhult de héle read-modify-write in `FileWriteQueue.enqueue` (vault + scoped storage) en de losse `atomicWriteFile`-write (core-server settings.json, `app.ts:913`). Temp→fsync→rename-atomiciteit behouden. Tests: unit (serialisatie/verloren-update, reentrancy, live-lock niet gestolen → timeout, stale-lock gestolen) + echte multi-process tests via `fork` (2 children schrijven tegelijk: counterfile géén verloren increments; zelfde vault beide sets keys intact). Geverifieerd dat de tests zonder lock écht falen (verloren updates) en met lock slagen — op Linux; Windows via Hermes nog te bevestigen.
- **Fase 1**
  - 1A Protocol-handshake + capability-filtering — GEDONE (eerste deel): nieuw `plugins/network-light/src/wire-contract.ts` legt het wire-contract vast (frame `[4-byte BE lengte][UTF-8 JSON]`, envelope `{protocol, version, type, body}` in canonieke veldvolgorde, types hello/hello_ack/task/result; proza-spec in docblock zodat een onafhankelijke implementatie interoperabel kan zijn zonder TS-code te delen — bytes zijn de bron van waarheid, canonieke serialisaties gepind in tests). `negotiateVersion` = hoogste overlap, anders `null` → close. `parseEnvelope` default-denied onbekend protocol/versie/vorm. Elke connectie opent nu met een handshake (hello → hello_ack) over de fingerprint-geverifieerde TLS-sessie; `sendTask` eert de peer-`maxPayloadBytes`-limiet lokaal vóór verzenden, server vereist `hello` als eerste bericht met `HANDSHAKE_TIMEOUT_MS`, taak-vóór-hello / onbekende versie / malformed frame sluiten de verbinding (default-deny). Capabilities worden alleen in de handshake uitgewisseld (0C-principe gehandhaafd — mDNS-TXT blijft `{id, version, certFingerprint, peerId?}`); `discover(skill)` filtert op handshake-geleerde capabilities (per-peer cache + negatieve cache `PROBE_RETRY_MS=10s` + inflight-dedupe), en `core/src/plugin-loader/plugin-loader.ts` delegeert `discover` naar de actieve provider (0C-spec-gap gesloten). Nieuwe tests: wire-contract (gepinde bytes, round-trips, default-deny, negotiateVersion) + provider (discover-filtering, maxPayloadBytes pre-send, unsupported versie → close, task-vóór-hello → close, malformed frame → close). Alle 9 workspaces groen op Linux; Windows via Hermes bevestigd (13/13 network-light groen, incl. 3 LAN-peers die niet meer door discovery lekken).
  - 1A (vervolg) Identity binding + abuse limits — GEDONE: zie 1B/1C hieronder (opgenomen in dezelfde commit; plan-opsplitsing 1A→1B/1C gehandhaafd als substappen).
  - 1B Identity binding / cert-pinning — GEDONE: het wire-contract kent nu een identiteitsbinding in de handshake. `hello` draagt optioneel een client-nonce; `hello_ack` draagt optioneel een server-nonce + `identity` (`{peerId, certFingerprint, signature}`); nieuwe `auth`-message (client → server, vóór de eerste task). Signature = Ed25519 over `IDENTITY_BINDING_CONTEXT || clientNonce || ":" || serverNonce || ":" || certFingerprint`, met `certFingerprint` = SHA-256 fingerprint van het daadwerkelijk gepresenteerde cert. Verificatie (identiek aan beide kanten): peerId-vorm, fingerprint gelijk aan het gepresenteerde cert, signature geldig onder peerId — anders close (default-deny). Zowel client (verifieert server in `hello_ack`) als server (verifieert client in `auth`) bewijzen zo "claimed peerId ↔ Ed25519 key ↔ transport cert" in één stap; beide nonces + cert-fingerprint in de signatuur maken cross-connectie-replay onmogelijk. mDNS blijft bootstrap-only: `peerId`/`certFingerprint` daar zijn claims, de handshake bewijst ze. Mutual TLS: server vraagt client-cert (`requestCert: true`, nooit `rejectUnauthorized: true`), client presenteert z'n eigen per-boot cert. `discover`/`listPeers` exposen `peerId` alleen als handshake-geverifieerd (`peerIdVerified`); core-server + plugin-host draad via een `identitySigner`-capability (de private sleutel blijft in `IdentityManager`, de provider krijgt alleen ondertekende bytes). Inbound `TaskRequest` kreeg optioneel `peerId` (alleen door het transport gezet, nooit van de wire geaccepteerd). Tests: round-trip (beide kanten verifiëren elkaar), spoofed identity (auth claimt peerId dat de signer niet houdt → close), gepinde bytes, default-deny op malformed nonce/identity/auth, `verifyIdentityBinding` accepteert echte / verwerpt getamperde signaturen.
  - 1C Peer-level abuse protection — GEDONE: `plugins/network-light/src/peer-limiter.ts` — per-IP limieten (`maxConnectionsPerIp`=8, `maxConcurrentTasksPerIp`=4, `maxRequestsPerWindowPerIp`=120 per 10s), instelbaar via `NetworkLightOptions.peerLimits`. Connectiecap wordt gecontroleerd vóór enige byte-parse, taakconcurrency bij dispatch (overflow krijgt `too many concurrent tasks`), request-budget telt elke handshake + task (uitputting → close). Payload-size gebruikt het SDK-guard `validatePayloadSize` in `tryDecodeFrame` (reuse). Tests: unit (connectie-/task-slots, fixed-window reset, snapshot/clear) + provider (connectie-flood > cap → gesloten, concurrent-task-cap → overflow-refusal, 2 echte identities verifiëren elkaar). Alle 6 workspaces + plugins groen op Linux (0 failures); Windows via Hermes nog te bevestigen.
- **Fase 2**
  - 2C Manifest signing & identity — GEDONE (fundering): plugin-ids zijn nu **dot-free** (`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`) — de `.` is gereserveerd als skill/hook-namespace-scheidingsteken, dus de dotted-collision (`"a.b"` vs `"a"` claimen `b.x`) is structureel onmogelijk (fix van een bekende open follow-up). Nieuw `sdk/src/manifest-signing.ts`: Ed25519-manifest-signing over een **canonieke serialisatie** (deterministisch, gesorteerde keys — signer en verifier delen exact dezelfde bytes, key-volgorde-onafhankelijk), met `manifest.files` = SHA-256 content-hashes van élk shipped bestand (behalve manifest.json/node_modules/.git/*.tsbuildinfo; symlinks worden nooit gevolgd). `manifest.signature` = `{alg:"ed25519", publicKey, value}` met publicKey in peerId-formaat en private key PKCS8 PEM (dezelfde conventie als IdentityManager). Verificatie is symmetrisch — geen key-registry, geen hardcoded sleutel. Default-deny in de loader: een manifest dat een signature **claimt** moet die bewijzen (malformed/wrong-alg/bad-key/invalid signature/tampered veld → load geblokkeerd via `InvalidManifestError`), en elke content-hash moet matchen (gewijzigde code, ongesigned toegevoegd bestand, `..`-traversal-pad → load geblokkeerd). Ongesignde plugins laden nog (dev-flow) maar worden bij boot **één keer luid** als `unsigned/untrusted` gelogd en via `PluginHost.pluginSignature(id)` gedistribueerd; `PluginHostOptions.requireSignedPlugins: true` weigert alle ongesignde plugins hard. Nieuwe tooling `apps/create-p2p-plugin` (`npm run scaffold-plugin`): `new <name> [--sign]`, `sign <dir> --key`, `keygen`, `verify`. Tests: SDK (canonieke bytes gepind, round-trip, elk veld getamperd → fail, wrong key → fail, malformed signature → fail, file-hash coverage/missing/changed/unhashed/traversal), loader (dotted id geweigerd, signed loadt, tampered fields/code/nofiles → geblokkeerd), plugin-host (unsigned gelabeld, requireSignedPlugins weigert, mutated code geweigerd), CLI (scaffold/sign/verify/tamper). Alle workspaces groen op Linux; Windows via Hermes nog te bevestigen.
  - 2C (vervolg) openstaand: first-party plugins in `plugins/` zijn nog **ongesignd** — signing gebeurt pas bij packaging via `create-p2p-plugin sign` (content-hashes churnen bij elke build, dus niet in de dev-boom). Volgt samen met 2A/2B of een release-stap.
  - 2A Algemeen peer-app capability-model — GEDONE: remote-access authorization is now **platform-enforced at the TaskBroker** instead of a per-plugin convention. Nieuw `core/src/task-broker/remote-access.ts`: een skill declareert bij registratie een `remote` policy (`{ gate: "verified-contact" | "access-pass" | "any" | [...OR...], scope? }`); `handleRemote` evalueert die **vóór** dispatch — de handler draait nooit als de gate dicht is. Fail-closed op elke manier: netwerk-exposed skill (`localOnly: false`) **zonder** policy wordt geweigerd; `access-pass` vereist een `scope` (fout luid bij registratie); anonieme remote peer (geen transport-geverifieerde `peerId`) kan nooit aan `verified-contact`/`access-pass` voldoen; ontbrekende `RemoteGate` = deny; een gooiende gate opent de deur niet. `any` (expliciet publiek) vereist een extra manifest-permissie `network:public:<id>.<skill>` bovenop `network:skill:<id>.<skill>` (loader-afgedwongen). `SkillHandler` krijgt een tweede arg `{ peerId }` = de transport-geverifieerde caller (Fase 1B identity binding), nooit een caller-gesuppliede payload-waarde. Nieuw `core/src/task-broker/access-pass-manager.ts` + `ctx.access` (issue/revoke/hasPass): ephemeral, scoped, expiring per-peer passes in één core store die zowel `ctx.access` als de broker-gate deelt. `PluginHost` injecteert de `RemoteGate` (late-bound contacts lookup + access-pass store). Migratie: peersite `fetchAsset` → gate `["verified-contact","access-pass"]` scope `"site-read-only"`, plugin-eigen pass-store vervangen door `ctx.access`, plugin-level `provePossession` verwijderd (possession bewijst nu het transport); `status`/`signAuthChallenge`/`requestAccess` + `contacts.signChallenge` + `chat.receiveMessage` + `calendar.listEvents` + testlab `echo`/`forward` + `core.echo` → expliciete `any`-policy (bestaand gedrag behouden, nu expliciet + `network:public`-permissie). Tests: broker-gate (deny/allow/fail-closed/anoniem/geen-gate/OR/`any`/peerId-context/gooiende gate), access-manager (scopes, TTL, revoke, validatie), loader (`network:public` verplicht bij `any`, `ctx.access` gedeeld), en de **2A-toetssteen** in `apps/testlab/src/peer-app.test.ts`: A publiceert een lokale dir als P2P-site, B (verified contact) haalt assets op via het P2P-protocol, C (vreemdeling) wordt geweigerd — óók met gespoofde payload-peerId — en krijgt na een menselijk goedgekeurde knock een access pass waarmee wél. Volle suite 457 tests / 0 failures op Linux; Windows via Hermes nog te bevestigen.
  - 2B Plugin security voor derde partijen — GEDONE (Scoped 2B, **Optie 1: capability-matrix-verscherping zonder proces-isolatie**, expliciet geaccordeerd; harde OS-isolatie is een documented accepted risk naar Fase 3 — de vertrouwensgrens blijft: Ed25519-sleutelbezitter = in-process toegang). De capability-matrix is de autoriteitsgrens, structureel afgedwongen op elke surface die eerder op documentatie/aannames leunde. Wat in zit:
    1. **HTTP-bridge opt-in** — `httpExposed: true` vereist nu een expliciete manifest-permissie `network:http:<id>.<skill>` vóór laden (los van `network:skill`/`network:public` — onafhankelijke surface, eigen gate; CLAUDE.md-principe #1). Eerste-partij-plugins: calc (12), paint (9), notepad (5), ens (2), calendar (3), peersite (2).
    2. **`ctx.dataDir`-scoping** — plugins krijgen `<dataDir>/plugins/<pluginId>`, nooit de host-datadir; `isPathInsideDataDir` (trailing-separator-geankerd, realpath-aware, symlink-onveilig → lexicale fallback) beschermt de échte datadir tegen paden die een plugin user-supplied mag valideren (PeerSite root).
    3. **Cross-namespace `hooks.on` gating** — `on` vereist `hooks:on:<event>` bij een ander namespace (delimiter-geankerd `<id>:`-prefix); eigen namespace blijft vrij. Chat + `hooks:on:tasks:taskUpdated`, birthday-cards + `hooks:on:calendar:eventAdded`.
    4. **`ctx.identity` structurele domain separation** — `sign(domain, data)`/`verify(pub, domain, data, sig)` met **verplicht domein** dat core prependt (`domain || data`); een plugin kan nooit raw caller-gekozen bytes tekenen. Wire-bytes identiek aan de historische `p2p-hub:*:v1:`-contexts (interop behouden); domeinconstanten blijven en worden nu als domein-argument doorgegeven.
    5. **Plugin-UI-server (`/ui/<pluginId>/*` in core-server)** — statische UI-assets uit de plugin-dir (root = dir vóór `ui.entry`, containment via `resolveAndContainFile`: traversal/dotfiles/backslashes/NUL/symlinks → 404), hardened CSP (`default-src 'none'; connect-src 'none'; script-src 'self'; ...` + `no-store`), loopback-gate achter `lanSiteAllowed`, alleen GET/HEAD. **Bewuste afwijking van de eerdere "boot-token"-notitie**: `/ui` wordt ZONDER boot-token geserveerd (net als `/site`) — een boot-token in de iframe-URL is leesbaar door de plugin-UI-code zelf, en daarmee zou een sandboxed plugin elk willekeurig `/api/*`-skill kunnen aanroepen (het hele shell-bridge-allowlist omzeild). `/ui` serveert alleen publieke plugin-assets; elke capability-aanroep vereist elders nog het boot-token. `ui.entry`-containment + `ui.skills`-schema worden in de loader structureel gevalideerd.
    6. **Plugin-UI bridge (shell)** — sandboxed iframe (`allow-scripts allow-same-origin`, géén allow-top-navigation/forms/popups; cross-origin geladen van de core-server-origin, nooit van de shell-origin, dus geen shell-DOM-toegang) + **origin-gepinde** `plugin-bridge.ts`: inbound alleen bij exacte `event.origin === CORE_ORIGIN`, outbound met `targetOrigin = CORE_ORIGIN` (nooit `"*"`), en een **manifest-gedeclareerde skill-allowlist** (`ui.skills` — een UI kan alleen skills aanroepen die het manifest expliciet opgeeft; geen `"*"`, geen full-skill-list). `ui.skills`-entries moeten in de eigen namespace liggen én een matching `network:http:<entry>`-permissie hebben (loader-afgedwongen). Capabilities exposen `ui: {entry, defaultWidth, defaultHeight, skills}`. StartMenu opent UI-plugins in een window met de manifest-afmetingen.
    Tests: 484 / 0 failures (was 466). Deelnemende surfaces per nieuwe grens: loader (http-permissie, dataDir-scoping, hooks.on, ui.skills, ui.entry), core-server (`/ui` CSP/containment/loopback/no-token), plugin-host (`pluginUiRoot`), peer-auth (domeinverplicht signer/verify + `buildKnockData`), shell (typecheck). Volgende follow-up: Fase 3 OS-isolatie (proces-level sandbox) als aparte fase; `network-light` mDNS-skill-naam-lek (bekende open follow-up) nog open.
