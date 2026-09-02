# HelpCenter & Diagnostiek — ontwerp (helpcenter-brief)

| | |
|---|---|
| **Status** | Proposed (7A-aanvullingen verwerkt) |
| **Datum** | 2026-09-01 |
| **Opdracht/brief** | HelpCenter + structurele debug-logging voor niet-technische gebruikers |
| **Gerelateerd** | `docs/journey/20260901-019-desktop-debug-instrumentatie.md`, `docs/skill-authorization.md`, `docs/agent-identity-streaming-design.md` |
| **Slice-kuur** | 5 slices, zie "Slice-plan" (7A = Slice 1: Diagnostiek-engine + redactie + ringbuffer) |

## Doel & filosofie

Een gedistribueerde desktop-app draait op exotische Windows/Linux/macOS-configuraties
die we nooit in een testomgeving zien. Zonder feedback-kanaal staan we bij elke
"onverklaarbare" bug weer "in ons hemd" — de afgelopen ronde (CORS-gate,
vault-unlock 500) bewees dat: de echte exceptie zat op een machine die we niet
kunnen inzien. Deze brief specificeert het **HelpCenter**: één plek in de
desktop-app waar een *niet-technische* gebruiker zichzelf kan helpen en — als
dat niet lukt — ons een **bewust geredigeerde, voorgeschouwde** diagnose kan
sturen, zonder iets van de privacy-belofte van het platform te breken.

Filosofische uitgangspunten, overgenomen uit de rest van het project:

1. **Transparantie-discipline**: er wordt nooit *stil* iets verstuurd. Alles wat
   de machine verlaat is zichtbaar voor de gebruiker vóór het gaat (dezelfde lijn
   als "vraag nooit om een token in een URL", "nooit secrets loggen").
2. **Privacy-first**: in een P2P-tool is *wie je spreekt* al gevoelige data.
   Redactie is daarom **verplicht vóór weergave**, niet optioneel bij verzenden.
3. **Offline-first**: de kern-help inhoud is lokaal gebundeld (markdown),
   doorzoekbaar zonder internet — de ethiek van het platform (geen centrale
   afhankelijkheid). Externe links zijn aanvulling, geen primaire bron.
4. **Geen nieuwe centrale afhankelijkheid**: geen ticket-systeem, geen
   cloud-backend. "Chat met ons" hergebruikt de bestaande ondertekende
   P2P-chat met een ingebakken support-contact.
5. **Propose-then-confirm** overal: alles wat een agent voorstelt vereist een
   expliciete bevestiging van de operator.

## Uitgangspunten (niet aangenomen — geborgd in code)

- Logcategorieën hoeven niet verzonnen te worden: ze volgen de architecturale
  grenzen die al bestaan. Pino is al de structured logger
  (`apps/core-server/src/logger.ts`); per-module **child-loggers** zijn
  grotendeels voldoende — geen nieuw logging-framework.
- `logger.level` is runtime aanpasbaar (pino), dus het "logging aan"-vinkje is
  een simpele `POST` naar een level-endpoint — geen herstart, geen env.
- Chat bestaat als P2P-skill `chat.receiveMessage` (`plugins/chat`) met een
  `contacts`-plugin; een support-peer past daar als ingebakken, uitnodigbaar
  contact. De AI-gate is detecteerbaar via `ai.*`-vault-secrets
  (`apps/core-server/src/routes/operator.ts:158`), zodat de help-agent alleen
  aangeboden wordt als de gebruiker een eigen AI-provider heeft.

## Pijler A — Diagnostieklaag (core-server)

### A.1 Log-bronnenregister

Een **geregistreerde**, vaste lijst van logbronnen — de "twintigtal logs op vaste
plekken". Elke bron: `{ id, naam, pad, categorie, level, aan/uit }`. Voorstel
(~16, 1-op-1 met architectuur): `network-light`, `network-libp2p`,
`task-broker`, `plugin-loader`, `vault`, `identity`, `contacts`, `chat`,
`peersite`, `media-gate`, `telemetry-gate`, `pal-bus` (CoreEventBus), `sandbox`,
`storage`, `certification`, `shell-ipc` (webview). Plus de twee bestaande
bestanden die al op schijf staan: `core-server.log` en de webview-feed via
`POST /api/debug/log` (gebouwd in de instrumentatie-ronde).

- Per categorie een pino child-logger (`logger.child({ module: "vault" })`),
  zodat bron-filtering in de viewer én in het bestand werkt (`module`-veld).
