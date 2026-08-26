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
  - 0E Storage locking — GEDONE: `core/src/storage/file-lock.ts` (cross-process lockfile `.name.lock` per storage-pad, atomair via `O_EXCL`, PID/stale-detectie — dode eigenaar direct vrijgemaakt, live eigenaar nooit gestolen, wachters time-outen luid met `StorageLockTimeoutError`; reentrant binnen één proces). Lock omhult de héle read-modify-write in `FileWriteQueue.enqueue` (vault + scoped storage) en de losse `atomicWriteFile`-write (core-server settings.json, `app.ts:913`). Temp→fsync→rename-atomiciteit behouden. Tests: unit (serialisatie/verloren-update, reentrancy, live-lock niet gestolen → timeout, stale-lock gestolen) + echte multi-process tests via `fork` (2 children schrijven tegelijk: counterfile géén verloren increments; zelfde vault beide sets keys intact). Geverifieerd dat de tests zonder lock écht falen (verloren updates) en met lock slagen — op Linux én Windows (geverifieerd in de 3-OS CI-matrix, incl. de fork multi-process locking-test).
- **Fase 1**
  - 1A Protocol-handshake + capability-filtering — GEDONE (eerste deel): nieuw `plugins/network-light/src/wire-contract.ts` legt het wire-contract vast (frame `[4-byte BE lengte][UTF-8 JSON]`, envelope `{protocol, version, type, body}` in canonieke veldvolgorde, types hello/hello_ack/task/result; proza-spec in docblock zodat een onafhankelijke implementatie interoperabel kan zijn zonder TS-code te delen — bytes zijn de bron van waarheid, canonieke serialisaties gepind in tests). `negotiateVersion` = hoogste overlap, anders `null` → close. `parseEnvelope` default-denied onbekend protocol/versie/vorm. Elke connectie opent nu met een handshake (hello → hello_ack) over de fingerprint-geverifieerde TLS-sessie; `sendTask` eert de peer-`maxPayloadBytes`-limiet lokaal vóór verzenden, server vereist `hello` als eerste bericht met `HANDSHAKE_TIMEOUT_MS`, taak-vóór-hello / onbekende versie / malformed frame sluiten de verbinding (default-deny). Capabilities worden alleen in de handshake uitgewisseld (0C-principe gehandhaafd — mDNS-TXT blijft `{id, version, certFingerprint, peerId?}`); `discover(skill)` filtert op handshake-geleerde capabilities (per-peer cache + negatieve cache `PROBE_RETRY_MS=10s` + inflight-dedupe), en `core/src/plugin-loader/plugin-loader.ts` delegeert `discover` naar de actieve provider (0C-spec-gap gesloten). Nieuwe tests: wire-contract (gepinde bytes, round-trips, default-deny, negotiateVersion) + provider (discover-filtering, maxPayloadBytes pre-send, unsupported versie → close, task-vóór-hello → close, malformed frame → close). Alle 9 workspaces groen op Linux; Windows bevestigd in de 3-OS CI-matrix (13/13 network-light groen, incl. 3 LAN-peers die niet meer door discovery lekken).
  - 1A (vervolg) Identity binding + abuse limits — GEDONE: zie 1B/1C hieronder (opgenomen in dezelfde commit; plan-opsplitsing 1A→1B/1C gehandhaafd als substappen).
  - 1B Identity binding / cert-pinning — GEDONE: het wire-contract kent nu een identiteitsbinding in de handshake. `hello` draagt optioneel een client-nonce; `hello_ack` draagt optioneel een server-nonce + `identity` (`{peerId, certFingerprint, signature}`); nieuwe `auth`-message (client → server, vóór de eerste task). Signature = Ed25519 over `IDENTITY_BINDING_CONTEXT || clientNonce || ":" || serverNonce || ":" || certFingerprint`, met `certFingerprint` = SHA-256 fingerprint van het daadwerkelijk gepresenteerde cert. Verificatie (identiek aan beide kanten): peerId-vorm, fingerprint gelijk aan het gepresenteerde cert, signature geldig onder peerId — anders close (default-deny). Zowel client (verifieert server in `hello_ack`) als server (verifieert client in `auth`) bewijzen zo "claimed peerId ↔ Ed25519 key ↔ transport cert" in één stap; beide nonces + cert-fingerprint in de signatuur maken cross-connectie-replay onmogelijk. mDNS blijft bootstrap-only: `peerId`/`certFingerprint` daar zijn claims, de handshake bewijst ze. Mutual TLS: server vraagt client-cert (`requestCert: true`, nooit `rejectUnauthorized: true`), client presenteert z'n eigen per-boot cert. `discover`/`listPeers` exposen `peerId` alleen als handshake-geverifieerd (`peerIdVerified`); core-server + plugin-host draad via een `identitySigner`-capability (de private sleutel blijft in `IdentityManager`, de provider krijgt alleen ondertekende bytes). Inbound `TaskRequest` kreeg optioneel `peerId` (alleen door het transport gezet, nooit van de wire geaccepteerd). Tests: round-trip (beide kanten verifiëren elkaar), spoofed identity (auth claimt peerId dat de signer niet houdt → close), gepinde bytes, default-deny op malformed nonce/identity/auth, `verifyIdentityBinding` accepteert echte / verwerpt getamperde signaturen.
  - 1C Peer-level abuse protection — GEDONE: `plugins/network-light/src/peer-limiter.ts` — per-IP limieten (`maxConnectionsPerIp`=8, `maxConcurrentTasksPerIp`=4, `maxRequestsPerWindowPerIp`=120 per 10s), instelbaar via `NetworkLightOptions.peerLimits`. Connectiecap wordt gecontroleerd vóór enige byte-parse, taakconcurrency bij dispatch (overflow krijgt `too many concurrent tasks`), request-budget telt elke handshake + task (uitputting → close). Payload-size gebruikt het SDK-guard `validatePayloadSize` in `tryDecodeFrame` (reuse). Tests: unit (connectie-/task-slots, fixed-window reset, snapshot/clear) + provider (connectie-flood > cap → gesloten, concurrent-task-cap → overflow-refusal, 2 echte identities verifiëren elkaar). Alle 6 workspaces + plugins groen op Linux én Windows (0 failures; 3-OS CI-matrix, incl. de abuse-limit test).
