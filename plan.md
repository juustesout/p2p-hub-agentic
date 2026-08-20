# plan.md — p2p-hub: visie & routekaart (Fase 0 → 2)

Doel van dit document: een gedeeld beeld zodat Gemini, Claude, ChatGPT, Hermes en
Monkey op één lijn zitten over **wat** we bouwen en **in welke volgorde**. Het is
geen spec; het is de prioriteitenladder.

## Visie (kort)

Het fundament (transport, plugins, core-server, Tauri-shell, security-reflexen) is
er en draait — 378 tests groen, netwerk-discovery werkt met een peer. De volgende
sprong is NIET "meer plugins erbij", maar drie dingen tegelijk:

1. **Fundering cross-platform betrouwbaar maken** (Windows is nu de zwakke schakel).
2. **Protocollen expliciet en gepind maken** zodat ze tegen *onvertrouwde* peers
   kunnen, niet alleen tegen onze eigen twee nodes op één machine.
3. **Eerste-klas plugin-ontwikkelervaring + veilige distributie**, zodat "dikke
   professionele plugins" door derden gebouwd kunnen worden zonder dat wij hun code
   hoeven te vertrouwen.

Multi-peer testen is de toetssteen van élke fase: elke fase eindigt met een
concreet meerpeers-scenario dat moet slagen.

---

## Fase 0 — Fundering: kunnen we vertrouwen wat we hebben?

**Klaar vóór we met meerdere peers gaan testen. Alles hier is korte klus (dagen).**

### 1. Cross-platform CI + testlab
GitHub Actions: Windows runner (en Linux) → `tsc -b`, `npm test`, `cargo check`.
De Windows-only hang in core is net gefixt, maar dit moet structureel gevangen
worden — anders regresseert het. Bouw meteen een **multi-peer smoke-test** in de
CI: 2–3 PluginHosts (in-process, real network-light) die elkaars network-exposed
skill aanroepen. Dat is de eerste "meerdere peers"-test die we überhaupt hebben.

### 2. mDNS skill-naam-lek dichten
`network-light` adverteert nu álle lokale skill-namen via mDNS, óók `localOnly` /
niet-network-exposed. Wordt op de broker correct afgewezen, maar het **lekt wél
welke skills bestaan** aan iedereen op de LAN (staat als open follow-up in
CLAUDE.md). Fix: alleen namen adverteren die door een `network:skill:<id>.<name>`
permissie zijn gedekt. Essentieel omdat "meerdere peers" = "onbekende peers
luisteren mee".

### 3. Expliciete opt-in voor netwerk-blootstelling + local-only core-server
`P2P_HUB_HOST=0.0.0.0` mag niet impliciet de bridge openleggen; forceer een
expliciete, losse `P2P_HUB_EXPOSE=1` (staat als open follow-up). Daarnaast: een
"local-only mode" voor de core-server die de identity/vault-afhankelijkheid
achter networking gated (zoals `PluginHost.boot()` al doet) — anders faalt een
lokale installatie hard op een corrupte vault.

---

## Fase 1 — Protocol verstevigen: vertrouwen zonder transport-trust

**De kern van "protocollen strenghtenen". Nadruk: expliciete wire-contracten en
pinning — niet vertrouwen op "we praten alleen met onszelf".**

### 4. Transport-identiteit pinnen op geclaimde identiteit
Peersite Fase 3 authenticatie is challenge-response proof-of-possession over de
TLS-sessie (`p2p-hub:peersite:auth:v1:`). De aangekondigde vervolgstap: de
**certificaat-fingerprint van de peer verifiëren tegen de contactrecord** via het
mDNS TXT side-channel (nooit `rejectUnauthorized: false`). Dit maakt de
transportlaag zelf gepind op wie de peer beweert te zijn — de grootste
vertrouwenssprong die we kunnen maken.