- **Level-toggle**: `PATCH /api/diagnostics/level` met `{ level }` (gevalideerd
  tegen de pino-level-set) zet `logger.level` runtime. Per-bron-uit = op `silent`
  zetten van de child-logger, **nooit** op de root (fataal/startup blijft altijd
  gelogd). Deny-by-default: een toggle kan alleen *meer* aan, niet de
  security-relevante paden (vault, identity) uitzetten.

### A.2 Ringbuffer (primair, in-memory) & viewer/tail

De **primaire** bron voor de viewer is een in-memory **ringbuffer** per module,
niet alleen het bestand op schijf. Elk pino-record dat door een geregistreerde
child-logger gaat wordt (naar `logger.level`-filtering) ook in de
bijbehorende ringbuffer geschreven — bounded, nieuwste-`N` per module
(default 200, cap 500), zodat een verbose-sessie nooit onbeperkt geheugen
neemt en de viewer ook werkt als `core-server.log` om onbekende reden ontbreekt
of geroteerd is.

- `GET /api/diagnostics/logs` → register + per bron de laatste `N` regels uit de
  ringbuffer (default 200, cap 500) **door de verplichte redactiefilter**
  (zie C.1/C.3).
- Bestandsbronnen (`core-server.log`, webview-feed) blijven bestaan en worden
  op dezelfde manier gelezen, maar de ringbuffer is de default: de endpoint leest
  primair memory (geen I/O), bestanden als fallback/aanvulling.