- **Fase 2**
  - 2C Manifest signing & identity — GEDONE (fundering): plugin-ids zijn nu **dot-free** (`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`) — de `.` is gereserveerd als skill/hook-namespace-scheidingsteken, dus de dotted-collision (`"a.b"` vs `"a"` claimen `b.x`) is structureel onmogelijk (fix van een bekende open follow-up). Nieuw `sdk/src/manifest-signing.ts`: Ed25519-manifest-signing over een **canonieke serialisatie** (deterministisch, gesorteerde keys — signer en verifier delen exact dezelfde bytes, key-volgorde-onafhankelijk), met `manifest.files` = SHA-256 content-hashes van élk shipped bestand (behalve manifest.json/node_modules/.git/*.tsbuildinfo; symlinks worden nooit gevolgd). `manifest.signature` = `{alg:"ed25519", publicKey, value}` met publicKey in peerId-formaat en private key PKCS8 PEM (dezelfde conventie als IdentityManager). Verificatie is symmetrisch — geen key-registry, geen hardcoded sleutel. Default-deny in de loader: een manifest dat een signature **claimt** moet die bewijzen (malformed/wrong-alg/bad-key/invalid signature/tampered veld → load geblokkeerd via `InvalidManifestError`), en elke content-hash moet matchen (gewijzigde code, ongesigned toegevoegd bestand, `..`-traversal-pad → load geblokkeerd). Ongesignde plugins laden nog (dev-flow) maar worden bij boot **één keer luid** als `unsigned/untrusted` gelogd en via `PluginHost.pluginSignature(id)` gedistribueerd; `PluginHostOptions.requireSignedPlugins: true` weigert alle ongesignde plugins hard. Nieuwe tooling `apps/create-p2p-plugin` (`npm run scaffold-plugin`): `new <name> [--sign]`, `sign <dir> --key`, `keygen`, `verify`. Tests: SDK (canonieke bytes gepind, round-trip, elk veld getamperd → fail, wrong key → fail, malformed signature → fail, file-hash coverage/missing/changed/unhashed/traversal), loader (dotted id geweigerd, signed loadt, tampered fields/code/nofiles → geblokkeerd), plugin-host (unsigned gelabeld, requireSignedPlugins weigert, mutated code geweigerd), CLI (scaffold/sign/verify/tamper). Alle workspaces groen op Linux én Windows (3-OS CI-matrix, incl. signing/tamper-tests).
  - 2C (vervolg) openstaand: first-party plugins in `plugins/` zijn nog **ongesignd** — signing gebeurt pas bij packaging via `create-p2p-plugin sign` (content-hashes churnen bij elke build, dus niet in de dev-boom). Volgt samen met 2A/2B of een release-stap.
  - 2A Algemeen peer-app capability-model — GEDONE: remote-access authorization is now **platform-enforced at the TaskBroker** instead of a per-plugin convention. Nieuw `core/src/task-broker/remote-access.ts`: een skill declareert bij registratie een `remote` policy (`{ gate: "verified-contact" | "access-pass" | "any" | [...OR...], scope? }`); `handleRemote` evalueert die **vóór** dispatch — de handler draait nooit als de gate dicht is. Fail-closed op elke manier: netwerk-exposed skill (`localOnly: false`) **zonder** policy wordt geweigerd; `access-pass` vereist een `scope` (fout luid bij registratie); anonieme remote peer (geen transport-geverifieerde `peerId`) kan nooit aan `verified-contact`/`access-pass` voldoen; ontbrekende `RemoteGate` = deny; een gooiende gate opent de deur niet. `any` (expliciet publiek) vereist een extra manifest-permissie `network:public:<id>.<skill>` bovenop `network:skill:<id>.<skill>` (loader-afgedwongen). `SkillHandler` krijgt een tweede arg `{ peerId }` = de transport-geverifieerde caller (Fase 1B identity binding), nooit een caller-gesuppliede payload-waarde. Nieuw `core/src/task-broker/access-pass-manager.ts` + `ctx.access` (issue/revoke/hasPass): ephemeral, scoped, expiring per-peer passes in één core store die zowel `ctx.access` als de broker-gate deelt. `PluginHost` injecteert de `RemoteGate` (late-bound contacts lookup + access-pass store). Migratie: peersite `fetchAsset` → gate `["verified-contact","access-pass"]` scope `"site-read-only"`, plugin-eigen pass-store vervangen door `ctx.access`, plugin-level `provePossession` verwijderd (possession bewijst nu het transport); `status`/`signAuthChallenge`/`requestAccess` + `contacts.signChallenge` + `chat.receiveMessage` + `calendar.listEvents` + testlab `echo`/`forward` + `core.echo` → expliciete `any`-policy (bestaand gedrag behouden, nu expliciet + `network:public`-permissie). Tests: broker-gate (deny/allow/fail-closed/anoniem/geen-gate/OR/`any`/peerId-context/gooiende gate), access-manager (scopes, TTL, revoke, validatie), loader (`network:public` verplicht bij `any`, `ctx.access` gedeeld), en de **2A-toetssteen** in `apps/testlab/src/peer-app.test.ts`: A publiceert een lokale dir als P2P-site, B (verified contact) haalt assets op via het P2P-protocol, C (vreemdeling) wordt geweigerd — óók met gespoofde payload-peerId — en krijgt na een menselijk goedgekeurde knock een access pass waarmee wél. Volle suite groen op Linux én Windows (3-OS CI-matrix).
  - 2B Plugin security voor derde partijen — GEDONE (Scoped 2B, **Optie 1: capability-matrix-verscherping zonder proces-isolatie**, expliciet geaccordeerd; harde OS-isolatie is een documented accepted risk naar Fase 3 — de vertrouwensgrens blijft: Ed25519-sleutelbezitter = in-process toegang). De capability-matrix is de autoriteitsgrens, structureel afgedwongen op elke surface die eerder op documentatie/aannames leunde. Wat in zit:
    1. **HTTP-bridge opt-in** — `httpExposed: true` vereist nu een expliciete manifest-permissie `network:http:<id>.<skill>` vóór laden (los van `network:skill`/`network:public` — onafhankelijke surface, eigen gate; CLAUDE.md-principe #1). Eerste-partij-plugins: calc (12), paint (9), notepad (5), ens (2), calendar (3), peersite (2).
    2. **`ctx.dataDir`-scoping** — plugins krijgen `<dataDir>/plugins/<pluginId>`, nooit de host-datadir; `isPathInsideDataDir` (trailing-separator-geankerd, realpath-aware, symlink-onveilig → lexicale fallback) beschermt de échte datadir tegen paden die een plugin user-supplied mag valideren (PeerSite root).
    3. **Cross-namespace `hooks.on` gating** — `on` vereist `hooks:on:<event>` bij een ander namespace (delimiter-geankerd `<id>:`-prefix); eigen namespace blijft vrij. Chat + `hooks:on:tasks:taskUpdated`, birthday-cards + `hooks:on:calendar:eventAdded`.
    4. **`ctx.identity` structurele domain separation** — `sign(domain, data)`/`verify(pub, domain, data, sig)` met **verplicht domein** dat core prependt (`domain || data`); een plugin kan nooit raw caller-gekozen bytes tekenen. Wire-bytes identiek aan de historische `p2p-hub:*:v1:`-contexts (interop behouden); domeinconstanten blijven en worden nu als domein-argument doorgegeven.
    5. **Plugin-UI-server (`/ui/<pluginId>/*` in core-server)** — statische UI-assets uit de plugin-dir (root = dir vóór `ui.entry`, containment via `resolveAndContainFile`: traversal/dotfiles/backslashes/NUL/symlinks → 404), hardened CSP (`default-src 'none'; connect-src 'none'; script-src 'self'; ...` + `no-store`), loopback-gate achter `lanSiteAllowed`, alleen GET/HEAD. **Bewuste afwijking van de eerdere "boot-token"-notitie**: `/ui` wordt ZONDER boot-token geserveerd (net als `/site`) — een boot-token in de iframe-URL is leesbaar door de plugin-UI-code zelf, en daarmee zou een sandboxed plugin elk willekeurig `/api/*`-skill kunnen aanroepen (het hele shell-bridge-allowlist omzeild). `/ui` serveert alleen publieke plugin-assets; elke capability-aanroep vereist elders nog het boot-token. `ui.entry`-containment + `ui.skills`-schema worden in de loader structureel gevalideerd.
    6. **Plugin-UI bridge (shell)** — sandboxed iframe (`allow-scripts allow-same-origin`, géén allow-top-navigation/forms/popups; cross-origin geladen van de core-server-origin, nooit van de shell-origin, dus geen shell-DOM-toegang) + **origin-gepinde** `plugin-bridge.ts`: inbound alleen bij exacte `event.origin === CORE_ORIGIN`, outbound met `targetOrigin = CORE_ORIGIN` (nooit `"*"`), en een **manifest-gedeclareerde skill-allowlist** (`ui.skills` — een UI kan alleen skills aanroepen die het manifest expliciet opgeeft; geen `"*"`, geen full-skill-list). `ui.skills`-entries moeten in de eigen namespace liggen én een matching `network:http:<entry>`-permissie hebben (loader-afgedwongen). Capabilities exposen `ui: {entry, defaultWidth, defaultHeight, skills}`. StartMenu opent UI-plugins in een window met de manifest-afmetingen.
     Tests: 484 / 0 failures (was 466). Deelnemende surfaces per nieuwe grens: loader (http-permissie, dataDir-scoping, hooks.on, ui.skills, ui.entry), core-server (`/ui` CSP/containment/loopback/no-token), plugin-host (`pluginUiRoot`), peer-auth (domeinverplicht signer/verify + `buildKnockData`), shell (typecheck). Volgende follow-up: Fase 3 OS-isolatie (proces-level sandbox) als aparte fase; `network-light` mDNS-skill-naam-lek (bekende open follow-up) nog open.
  - **2-Eindcriterium P2P Static Website (`p2p-hub:website:v1`) — GEDONE** — de verticale slice "Peer A exposeert een lokale directory als P2P-website; Peer B mirror+fetcht en rendert die in de sandboxed UI" bovenop de bestaande security-architectuur (TaskBroker als enige enforcement point, verified-contact/access-pass-gate, `resolveAndContainFile`, atomic-writes, 2B-principe #10). Wat erin zit:
    1. **SDK wire-contract** (`sdk/src/website-contract.ts`) — `p2p-hub:website:v1`: request `{protocol, version, path}`, success/error-responses, canonieke serialisatie (vaste key-volgorde, gepinde bytes), default-deny (vreemd protocol/versie → `unsupported-version`; key-set/type/lengte → `malformed`; gesmokkelde `peerId`-veld → `malformed`), `MAX_WEBSITE_PATH_LENGTH` (256) en `MAX_WEBSITE_ASSET_BYTES` (128 KiB). Binaire assets als base64 in het `data`-veld.
    2. **Peer A (versioned enforcement)** (`plugins/peersite`) — `fetchAsset`-handler parsed het envelop-payload na de broker-gate op de transport-geverifieerde caller; stat-check vóór readFile + per-asset cap (oversized → `payload-too-large`, nooit truncatie); fout-string-mapping naar versie-codes. Gate blijft `["verified-contact","access-pass"]` scope `site-read-only`.
    3. **Atomic binary mirror** (`core/src/site/site-mirror.ts`) — `mirrorDestination` = write-side containment (dot-segments/dotfiles/backslashes/NUL default-deny, trailing-separator-geankerd, géén realpath-vereiste zodat een miss na fetch kan schrijven); `mirrorFetchAndStore` decodeert base64, schrijft atomic via `atomicWriteFile` (nu `Uint8Array`-ondersteunend, bytes blijven byte-exact), bestandsnaam uitsluitend uit B's eigen requested path (peer-`name` genegeerd — een hostile peer controleert nooit B's filenames), consumer-side cap.
    4. **Core-server `/remote-site/<peerId>/*`** — loopback/lanSiteAllowed-gate, GET/HEAD-only (405), peerId-RE + niet-bestaande mirror → 404, `resolveAndContainFile`-containment (traversal/encoded/backslashes/NUL → 404), hardened UI-CSP (incl. `connect-src 'none'`, `form-action 'none'`, `no-store`), **geen boot-token** (2B-principe #10 — de site-inhoud is niet geheim, de boot-token wel), fetch-on-miss naar `peersite.fetchAsset` (netwerk uit → stille 404), directory/index-fallbacks.
    5. **Shell viewer** — `SiteViewer`-component: sandboxed iframe (`allow-scripts allow-same-origin`, géén top-navigation/forms/popups) naar `/remote-site/<peerId>/`; **source-pinning** in `plugin-bridge.ts` (`bindSource`: alleen windows die de shell zelf bond mag de bridge aanroepen — de remote-site deelt de core-server-origin met plugin-UI maar krijgt nooit een binding, dus kan nooit `ui.skills`/bridge-capabilities aanroepen); vite-proxy `/remote-site`; StartMenu "View site"-entry bij peers die `peersite.fetchAsset` exposen.
    6. **Tests** — SDK 58, core 217, core-server 57, peersite 19, testlab 3 (Fase 2A-toetssteen gemigreerd naar envelopevorm + nieuwe website-v1-matrix: byte-exacte PNG, unsupported-version, malformed, traversal, oversize, expired/revoked pass). Topologie-agnostiek gedekt door de bestaande chained-call (A→B→C via `testnode.forward`) — geen relay/shard gebouwd (geaccordeerde minimale mirror).
     Open follow-ups: cross-origin `fetch`/subresource-bundling voor sites (nu één asset per request + `<link>`/inline), optionele `contentHash`-veld per asset voor B's cache, en render-time verrijking van de mirror-CSP met `img-src`-allowlist per site.
  - **Stap 2 — `checkPeerAccess` centrale security-primitive — GEDONE** (`core/src/security/peer-access-gate.ts`): één fail-closed evaluatie-primitive die de peer-level toegangsbeslissingen centraliseert en PeerSite's hand-gerolde `isVerifiedContact`/`hasValidAccessPass` vervangt. `checkPeerAccess(peerId, options, context)` evalueert OR-semantiek over `options.modes` (`verified-contact` / `access-pass` / `open-lan`|`public`), met optioneel `allowSelf` (host-own peerId ⇒ `self`, alleen uit `context.selfPeerId`, nooit van de caller). Rede-set: granted = `verified_contact|valid_access_pass|public_policy|self`; denied = `not_a_contact|invalid_access_pass|expired_access_pass|denied_by_policy`. Fail-closed op elke manier: ontbrekende/ongeldige options of lege `modes` ⇒ `denied_by_policy`; een werpende lookup is een denial, nooit een open deur; `blocked`-contact wint zelfs over `open-lan`/`public` (blacklist boven permissiviteit). Eerlijk expired-vs-ongeldig-onderscheid via nieuwe `AccessPassManager.inspectPass` (report-only `"none"|"valid"|"expired"`; `hasValidPass` dropt expired wél, `inspectPass` niet). **Bewust GEEN `accessPassToken`/bearer-token-variant uit het oorspronkelijke design-voorstel** (CLAUDE.md: passes zijn nooit bearer tokens — de peer bewijst possession over het transport) — peerId-gebonden `hasPass`/`inspectPass` in plaats daarvan. Peersite-refactor: `fetchAsset`-gate → `checkPeerAccess` met `{ modes: ["verified-contact","access-pass"], accessPassScope: "site-read-only" }`; de media-gate is bewust NIET mee overgezet (Tier-2 native-confirm, geen policy-evaluatie — mens uit de lus vermijden). Publiek via `@p2p-hub/core`. Tests: 21 in `core/src/security/peer-access-gate.test.ts` + 2 access-pass-manager-tests; peersite 19/19 + core-server-peersite 14/14 ongewijzigd groen (geen regressie). Follow-up: broker-`RemoteGate` (`remote-access.ts`) migreren naar dezelfde primitive — vandaag een eigen OR-implementatie met identieke semantiek.
- **Fase 2-eindcriterium — vier-assen-scheiding (architectuur-richtlijn)**
  De introductie-prompts leggen vier orthogonale assen vast die toekomstig werk moet behouden: **Identity** (wie is de peer — Ed25519 peerId, contactrecords, straks ENS als naamresolver), **Capability** (wat mag die peer doen — capability-naamconventie `p2p-hub:<cap>:v1`, default-deny, TaskBroker-gates), **Transport** (hoe praat ik met die peer — `network-light` TLS vandaag, WebRTC = transport-implementatie, nooit in de capability-laag), **Content** (welke assets — website = content/assets, apart van authorisatie).   Mens én agent zijn peers (default-deny blijft); de world-topology wordt geabstraheerd (relay/forward is een transport-zaak, geen capability-zaak); géén speculatieve dependencies nu. Drie bijbehorende architectuurbesluiten (agent-identiteit, media-gate, telemetrie-type-onderscheid) zijn formeel vastgelegd — zie [Toekomstige Capabilities: Agent Identity & Streaming Guidelines](#toekomstige-capabilities-agent-identity--streaming-guidelines) hieronder.
- **Stap 4 — `p2p-hub:media:v1` sessie-capability — GEDONE (`713d0c5`)** — de grant-only media-flow van Slice 3 uitgebreid tot een sessielevenscyclus over dezelfde fail-closed gates. `plugins/media` (nieuw): `requestSession`/`closeSession`/`getStreamStatus` met `kind: "camera"|"microphone"`, sessies per-request gegeneerd met `MediaGate` (via `checkPeerAccess`) én per-request `TelemetryGate`-frequentie-cap voor actieve sessies; alle sessions-skills `httpBridgeOnly: true` (lokale operator-oppervlakte, structureel nooit peer-facing) + `localOnly: true`. Stream-transport blijft buiten scope (een grant/sessie is het geverifieerde oordeel dat een toekomstig transport consumeert). `core/src/security/index.ts` exporteert `TelemetryGate`; core-server-glue (`apps/core-server/src/media.ts` + `registerMediaAccessHandler`) + handleiding `manuals/06-p2p-media-en-sessies.md`. Tests: media 3/3, core-server 92/92, alles groen.
- **Netwerklaag — one-sided mDNS-discovery-fix + config-fallbacks — GEDONE (`f030d3b`)**: root cause van de Windows one-sided discovery: `multicast-dns` default-interface is `"0.0.0.0"` op non-darwin, zodat de OS een virtuele adapter (Hyper-V/WSL/VPN) kon kiezen i.p.v. de fysieke NIC. `detectLanIPv4()` (`plugins/network-light/src/lan-interface.ts`) kiest de fysieke LAN-IPv4 (skips virtuele adapters, prefereert RFC1918, deterministische tie-break) en wordt als `interface` door `bonjour-service` → `multicast-dns` gegeven, die daarmee `addMembership` + `setMulticastInterface` stuurt; de socket bindt wél wildcard (`bind: "0.0.0.0"`) zodat loopback-multicast (in-process peers) blijft werken — een specifieke-interface-bind breekt dat (empirisch geverifieerd). **Proactieve peer-handshake**: een gehoorde mDNS-announcement triggert een throttled unicast `hello`+`auth` terug naar de zender (peer registreert ons ook als onze eigen uitgaande multicast geblokkeerd is); `hello` kreeg optionele, strikt gevalideerde reverse-registratie-hints (`instanceId`, `listenPort`). **Reverse-registratie (default-deny)**: een inbound client wordt pas na `auth`-verificatie in de discovered-map gezet (route = `remoteAddress:listenPort`, peerId = geverifieerde auth-identiteit, cert = gepresenteerd cert). Config-loader (`apps/core-server/src/config.ts`): `P2P_HUB_PORT`→`PORT`→8788, `P2P_HUB_P2P_PORT`→`P2P_PORT`→32837, `P2P_BIND_HOST` default `0.0.0.0` (alleen P2P-transport), `P2P_ENABLE_NETWORKING`/`P2P_HUB_NETWORKING` boolean-parsed; de HTTP/WS-bridge-host blijft loopback-by-default achter `P2P_HUB_EXPOSE=1` (die vertrouwensgrens is niet aangeraakt). Tests: lan-interface 6, wire-contract hints 3, provider reverse-registratie/unicast-reply/default-deny 3, config 6.
- **Netwerk-wiring core-server — `ctx.network` resolveert nu echt — GEDONE (`54e5630`), live getest**: diagnoseraad gaf een exacte treffer — géén netwerkfout, maar een architecturale injectie-bug. `CoreServer` boot z'n `PluginHost` zonder `enableNetworking` (host start geen eigen transport) en registreerde de `NetworkLightProvider` alleen in z'n eigen `this.registry`. Plugin-`ctx.network` is een **live referentie** naar de *host*-netwerk-registry (`buildNetworkCapability` lost per call `selectActive()` op), dus die registry bleef leeg → elke plugin zag "no active network provider" ondanks een gezonde transport. Fix: dezelfde provider óók in `host.networkRegistry()` registreren (en unregisteren bij stop); exact één provider in het proces. `contacts.verifyPeer` → `ctx.network.sendTask` routeert nu over het echte transport. **Integratietest** (`apps/core-server/src/contacts.test.ts`): CoreServer (networking:true) + tweede PluginHost-peer met contacts, wacht op mDNS-discovery, `verifyPeer` over HTTP → `{ verified: true }` + contact gepromoveerd naar `"verified"`. Geverifieerd: zonder de wiring faalt de test exact met `error: 'no active network provider'`; met de fix slaagt hij (skip op darwin, zelfde mDNS-CI-regel). Dezelfde test bevat een **end-to-end transportsmoke in de tegenrichting**: de peer-node roept via z'n eigen transport `core.echo` (`localOnly: false`, `remote: gate "any"`) op de CoreServer aan en krijgt de payload onveranderd terug — het volledige rondje discovery → TLS+identity-binding-handshake → broker-dispatch, onafhankelijk van de contacts-plugin. Noot: `ctx.network` is nooit `null` (altijd de live capability — lege registry ⇒ graceful fout), en er is geen `getNetworkProvider()` op ctx; het contacts-manifest declareert al alle benodigde `network:skill`/`network:public`/`network:http`-permissies.
- **Stap 5 — Distributed Subscriptions & Event Framing (P2P pub/sub) — IN UITVOERING (deelopdracht 1 GEDONE, deelopdracht 2 GEDONE, deelopdracht 3 GEDONE, deelopdracht 4 GEDONE)** — een capability-gerichte Pub/Sub-laag bovenop het bestaande `network-light`-transport, structureel klaar voor de streaming-richting van "Besluit 3" (hoogfrequente events vallen onder de TelemetryGate, niet onder de broker-taak-limiter). Geaccordeerde schikkingen: hub in **`core/src/events/`** (het spec-pad `packages/events` bestaat niet als workspace; `core` is de centrale gedeelde-laag naast hook-registry/security) en per-topic-autorisatie **uitsluitend via `manifest.exposedEvents`** (het spec-vermelde CapabilityRegistry bestaat niet; `exposedEvents` is de declaratieve source of truth — géén nieuw parallel registry-concept). De vier security-refinements van de review (per-topic-auth, TelemetryGate, publisherPeerId-provenance, wildcard-re-auth + caps) zijn hieronder verwerkt.
  - **Transport-frames (deelopdracht 1) — GEDONE** — drie nieuwe message-types in de `p2p-hub:network`-envelop (`plugins/network-light/src/wire-contract.ts`), elk alleen na een geverifieerde `auth` (dezelfde fase-discipline als `task`; frames vóór `auth` ⇒ close):
    - `sub_req` (subscriber → publisher): `{ subscriptionId, topic, action: "subscribe"|"unsubscribe", ttlMs? }`
    - `sub_ack` (publisher → subscriber): `{ subscriptionId, topic, accepted, reason?, ttlMs? }`
    - `event_emit` (publisher → subscriber): `{ subscriptionId, topic, publisherPeerId, timestamp, sequenceNumber, payload }`
    Canonieke veldvolgorde + gepinde bytes in tests; `subscriptionId`/`topic` strikt gevalideerd (RE's + lengte-bounds), topic-vorm = bestaande hook-conventie (`<ns>:<name>`, optioneel afsluitend `:*`-wildcard; delimiter-geankerd — CLAUDE.md #2).
  - **Hub & adapter in `core/src/events/` (deelopdracht 2)** — `SubscriptionHub`: remote-subscriptions *naar ons* — SUB_REQ-gate (zie autorisatie), opslag `topic → Map<subscriptionId, PeerSubscription>`, TTL-timers/heartbeat-refresh, wildcard-registratie, caps; `emitLocal(topic, payload)` = exposure-check + EVENT_EMIT-fan-out naar exacte én wildcard-subscribers. `RemoteEventAdapter`: local-subscriptions *naar remote peers* — `subscribeRemote`/`unsubscribeRemote` (sendSubReq + SUB_ACK-afhandeling + periodieke re-subscribe-heartbeat) en inbound EVENT_EMIT → TelemetryGate → handler-dispatch. Beide achter dezelfde `EventNetwork`-interface (duck-typed op de actieve provider via de registry-getter); publiek via `@p2p-hub/core`.
  - **Per-topic-autorisatie = `exposedEvents`-only (refinement #1)** — een topic is remote-subscribable alleen bij **exact-match** in de `exposedEvents` van de uitgevende plugin; alles anders = default-deny (`sub_ack { accepted: false, reason: "topic-not-exposed" }`). `checkPeerAccess` is de peer-level laag eronder (mode configureerbaar, default `["open-lan"]`: elke transport-geverifieerde, niet-geblokkeerde peer — de topic-exposure zelf is de capability-gate; verfijnd via `modes` waar nodig). Géén nieuw "capability scope"-concept.
  - **`event_emit` loopt door `TelemetryGate` per (peer, topic)-channel, aan beide kanten (refinement #2)** — niet de per-peer taak-rate-limiter (laagfrequent afgesteld). **Receiver-side**: inbound-dispatch in `RemoteEventAdapter` checkt `(peerId, topic)` vóór de handler. **Sender-side**: `SubscriptionHub.emitLocal` checkt dezelfde gate per (subscriber, topic)-channel vóór de wire-send, zodat een hete publisher-topic een peer ook op de draad niet kan overspoelen. Overflow **dropt** aan beide kanten (queuet/spamt/sluit nooit; een dropped frame verhoogt de per-subscription `sequenceNumber` niet — de ontvanger ziet geen gat dat er niet was); `PeerStreamViolationError` + channel-pinch >2x cap. Budget configureerbaar via `emitTelemetry` (default `DEFAULT_STREAM_RATE_CONFIG`).
  - **`publisherPeerId` is nooit een vertrouwd loose field (refinement #3)** — transport-level afgedwongen: de provider sluit de verbinding wanneer het wire-veld ≠ de Fase-1B-geauthenticeerde connection-peerId; de adapter her-checkt (defense-in-depth). V1 = directe publisher→subscriber, **géén relay**: een event C-via-B-naar-A zou een aparte publisher-signatuur vereisen (expliciet genoteerd als niet-gebouwd; transport-auth dekt C's claim dan niet langer).
  - **Wildcards per-topic geherauthoriseerd bij emit (refinement #4a)** — een `calendar:*`-subscription wordt bij subscribe alleen geregistreerd (geen topic-lek), maar élke daadwerkelijke `emitLocal` checkt het exacte topic tegen `exposedEvents` vóór distributie — exact én wildcard-subscribers krijgen een niet-exposed topic nooit.
  - **Harde caps + TTL-bounds (refinement #4b)** — `MAX_SUBSCRIPTIONS_PER_PEER` (64) en `MAX_SUBSCRIPTIONS_PER_TOPIC` (128); overschrijding ⇒ `sub_ack`-reject `"subscription-cap"` (SUB_REQ-flood = resource-exhaustion-vector). `ttlMs` gecapt op `MAX_SUBSCRIPTION_TTL_MS` (5 min), default 60s, lazy+interval-sweep.
  - **Context-wiring (deelopdracht 3) — GEDONE** — `ctx.events` (`publishRemote(topic, payload)` / `subscribeRemote(peerId, topic, handler)` / `unsubscribeRemote(subscriptionId)`) op PluginContext. `publishRemote` is namespace-gebonden (eigen `<pluginId>:`-prefix, zelfde rule als `hooks.emit`). PluginHost bouwt de hub+adapter **lazily** (`ensureEventLayer`, gememoïseerd — een host die nooit events aanraakt bouwt niets) en zet `setExposedEvents` = unie van alle plugin-`exposedEvents` na load (én na elke load, zodat een vroeg-geactiveerde plugin de latere exposure direct ziet). Zowel hub als adapter zitten achter dezelfde `EventNetwork`-interface, die de actieve provider per call via de registry-getter duck-typed (`lazyEventNetwork`), zodat een provider die na de layer-build start/startte live wordt opgepikt. `startNetworking` (host én core-server) attach de `onEventMessage`-routing (sub_req → hub, event_emit → adapter) aan de provider via `PluginHost.wireEventsToProvider` — de core-server registreert z'n provider al in de host-registry, dus dezelfde layer bedient beide. De loader krijgt een **lazy `EventLayerResolver`** (niet concrete instanties): een plugin die lang na boot subscribe/publish doet, ziet de echte layer; een bare `loadPlugin` zonder host faalt closed (`TopicNotExposedError`/`SubscriptionRejectedError`), nooit een `null`-veld. Sandbox-`ctx`-shim heeft een fail-closed `events`-stub (`SandboxCapabilityUnavailableError`, getest).
  - **Tests (deelopdracht 4) — GEDONE** — unit: SubscriptionHub (SUB_REQ-gate: not-exposed / not-authorized / cap-denied, TTL-expiry + re-subscribe-refresh, wildcard `calendar:*`-matching + emit-time-re-auth, per-peer/per-topic caps — topic-cap-geval draait over 3 peers want de per-peer-cap (64) zit vóór de per-topic-cap (128)), RemoteEventAdapter (subscribe→ack-ok, reject-afhandeling, unsubscribe, inbound-dispatch, publisherPeerId-mismatch-drop, TelemetryGate-drop), wire-contract (gepinde bytes sub_req/sub_ack/event_emit, default-deny vóór `auth`, malformed ⇒ close). Integratie (`core/src/plugin-host/plugin-host-networking.test.ts`, darwin-mDNS-skip): twee PluginHost-instances (`enableNetworking`) — viewer subscribes `sensor:update` op sensor, sensor emitt via `ctx.events.publishRemote`, viewer ontvangt beide payloads in volgorde met monotone `sequenceNumber` en geverifieerde `publisherPeerId`; negatief-geval: niet-exposed subscribe ⇒ `SubscriptionRejectedError` (géén event ooit gedispatched) en niet-exposed publish ⇒ `TopicNotExposedError`. `npm run build && npm test` 100% groen (alle 21 workspaces-suites).

## Toekomstige Capabilities: Agent Identity & Streaming Guidelines

Formeel vastgelegde architectuurbesluiten. **Status: besluit 1 gebouwd (A1 Slice 1 + 2,
`ed26400` + volgend), besluit 2 gebouwd (A1 Slice 3), besluit 3 gebouwd (A1 Slice 4).** Details en slice-plan:
`docs/agent-identity-streaming-design.md`.

### 1. Agent-identiteit: eigen, afgeleide PeerID (child-keypair)

- **Vraagstuk:** krijgt een AI-agent de peerId van zijn menselijke operator, of heeft
  een agent een eigen, unieke identiteit?
- **Besluit:** een agent krijgt **altijd een eigen, afgeleide identiteit**
  (child-keypair / aparte IdentityManager-instantie). Een agent mag nooit de
  identiteit (peerId) van de menselijke operator hergebruiken.
- **Onderbouwing:**
  - *Auditability & non-repudiation:* in logs en audit-trails moet direct herleidbaar
    zijn of een actie door de mens via de UI is uitgevoerd, dan wel geautomatiseerd
    door een agent.
  - *Gedifferentieerde trust-gates:* een `sendTask`/execute-skill vanuit een agent heeft
    een ander risicoprofiel dan een handmatige menselijke actie. Gevoelige capabilities
    (zoals een vault-write of het starten van een P2P-transactie) kunnen voor agenten
    een veel strengere autorisatiedrempel of expliciete menselijke goedkeuring vereisen.
  - *Geen agent-bypass:* agenten lopen onverkort door het bestaande default-deny
    capability-model. Het bezitten van een agent-identiteit geeft geen automatische
    omzeiling van access-passes of contact-gates.
- **Vastleggingseis:** bij elke toekomstige uitbreiding aan de IdentityManager blijft
  de mogelijkheid tot het genereren van afgeleide child-keys geborgd.

#### Implementatiestatus (A1, Slice 1 + 2)

- **Slice 1 (kind-keys, gebouwd):** `deriveChildIdentity`/`getChildIdentity`/
  `listChildIdentities`/`deleteChildIdentity` op `IdentityManager`; deterministische
  HKDF-kind-derivatie (PKCS8-seed), parent-ondertekend certificaat
  (`p2p-hub:agent-identity:cert:v1`) voor registry-vrije auditability; vault-isolatie
  onder het gereserveerde `identity.agent.*`-prefix.
- **Slice 2 (operator-wiring + gedifferentieerde trust, gebouwd):**
  - CRUD-API op de HTTP-bridge (boot-token guarded): `GET /api/agents`,
    `POST /api/agents {label}`, `DELETE /api/agents/:label`. Alleen publiek materiaal
    (peerId, publicKeyHex, certificaat, `createdAt`) — de private key verlaat
    `IdentityManager` nooit; labels door `isValidAgentLabel`.
  - `TaskBroker`-escalatiematrix (gelaagde agent-policy), vóór dispatch geëvalueerd
    door de broker:
    - **Tier 1 — telemetry:** `remote.agent.level: "telemetry"` → normale gate
      (verified-contact/access-pass) is voldoende, geen goedkeuring.
    - **Tier 2 — discrete acties (default `approved`):** normale gate + per-invocatie
      native menselijke goedkeuring (`TaskApprovalGate`, fail-closed zonder confirmer).
    - **Tier 3 — kritiek:** `remote.agent.level: "never"` → altijd geweigerd; de
      `any`-gate autoriseert een agent structureel nooit.
  - Audit-velden op de handler-context: `initiatedBy: "operator" | "agent"` +
    `agentLabel` — platform-uitspraak op basis van de transport-verified `peerId`,
    nooit een caller-supplied veld.
  - Agent-registratie = de lokale kind-identiteiten van de operator; cross-node
    herkenning (buitenlands kind-certificaat importeren) is een latere slice.

### 2. Media-capabilities (camera/microfoon): Tier-2 native-confirm-gate

- **Vraagstuk:** is de standaard browser-popup
  (`navigator.mediaDevices.getUserMedia()`) voldoende voor P2P-video en -audio?
- **Besluit:** nee. Het opvragen van live camera-/microfoontoegang door een remote peer
  valt onder de **hoogste beveiligingsklasse (Tier-2 native confirm flow)**.
- **Onderbouwing:** de standaard browser-popup beschermt tegen "een website wil je
  camera gebruiken", niet tegen "een P2P-peer op het netwerk vraagt een live
  biometrische videostream". Het starten van een P2P-mediastroom moet door dezelfde
  native bevestigingsflow van de shell lopen als execute-skill, vault-access of
  `peersite.requestAccess`. Een P2P-media-request mag nooit via een lichter
  "browser-popupje" worden afgewikkeld.

#### Implementatiestatus (A1, Slice 3)

- **Gebouwd:** `p2p-hub:media:v1` wire-contract in de SDK
  (`sdk/src/media-contract.ts`: fail-closed parsing, canonieke bytes, geen
  identity/token-velden op de wire); nieuw `media-access-request` prompt-kind in
  `TrustTierGate` via `confirmMediaRequest` (mirrors `confirmPeerAccess`);
  `core.media.request`-skill in `apps/core-server/src/media.ts`. De skill:
  - parsed de envelope fail-closed (typed error, nooit doorlaten);
  - vereist een transport-verified `context.peerId` (Fase 1B-identiteit; een
    anonymous/caller-supplied identiteit wordt geweigerd);
  - gate elke grant door `confirmMediaRequest` — geen confirmer, een denial of
    een throw ⇒ `denied` (fail-closed);
  - `remote: { gate: "verified-contact" }` (media is gevoelig: alleen een
    gevestigde relatie bereikt de native prompt);
  - is niet HTTP-geëxposeerd (de lokale HTTP-bridge is geen media-request-oppervlak);
  - heeft een per-peer cooldown tegen prompt-spam.
  De eigenlijke stream-transport is buiten scope; een grant is het geverifieerde
  oordeel dat een toekomstig transport zou consumeren.

### 3. Real-time traffic patterns vs. discrete acties

- **Vraagstuk:** de huidige rate-limiting (zoals de broker-concurrency-cap of
  peersite-knock-limits) is ontworpen voor laagfrequente, gevoelige acties. Hoe
  verhouden high-frequency 3D-updates (20x/sec) zich hiertoe?
- **Besluit:** de capability-abstractie krijgt een **expliciet type-onderscheid tussen
  "Discrete Acties" en "Lichte Telemetrie/Streams"**.
- **Onderbouwing:** een `world:v1`-capability die 20 posities per seconde per speler
  rondstuurt, verdraagt de bestaande request/response rate-limiters niet. Kopieer de
  bestaande rate-limit-logica niet naar streaming-capabilities. Voor telemetrie geldt
  een **frequency-cap per peer** (bandwidth/message throttling) in plaats van een
  payload-size- of knock-limit-check.

#### Implementatiestatus (A1, Slice 4)

- **Gebouwd — capability type-split:** `CapabilityType = "action" | "telemetry"`
  (`sdk/src/capability.ts`). Registratie-expliciet op `SkillRegistrationOptions
  .capabilityType`; ontbrekend of ongeldig ⇒ fail-closed `"action"` (nooit
  verwijding). `TaskBroker.listSkills()` en de HTTP-bridge
  (`/api/capabilities`) exponeren het type.
- **Gebouwd — per-peer telemetry frequency-cap:** `TelemetryRateLimiter`
  (`core/src/task-broker/telemetry-rate-limiter.ts`): in-memory sliding window
  per transport-verified `peerId` × skill (anonieme remote callers delen één
  budget, zodat een public `any`-gated telemetry-skill niet te floden is);
  buckets worden gesweept per window (geheugengebonden). De limiter draait in
  `TaskBroker.evaluateRemotePolicy` als **laatste stap na de gate + agent-matrix**:
  geweigerde callers verbruiken geen budget, en een rate-limited call bereikt de
  handler nooit. Overflow ⇒ getypeerde `TelemetryRateLimitExceededError` /
  `code: "telemetry-rate-limit"` op de `TaskResult` (te onderscheiden van een
  gate-denial). Fail-closed: telemetrie is ook zonder expliciete config
  rate-limited (`DEFAULT_TELEMETRY_RATE_LIMIT`).
- **Bestaande capabilities gelabeld:** `core.echo`, `core.ai.generateText`,
  `core.media.request`, alle peersite-skills ⇒ `action`; `peersite.status` ⇒
  `telemetry` (public read-only probe, nu per-peer capped).
- **Scope-notitie:** dit is de request/response-instantie van Besluit 3. De
  transport-level frequency-cap voor continu stromende frames (bv. 20 Hz
  positie-updates) is een latere uitbreiding; de broker-limiter dekt vandaag de
  Tier-1 telemetry-calls.

## Fase 3: plugin-isolatie via child-proces (proces-isolatie, GEEN OS-level sandbox)

Na 2B (capability-matrix-verscherping) en het agent-identiteit/media/telemetrie-werk
(A1) is proces-isolatie de volgend geaccordeerde stap. **Belangrijke naamgeving**:
dit is *process isolation voor crash/abuse-containment*, géén OS-level security
sandbox — een plugin in het child-proces draait nog steeds als dezelfde OS-user
met volledige `require("fs")`/`require("net")`/`require("child_process")`-toegang
binnen dat proces. De `ctx`-shim fail-closed de plugin-facing capability-API maar
restrict de Node-module-loader niet (geen `--experimental-policy`, geen
`--permission`-model). De vertrouwensgrens blijft "Ed25519-sleutelbezitter =
in-process toegang"; de isolatie beschermt de host tegen een *kapotte/kwaadaardig
misbruikende* plugin (crash, hang, geheugen, spin) maar niet tegen een plugin die
bewust OS-calls doet. Uitgevoerd in slices; Slice 1 is de dependency-vrije IPC
engine + wire protocol.

**Slice 1 (gebouwd): sandbox IPC engine (`core/src/sandbox/` + `sdk/src/sandbox/`)**

- **`sdk/src/sandbox/ipc-protocol.ts`** — strict, dependency-vrij JSON-RPC 2.0-subset
  met `type`-discriminator (`"request"|"response"|"notification"`). Fail-closed:
  `parseIPCMessageEnvelope` → `null` bij elke afwijking (verkeerde `jsonrpc`, onbekende
  `type`, niet-UUIDv4 `id`, response met beide/geen van `result`/`error`, malformed
  error-object, niet-structured `params`); `parseIPCMessageText` vertaalt de twee
  faalklassen naar getypeerde `IPCParseError` (`PARSE_ERROR` / `INVALID_REQUEST`).
  `IPCErrorCodes` scheidt JSON-RPC-standaardcodes (`-32xxx`) van IPC-specifieke
  (`1000` CHANNEL_CLOSED, `1001` FRAME_TOO_LARGE).
- **`core/src/sandbox/ipc-transport.ts`** — length-prefixed framing (4-byte BE + UTF-8
  JSON) over elke Readable/Writable (stdin/stdout, child-process stdio, PassThrough).
  Fragmentatie-veilig, backpressure via write-queue + `drain`, `maxFrameBytes`-cap
  vóór allocatie aan beide kanten. Malformed frame ⇒ fout + teardown (de proces-grens
  is de security-grens; een kapot frame breekt het kanaal af, nooit partieel
  gedispatcht). `send()` op gesloten kanaal ⇒ `CHANNEL_CLOSED`; oversize ⇒
  `FRAME_TOO_LARGE`.
- **`core/src/sandbox/runner.ts`** — process-side bootstrap-schel (Slices 2+ haken hier
  de PluginHost-spawner aan): `initialize`-request (validatie `pluginId` tegen de
  manifest-id-regel, optionele `envAllowlist`), `shutdown` ⇒ ack + exit(0), onbekende
  method ⇒ `METHOD_NOT_FOUND`. Crashes zijn gecontroleerd: `uncaughtException`/
  `unhandledRejection` ⇒ `sandbox:crash`-notification naar de host + exit(1), nooit
  stille dood. **Env-sandboxing** (`filteredEnv`): de sandbox erft nooit de ruwe host
  env — alleen allowlisted keys (default minimaal: PATH/HOME/LANG/TZ/…), en
  credential-lijkende keys (`secret|token|password|api[_-]?key|…`) worden altijd
  geweigerd als defense-in-depth.
- **Tests (37 nieuw, alle suites groen):** sdk 93 (+17), core 277 (+20), core-server
  73; protocol-parsing (valid/ongeldig, beide/geen result+error, id-vorm, error-object),
  transport (fragmentatie, meerdere frames per chunk, malformed frame ⇒ `PARSE_ERROR`
  zonder handler-dispatch, oversize ⇒ `FRAME_TOO_LARGE`, backpressure over een
  8-byte-highWaterMark-PassThrough, close-semantiek, failing writable ⇒ kanaal kapot),
  runner (echte child-process-integratie over stdio: initialize met gefilterde env,
  INVALID_PARAMS/METHOD_NOT_FOUND, shutdown-exit-0) + `filteredEnv`-units.

**Slice 2 (gebouwd): sandboxed plugin lifecycle + skill-dispatch (`core/src/sandbox/`)**

Besluit vóór aanvang: **`child_process.spawn()`, géén `fork()`** — fork's verborgen
`'ipc'`-kanaal omzeilt de length-prefixed framing (onze security-boundary); met plain
spawn + stdio-pipes is het framed protocol het *enige* kanaal tussen host en sandbox.
Mechanisme = **Optie 1 (minimaal & fail-closed)**: alleen skill-registratie/-executie
wordt geproxied; alle andere PluginContext-capabilities (`storage`, `vault`, `ai`,
`identity`, `hooks`, `network`, `access`, `trust`, `dataDir`, …) zijn in de sandbox
fail-closed afwezig (luide `SandboxCapabilityUnavailableError`) en worden in latere
slices per-stuk geproxied. Host-trust-regels: (1) registratieclaims uit het child
worden nooit vertrouwd — de host valideert tegen het zelf geladen `manifest.json`;
(2) PID/transport zijn strict aan `pluginId` gebonden (source-pinning), cross-plugin
spoofing onmogelijk; (3) TaskBroker blijft het enige remote/agent-authorization point
(evaluatie host-side vóór dispatch, nooit op een caller-supplied veld).

- **`core/src/sandbox/launcher.ts`** — `spawnSandboxProcess({ pluginRoot, envAllowlist?,
  maxFrameBytes?, heapSizeMb? (default 256), runnerPath?, stderr? })`. Hardening-vlaggen:
  `--no-addons` (geen native `.node`-escape), `--disallow-code-generation-from-strings`
  (`eval`/`new Function` ⇒ throw), `--max-old-space-size=<cap>` (heap-cap). `NODE_OPTIONS`
  wordt *altijd* gestript (geen `--require`/`--import`-preload-erfenis van de host), ook
  als iemand het allowlist; env = `filteredEnv(envAllowlist)`. stderr-forwarding optioneel.
- **`core/src/sandbox/runner.ts`** — niet meer alleen schel: laadt nu de plugin zelf.
  `readSandboxManifest` (id tegen de manifest-id-regel, entry niet-escape uit de dir),
  entry via **plain Node `require`** (geen module-loader-restrictie — de child heeft
  gewoon `require("fs")`/`require("net")`/`require("child_process")`, zie de
  naamgeving hierboven), `resolveSandboxActivate` (CJS `{ default }` / dynamic-import-genest),
  `activate(ctx)`. **Fail-closed `ctx`-shim**: echt = `skills.register/unregister`
  (child→host request `skill:register` met `{ skill, options }`, wacht op ack),
  `timers` (setTimeout/setInterval → Disposable), `onDispose`; stubs = `storage`/`hooks`/
  `ai`/`vault`/`identity`/`access`/`isPathInsideDataDir`/`dataDir` werpen
  `SandboxCapabilityUnavailableError`; `network`/`trust` = null (zelfde absent-signaal als
  in-process). **In-flight skill-ops worden vóór het `initialize`-antwoord afgewacht**
  (echte plugins roepen `ctx.skills.register` fire-and-forget; de sandbox mag pas
  "geïnitialiseerd" melden als de host-goedgekeurde registraties lokaal zichtbaar zijn,
  anders kan de host naar een nog-niet-geregistreerde skill dispatchen). Requests:
  `initialize` (manifest-id-mismatch-check, entry-containment), `invokeSkill`
  (depth-revalidatie over de proces-grens, handler-throw ⇒ `{ ok:false, error }` — de
  sandbox blijft up —, result opnieuw geserialiseerd: non-serializable ⇒
  `{ ok:false, error }`, sandbox overleeft), `sandbox:heartbeat` ⇒ `{ pong: true }`,
  `shutdown` ⇒ ack + exit(0); onbekend ⇒ `METHOD_NOT_FOUND`. `console.log/…` ⇒ stderr
  (stdout blijft pure IPC-pipe). `sendToHost` met UUID-correlatie + host-request-timeout;
  crash ⇒ `sandbox:crash`-notification + exit(1). Geen auto-respawn.
- **`core/src/sandbox/sandboxed-plugin-adapter.ts`** — host-side lifecycle:
  spawn → `initialize` → running → heartbeat → shutdown/kill. `start()` (init-handshake,
  hartslag-interval), `shutdown(timeoutMs=2000)` (ack + exit-wacht 150ms + SIGKILL-fallback),
  `kill()`; states `spawning|running|crashed|stopped`. **Skill-proxy**: `registerSkill`
  met broker-key `${pluginId}.${skill}` (altijd host-side afgeleid), handler ⇒
  `invokeSkill`-IPC. **Permission-gates (host, tegen manifest)**: `localOnly:false` ⇒
  `network:skill:<id>.<skill>`, `httpExposed:true` ⇒ `network:http:<id>.<skill>`,
  remote-gate `"any"` ⇒ `network:public:<id>.<skill>` — afwijking ⇒ registratie geweigerd,
  activate mislukt, sandbox down. **Timeout/crash**: invoke-timeout ⇒
  `PluginExecutionTimeoutError` + SIGKILL + crashed; hartslag-timeout ⇒ SIGKILL + crashed;
  channel-close/error ⇒ crashed (fail-closed). Crash ⇒ skills unregistered + pending
  gereject met `PluginCrashError` + `onCrashed`-callback; geen auto-respawn. Payload
  depth/size na child-result opnieuw gevalideerd (`validateObjectDepth`/`validatePayloadSize`).
- **Tests (16 nieuw in `sandboxed-plugin.test.ts` + runner-test-updates, alle suites groen):**
  lifecycle + skill-registratie via activate → broker `handle`/`handleRemote`; result- en
  error-afhandeling (`{ok:false}` ⇒ broker-error, sandbox blijft up); permission-gates
  (claim zonder manifest-perm ⇒ activate faalt, crashed); fail-closed capability-stubs;
  hardening-vlaggen in `process.execArgv` + `NODE_OPTIONS`-strip; code-generation-block
  bij activate én in handler; infinite-loop ⇒ timeout + SIGKILL + unregistered;
  hartslag-uitval ⇒ host SIGKILL; externe SIGKILL ⇒ in-flight pending krijgt
  `PluginCrashError`; non-serializable result ⇒ failed-outcome, kanaal intact;
  TaskBroker-handleRemote evalueert localOnly vóór de sandbox; launcher-units
  (spawnargs, stderr-forwarding, `filteredEnv`-secret-drop).

**Open (Slice 3+):** privilege-decoupling (laagste privileges per capability),
host-side `PluginHost`-integratie (sandboxed lifecycle aan het bestaande boot- en
deactivate-pad haken), verdere capability-proxy's, de container-optie als
enterprise-afweging, én (als OS-level isolatie ooit gewenst wordt) een
module-loader-restrictie in de child (bijv. `--experimental-policy` of het
`--permission`-model) die `require("fs")`/`require("net")`/
`require("child_process")` daadwerkelijk blokkeert — zonder dat is dit GEEN
security-sandbox tegen kwaadwillige plugins. De `PluginContext`-capabilities
buiten skill-executie blijven fail-closed afwezig tot een latere slice ze
per-stuk proxied.

## Open slice: plugin-certificatie-scanner (brief afgerond, bouw open)

De brief staat in `docs/plugin-certification-scanner.md` en is gevalideerd met empirische
metingen, niet aannames. Status: **brief afgerond; de certificatie-service (Slice 1/2) is de
volgende bouwfase.** Kernbesluiten:

- **Pijler A — hard-only ruleset:** een 9-regel hard-only eslint-set is de basis. De aanbevolen
  `eslint-plugin-security`-set (42 findings: 38× detect-object-injection + 4× detect-unsafe-regex)
  bevat 0 echte bevindingen — de object-injections zijn plugin-config-keys (vast schema, nooit
  indexering op caller-input) en de regexes zijn legitieme literals. 8/8 plugins CLEAN op hard-only.
- **Pijler B — AST-cross-check:** de eigen TS-compiler-API-scanner
  (`/tmp/opencode/lint-test/ast-crosscheck.cjs`) vangt alle module-vormen (incl. `node:`-prefix,
  constant-folding, dynamische import, `(0, eval)`, `import type`-skip) waar een regex-v1 fout-negatief
  op was (peersite's `node:fs/promises`). Beide scanners (eslint + AST) draaien; de AST-scanner is de
  gezaghebbende.
- **Pijler C — rapport + mens-in-de-lus:** rode vlaggen worden nooit onderdrukt. Peersite's
  `node:fs/promises` blijft een legitieme maar terechte vlag (read-only site-mirror met
  `resolveAndContainFile` + `MAX_WEBSITE_ASSET_BYTES`-cap, peersite/src/index.ts:377-387) — de
  beoordelaar beslist, het rapport liegt niet.
- **Anti-schijnvertrouwen:** "scanner schoon" is geen certificaat — beperkingen staan in de brief
  (undefined-behaviour-only plugins, minimale npm-install-time window, post-scan deps).

### Stap 3 — Plugin Certification Service v1 (gebouwd)

Geïmplementeerd en getest (core 366 → 398 tests, 20/20 workspaces groen). Beslissingen uit de
brief werkend gemaakt:

- **Scanner (Pijler B) als TS-service** (`core/src/certification/scanner.ts`, runtime-dep `typescript`):
  AST-scanner port van de gevalideerde cross-check, flagt eval/`(0, eval)`/`globalThis["eval"]`/`new
  Function` als critical, sensitive-module-require als critical/advisory, runtime-computed require als
  critical, `process.env`-read als advisory (1×/file), constant-folding incl. template-literals,
  `import type`-skip (runtime-erased), permission-cross-check (network-module zonder `network:*`-permissie
  + fs zonder capability). `passed` = geen critical findings; advisories falen nooit en worden nooit
  onderdrukt; beperkingen staan altijd loud in `ScanReport.limitations`. Eval-alias via variabele
  (`const e = globalThis["eval"]; e("x")`) is bewust NIET statisch vangbaar — dat is runtime-redirection,
  een gedocumenteerde beperking.
- **Certificatie = mens-in-de-lus, los van 2C-signing** (`core/src/certification/certification-service.ts`):
  `certification.json` bevat record {pluginId, contentHash, certifiedAt, expiresAt?, certificateVersion,
  reviewerId, signature}. De reviewer ondertekent exact `{pluginId, contentHash, certifiedAt}` (Ed25519);
  reviewerId/expiresAt zijn metadata, niet ondertekend. `contentHash` = deterministische aggregatie
  (sorted-key canonical JSON → SHA-256) over de 2C-file-hashkaart — elke byte-change breekt de binding.
  `certification.json` is aan `HASH_EXCLUSIONS` toegevoegd (SDK), zodat het review-artefact de 2C-handtekening
  van de author nooit breekt en de reviewer de author-PK niet nodig heeft.
- **Host-gate** (`plugin-host.ts`): `requireCertifiedPlugins`/`reviewerPublicKeys`/`certificationRevocationListPath`
  (default `<dataDir>/certifications/revocations.json`). `requireCertifiedPlugins: true` weigert direct met
  getypeerde `CertificationError` (ontbrekend/ongeldig/verlopen/contentHash-mismatch/herroepen), gemarkeerd
  `FAILED_ACTIVATION`; default `false` laadt ongescertificeerd met luide end-of-boot-warn. Lege
  reviewerPublicKeys ⇒ niets verifieert (default-deny). Corrupt register stopt de boot luid (CLAUDE.md #9).
- **Revocation**: herroepen per contentHash (+ optioneel pluginId), atomair gepersisteerd op het register;
  gecertificeerd-maar-herroepen laadt niet.
- **CLI** (`create-p2p-plugin`): `scan <dir>`, `certify <dir> --key <reviewer-key> [--reviewer <name>]
  [--expires <ISO>]` (weigert bij critical findings), `revoke <contentHash> --reason "<why>" [--plugin <id>]
  [--revocations <path>] [--data-dir <dir>]`. Reviewer-key = 64-hex raw Ed25519 (peerId-formaat).
- **Volgende slices uit de brief (open):** Pijler A eslint-integratie (hard-only 9-regel set naast de AST),
  UI-review-flow, npm-install-time window, undefined-behaviour-only-plugins-beoordeling.