### 5. Expliciete protocol-versionering & wire-contracten
Chat's canonical message is nu `JSON.stringify` met vaste key-volgorde — dat is
alleen correct zolang beide kanten dezelfde `canonicalMessage`-constructor
delen. Zet vóór een tweede onafhankelijke implementatie een expliciete
byte-template-canonicalisatie en een handshake met versie + capabilities.
Regel: elk protocol dat een peer van buiten kan triggeren krijgt een versie-veld
én een default-deny voor onbekende versies.

### 6. Cross-process storage-locking + Windows-verificatie
Twee instances tegen hetzelfde storage-dir racen nu op "wie schrijft als laatst".
Met meerdere testers wordt dit reëel. Plan een write-with-lock architectuur op
het gedeelde `atomicWriteFile`-pad (temp + fsync + rename blijft, maar binnen
een lock). Verifieer daarnaast de rename-over-bestaand-bestand-semantiek op
Windows — alles is tot nu toe alleen op Linux getest.

### 7. Peer-level rate-limiting & quota op de broker
Peersite-knock heeft 1/uur in-memory; dat is het enige peer-level limiet. Voor
multi-peer moet de broker per-peer inkomende task-snelheid en payload-quota
kunnen limiteren (payload-quota bestaat al via `validatePayloadSize`). Zonder
dit is een onvertrouwde peer één systeemaanval verwijderd van een flood.

---

## Fase 2 — Dikke professionele plugins & distributie

**Voorwaarde voor "we maken hier een product van".**

### 8. Plugin-scaffold + declaratieve config-UI
Eén `create-p2p-plugin` template en één "thick plugin"-contract: manifest-ui,
skill-metadata (beschrijvingen, schemas), declaratieve `exposedEvents`. Doel:
elke plugin krijgt automatisch een consistent instellingenvenster en
toestemmingsmatrix in de shell, zonder dat elke plugin zijn eigen UI/security
hoeft te timmeren. Dit is wat "dikke professionele plugin" betekent in deze
architectuur — en het verlaagt de drempel voor derden.

### 9. Manifest-signing (ed25519) + id-collisie-oplossing
Plugins van derden vergen verificatie van herkomst: onderteken het manifest
(`manifest.signature`), verifieer bij install/load, en los het dotted-id-probleem
op (`"a.b"` en `"a"` kunnen nu dezelfde broker-skill-key claimen). Dit is het
fundament voor een marketplace, **zonder** meteen een store te bouwen.

### 10. Peer-app-model veralgemenen (peersite → algemene capability)
Peersite heeft als eerste plugin een veilige remote-toegangsmodus (containment,
access-passes, verified-contact gate). Generaliseer dat tot een `peer-app`
capability zodat elke plugin een beveiligde web/remote-modus kan krijgen met
dezelfde gates: verified-contact **of** access-pass, nooit `execute-skill`. Dat
is het moment waarop het product niet meer "een desktop met plugins" is, maar
"een P2P-suite waarin peers elkaars apps draaien".

---

## Multi-peer testplan (rode draad, per fase)

- **Fase 0:** CI smoke-test met 2–3 hosts in-process; daarna twee echte
  machines + één browser-dev shell.
- **Fase 1:** drie machines, één daarvan "kwaadaardig" (gokt identiteit, replays,
  floot). Iedere protocol-verandering eindigt met zo'n scenario.
- **Fase 2:** vier+ peers met plugins van "derde partij" (gesigneerde manifests).

## Beslisvragen voor het overleg met de modellen

1. Klopt de volgorde — Fase 0 eerst, of willen jullie een ander punt naar voren?
2. Punt 4 (cert-pinning) of punt 5 (protocol-versionering) eerst in Fase 1?
3. Is de `peer-app`-generalisatie (10) de juiste vorm voor "dikke plugins", of
   moet de plugin-UI juist méér mogen (config-UI dieper in de shell)?
4. Waar hoort het testlab te leven: aparte repo/scripts, of in `apps/`?