- De endpoint accepteert alleen een bron-`id` uit het register. Het lezen gebeurt
  via een **path-containment-helper** die resolve-én-prefix-anchored checkt
  (trailing separator, CLAUDE.md #3) tegen de geregistreerde paden — nooit een
  door de client geleverd pad, en het register bevat nooit `boot-token` of andere
  secrets.
- Cap op bestandsgrootte + regellengte per read (memory-bound), zoals
  `readJsonBody` al doet voor payloads.

## Pijler B — Diagnostische snapshot & bundel

### B.1 Snapshot (één knop, vaste vorm)

Voor triage is een gestructureerde snapshot vaak waardevoller dan ruwe logs.
Eén klik → altijd hetzelfde formaat:

- OS (`platform`, `release`, `arch`), app-versie (`__P2P_HUB_CORE_VERSION__`),
  Node/runtime-versie, geheugen (`process.memoryUsage`-samenvatting).
- **GPU-diagnostics** (best-effort, macOS/Windows/Linux): GPU-model en driver als
  die zonder nieuwe dependencies te achterhalen zijn (bijv. uit
  `d3d12`/`Metal`/`glxinfo`-achtige kanalen; op Node zonder native addons dus
  pragmatisch: `lspci`-parse op Linux als beschikbaar, anders `null`). Belangrijk
  omdat "scherm is zwart / UI-tekent niet" in de praktijk vaak een
  GPU-driver-probleem is dat je op afstand ziet voordat de app-stack verdacht is.
  Fail-closed: elke probe-fout → veld op `null`, nooit een crash en nooit ruwe
  probe-uitvoer in de bundel.
- Actieve netwerk-provider + status (`ctx.provider()`: `id`, peer-count,
  transport), WAN-ingeschakeld ja/nee.
- Geladen plugins + versies, certificatiestatus (gecertificeerd/unsigned),
  vault-staat (locked/unlocked, masterKeyConfigured — **geen** secrets),
  bootState, uptime.

### B.2 Bundel & preview (geen blind versturen)

"Meld een probleem"-flow = snapshot + door de gebruiker gekozen logcategorieën
+ eigen beschrijving → **één** bundel (JSON + leesbare tekst) met een **zichtbare
preview vóórdat er iets gekopieerd/verstuurd wordt**. De gebruiker kan:
kopiëren naar klembord, opslaan als bestand, of rechtstreeks in "chat met ons"
plakken. Er is **geen** automatische upload in v1 (zie "Uitgesteld").

## Pijler C — HelpCenter-UI (desktop-shell)

- Nieuw venster "Help & Diagnostiek", geopend vanuit de Hermes-sidebar en de
  taskbar; ook contextueel: bij een fout-toast een "toon details"-actie die dit
  scherm opent met de relevante bron geselecteerd.
- Tabbladen: **Diagnose** (snapshot-knop + bundel + preview), **Logs**
  (bronnenlijst met aan/vinkjes + laatste regels), **Chat met ons**,
  **Help-agent** (alleen als AI geconfigureerd), **Documentatie**.
- Het logtabblad toont de **altijd geredigeerde** weergave. Een expliciete
  "toon ongeredacteerd (alleen voor jezelf, niet delen)"-toggle bedekt de
  meest gevoelige velden met een waarschuwing — uitzondering, geen standaard.

### C.1 Redactiefilter (verplicht, display-time)

Een filter die op het moment van **weergave** draait, niet pas bij verzenden:

- `peerId`s (en contact-relaties): gemaskeerd (`peer_9f2a…a1c0`). Wie iemand
  spreekt is privacygevoelig in een P2P-tool.
- IP-adressen: gemaskeerd.
- **Bericht-inhoud**: logs tonen *metadata* ("bericht ontvangen van peer X,
  240 bytes, geverifieerd"), niet de inhoud — tenzij een expliciete verbose-modus
  aan staat (poweruser, met waarschuwing).
- Boot-token / `ai.apiKey` / vault-secrets: horen structureel **niet** in logs
  (bestaande invariant) én worden door de filter gemaskeerd als ze er toch
  verschijnen.
- De filter is gedeelde code (`sdk`), zodat viewer, export en de opgeslagen
  webview-feed dezelfde maskering gebruiken.

## Pijler D — Help-agent (optioneel, read-only)

Een lokale agent die de gebundelde help-docs + de diagnostische snapshot kan
doorzoeken om vragen te beantwoorden ("waarom zie ik dit scherm", "wat betekent
deze foutcode"). Harde grenzen:

- **Alleen aangeboden als de gebruiker een AI-provider heeft geconfigureerd**
  (detectie via `ai.*`-vault-secrets). Zonder eigen key: tabblad verborgen.
- **Read-only**: de agent heeft géén `edit file`-achtige tools — hij kan
  uitsluitend lezen (docs, snapshot, logs) en antwoorden. Nooit zelf iets
  repareren.
- **Propose-then-confirm**: een voorstel ("wil je dat ik X probeer") gaat altijd
  door een bevestigingsknop van de operator; een agent die stilzwijgend
  instellingen wijzigt is uitgesloten (zelfde lijn als overal elders).
- De sleutel wordt nooit aan de plugin gegeven: alleen `CoreAIProvider` leest
  `ai.apiKey` en injecteert die in de outbound request (CLAUDE.md #6).
- De agent is een reguliere (operator-tier) skill, geen nieuw vertrouwensmodel.

## Pijler E — Documentatie & kennisbank

- Lokaal gebundelde markdown (offline doorzoekbaar), met foutcode-kaarten
  ("waarom vraagt het om een sleutel", "waarom is het netwerk uit", herstelstappen
  voor vault-sleutel kwijt, geen peers gevonden, app start niet).
- Externe links als aanvulling, nooit primaire bron.
- De kennisbank is dezelfde corpus waar de help-agent over redeneert.

## Pijler F — `--safe-mode` boot-vlag (troubleshooting)

Een tweede startup-vlag naast het bestaande `P2P_HUB_NETWORKING=0` voor
"de app start niet of tekent niet":

- `--safe-mode` (of `P2P_HUB_SAFE_MODE=1`) start de core-server met de
  **minimale** set: géén plugins, géén P2P-transport, geen identity/vault-
  afhankelijkheid (dezelfde lazy-vorm als de `PluginHost` in local-only boot) —
  alleen de loopback-bridge + het help-oppervlak, zodat een gebruiker wiens
  config/plugin netwerk op zijn gat ligt toch het HelpCenter kan bereiken.
- Zichtbaar in de snapshot (`bootFlags: ["safe-mode", ...]`) en in de UI
  (badge "veilige modus"), zodat de support-flow niet eindigt in
  "en nu?" als het daar al misgaat.
- De vlag is **fallback-only**: uit is de default; de startup-log schrijft een
  luide waarschuwing als hij aan staat (zelfde regel als de dev-fallback-key:
  een alternatieve boot-route moet luid zijn, niet stil).

## Pijler G — Diagnostiek-engine (deel van Slice 1 / 7A)

De engine die Pijler A–F bedient, als één module in `apps/core-server`:

- **Register + child-loggers**: één plek die de ~16 geregistreerde bronnen kent,
  per bron een pino child-logger (`logger.child({ module })`) maakt en een
  ringbuffer bindt. Root-`logger.level` blijft runtime aanpasbaar via
  `PATCH /api/diagnostics/level`; per-bron-uit = child op `silent` (nooit de
  root), en security-relevante paden (vault, identity) kunnen niet uit.
- **Redactie**: de gedeelde `sdk`-filter (Pijler C.1) wordt op het
  weergave-moment toegepast op álle uitgaande log-output (ringbuffer én
  bestands-lees), niet pas bij verzenden.
- **In-memory ringbuffers**: primair, bounded per module, zie A.2.

## Alternatieven overwogen

- **Automatische anonieme crash-telemetry (Sentry-achtig)** — uitgesteld: staat
  haaks op "nooit stil iets versturen" tenzij extreem expliciet opt-in; past
  vooralsnog beter bij handmatig-met-preview. Herbekijken zodra er een echte
  gebruikersbasis is.
- **Eigen ticket-/support-backend (HTTPS-upload van logs)** — afgewezen in v1:
  nieuwe centrale afhankelijkheid + nieuw upload-oppervlak; "chat met ons" via de
  bestaande ondertekende chat is eenvoudiger én past bij het platform.
- **"Kopieer laatste 100 regels" zonder redactie** — afgewezen: een
  niet-technische gebruiker kan die logs elders (forums, publiek) plakken en
  onbedoeld peer-ids/IP's/contact-relaties lekken. Redactie is daarom verplicht
  vóór weergave.
- **"Stuur alles stil door bij elke fout"** — afgewezen: zelfde transparantie-
  discipline; enkel op expliciete actie van de gebruiker.
- **Help-agent met write-tools** — afgewezen: read-only + propose-then-confirm.

## Gevolgen & grenzen

- **Nieuwe exposure-surface**: `/api/diagnostics/*` (token-gated, alleen
  geregistreerde paden, path-containment). Dit is een nieuwe
  operator-oppervlakte — de security-review-checklist van CLAUDE.md is
  verplicht: deny-by-default, geen willekeurige bestandslees, geen secret-leak.
- **Support-contact**: "chat met ons" voegt een contact-relatie toe (onze peerId
  als ingebakken, uitnodigbaar contact). De gebruiker moet expliciet kunnen
  kiezen om wel/geen ondersteuning te zoeken; de chat zelf draagt de normale
  chat-privacy (geverifieerd, metadata-default).
- **Help-agent is een AI-consumer**: volgt de capability-scoped vorm (`ctx.ai`),
  geen raw key naar plugin, geen tools met write-rechten.
- **Redactie is nooit perfect**: de filter maskeert bekende patronen; een
  onverwacht geforceerde foutmelding kan nog ruwe tekst bevatten. Daarom is de
  preview (Pijler B.2) de laatste poort — de gebruiker ziet altijd wat er gaat.
- Logs kunnen groot worden in verbose-modus; bewust accepteerde trade-off voor
  een single-user desktop (al in de instrumentatie-ronde genoteerd).

## Slice-plan

Opdrachtverdeling (Gemini-briefs, 7A → 7D, ieder een eigen PR):

1. **Slice 1 / Brief 7A — Diagnostiek-engine (deze brief)**: log-bronnenregister,
   per-module child-loggers, in-memory ringbuffers, `GET /api/diagnostics/logs`
   (tail, path-contained, gecapped), `PATCH /api/diagnostics/level` (level-toggle),
   en de **verplichte `sdk`-redactiefilter** + tests. De `--safe-mode`-vlag uit
   Pijler F wordt hier vast voorbereid (vlag-parsing + snapshot-veld).
2. **Slice 2 / Brief 7B — Snapshot & bundel**: snapshot-schema (incl. GPU-
   diagnostics, best-effort), bundel + preview + export (klembord/bestand).
   **Klaar (PR #15)**: `collectSnapshot` (`apps/core-server/src/diagnostics/snapshot.ts`),
   `buildBundle`/`bundleClipboardText` (`diagnostics/bundler.ts`),
   `GET /api/diagnostics/snapshot` + `POST /api/diagnostics/bundle`, verplichte
   whole-bundle-redactie (tweede poort naast de engine-redactie), `sections`/
   `sources`/`userNote` met caps (`BUNDLE_MAX_RECORDS_PER_SOURCE` =
   `DIAGNOSTICS_MAX_READ`, `BUNDLE_MAX_TOTAL_RECORDS` = 2000, note ≤ 4000 chars).
   Scope-keuzes: (a) de snapshot-collector leest **structureel geen secrets** —
   vault is `locked/unlocked` + `masterKeyConfigured` (via `usesFallbackKey`,
   onderscheidt dev-fallback van echte key zonder de waarde aan te raken),
   peers zijn een count, plugins zijn id/name/version/kind + signature/
   certification; (b) **geen hostname** in de snapshot (niet in de brief-lijst en
   een onvermaskerde identifier — bewust weggelaten, verwijdert de test die het
   eerst wel bevatte); (c) GPU-probe = `lspci` op Linux, fail-closed `null`; de
   webview-fill-hooks (`webglRenderer`/`hardwareAcceleration`/
   `windowScaleFactor`) blijven `null` voor de shell-slice (7C); (d) "opslaan als
   bestand" is client-side (de API retourneert de bundle-JSON; de shell slaat
   op), de bundel zelf is altijd `redacted: true` — er is geen onredacted
   bundel-pad.
3. **Slice 3 / Brief 7C — HelpCenter-UI**: venster, tabbladen, logviewer, vinkjes,
   snapshot-knop, preview; fout-toast → "toon details". **Klaar (PR #16)**:
   "Help & Diagnostiek"-venster (Diagnose/Logs/Documentatie) in de
   desktop-shell, geopend vanuit taskbar/sidebar/startmenu en via de
   fout-toast; logviewer met per-bron aan/uit (secure bronnen weigeren) en de
   "toon ongeredacteerd"-poweruser-toggle; offline gebundelde Nederlandse
   documentatie (7 artikelen, on-device zoeken); gedeelde `ClientGpuProbe`
   (sdk) → `clientGpu` in snapshot/bundle (core-server), webview-webgl-probe in
   de shell.
4. **Slice 4 / Brief 7D — Chat met ons**: support-contact ingebakken (via
   `contacts`), chat-flow hergebruikt `chat.receiveMessage`; bundel-plakken in
   de chat.
5. **Slice 5 — Help-agent & docs**: offline kennisbank (markdown), foutcode-
   kaarten; optionele read-only help-agent (AI-gate, propose-then-confirm).

## Security-invariants (overgenomen uit CLAUDE.md)

- Deny-by-default op de nieuwe `/api/diagnostics/*`-surface, onafhankelijk van
  elke andere gate; alleen geregistreerde paden lezen met
  trailing-separator-anchored path-containment (principe #1/#3).
- Boot-token / `ai.apiKey` / vault-secrets worden nooit gelogd en nooit leesbaar
  gemaakt; de diagnose-API retourneert ze nooit (principe #6).
- Redactie is verplicht vóór weergave, niet optioneel bij verzenden — het
  "kopieer logs"-oppervlak is een nieuwe route naar de gebruiker zelf (principe
  #10: een oppervlak is veilig pas als de *ongelimiteerde* lezer er niets mee kan).
- De AI-key blijft in exact één plek (`CoreAIProvider`); de help-agent krijgt een
  capability, nooit de waarde (principe #6).
- Fouten op "verkeerde sleutel"-paden blijven terse; de diagnose-API voegt geen
  detail toe dat de vault-gate zou kunnen omzeilen (principe #7).

## Vastgelegde besluiten (door Gemini bevestigd, 2026-09-01)

- **UI-plaats**: nieuw "Help & Diagnostiek"-venster vanuit sidebar/taskbar;
  daarnaast een "toon details"-actie op de fout-toast die dit scherm opent met
  de relevante bron geselecteerd.
- **Ongeredacteerde toggle**: expliciete poweruser-toggle met rode waarschuwing
  ("alleen voor jezelf, niet delen") — uitzondering, geen standaard.
- **Chat-met-support initiatie**: alleen de operator klikt "chat met support";
  support stuurt nooit eerst een uitnodiging.
- **Snapshot auto-opnemen bij fouten**: alleen als *in-memory* buffer die bij
  het openen van de help-/bug-flow gevuld wordt; nooit automatisch weggeschreven
  naast de toast.
- **GPU-diagnostics / ringbuffer / `--safe-mode`**: toegevoegd door Gemini (zie
  Pijlers A.2, B.1, F) — verwerkt in dit plan.
- **Brief-verdeling**: 7A → 7D als 4 geïsoleerde implementatie-briefs, in
  volgorde; 7A is Slice 1 (Diagnostiek-engine + redactie + ringbuffer).
