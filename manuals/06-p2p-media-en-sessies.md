# Handleiding 06 — P2P-media & sessies

> Eerste stappen; de app verandert nog veel. Deze handleiding beschrijft de
> media-plugin (`plugins/media`): WebRTC-signaling tussen twee peers en de
> mediasessie — de lokale operator-ceremonie die camera/microfoon-toegang tot
> een peer opent. Alles draait tegen `127.0.0.1:8787` van de core-server
> (rechtstreeks op de laptop, via SSH op de homeserver).

## Wat het is

- **Signaling (P2P):** de skills `media.offer`, `media.answer` en
  `media.iceCandidate` wisselen SDP/ICE uit tussen twee peers. De audio/video-
  bytes zelf lopen via WebRTC's `RTCPeerConnection`, buiten de TaskBroker.
- **Sessie (lokaal):** `media.requestSession` is de autorisatie-ceremonie
  vóórdat er een live stream met een peer is:

  1. `checkPeerAccess` — de peer moet een **verified contact** zijn of een
     geldige `media-signal`-access-pass hebben; anders `unauthorized`.
  2. **Tier-2 native bevestiging** — de shell toont dezelfde native prompt als
     bij execute-skill/vault/`peersite.requestAccess`. Geweigerd ⇒
     `media-access-denied`. Wordt **nooit** overgeslagen, ook niet voor een
     al-verified contact: contact-trust is geen toestemming voor camera/mic.
  3. De sessie registreert een **TelemetryGate-kanaal** — een per-peer,
     per-kanaal budget (frames én bytes per venster) voor de stream-telemetry.

  Een open sessie is daarna het *fast-path*-recht voor die telemetrie: frames
  rijden op het frequentiebudget in plaats van per frame de hele ceremonie te
  herhalen. Overloop **dropt** (nooit queue, nooit error-spam, nooit
  verbinding sluiten); een volgehouden >2x burst knijpt het kanaal dicht.

## Bereikbaarheidsmatrix

| Skill | HTTP-brug (Hermes/webUI) | P2P (peers) |
| --- | --- | --- |
| `media.requestSession` | ja | **nee** (`httpBridgeOnly`) |
| `media.closeSession` | ja | **nee** (`httpBridgeOnly`) |
| `media.getStreamStatus` | ja | **nee** (`httpBridgeOnly`) |
| `media.offer` | **nee** | ja (verified-contact/access-pass) |
| `media.answer` | **nee** | ja (verified-contact/access-pass) |
| `media.iceCandidate` | **nee** | ja (telemetry, per-peer gefrequentie-capped) |

De sessie-levenscyclus is een **lokaal operator-voorrecht** (`httpBridgeOnly`):
een LAN/WAN-peer kan structureel geen sessie openen of sluiten. De signaling-
skills zijn netwerk-bereikbaar en draaien hun eigen gate (`verified-contact`
of `media-signal`-pass) vóór elke aanroep.

## Auth

Elke `/api/*`-aanroep heeft `Authorization: Bearer <token>` nodig:

```bash
TOKEN=$(cat ~/.p2p-hub/boot-token)
API=http://127.0.0.1:8787/api/execute
```

## Voorbeelden

Een sessie openen (doet de native Tier-2 bevestiging; de gebruiker moet in de
shell akkoord gaan):

```bash
curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"media","method":"requestSession","arguments":{"peerId":"<peerId>","kind":"camera"}}'
```

Antwoord (binnen de execute-envelope):

```json
{
  "taskId": "...",
  "status": "ok",
  "result": {
    "ok": true,
    "sessionId": "...",
    "peerId": "<peerId>",
    "kind": "camera",
    "channelId": "media-session:..."
  }
}
```

Sessiestatus opvragen (frames/dropped/violations + het actieve budget):

```bash
curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"media","method":"getStreamStatus","arguments":{"sessionId":"<sessionId>"}}'
```

Sessie sluiten (en daarmee ook het telemetriekanaal):

```bash
curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"media","method":"closeSession","arguments":{"sessionId":"<sessionId>"}}'
```

## Valkuilen

- Peer is geen verified contact en heeft geen pass → `unauthorized` (met
  `reason`, bv. `not_a_contact`). Eerst contact toevoegen + verifiëren
  (handleiding 05).
- De native bevestiging wordt geweigerd (of er is geen confirmer gekoppeld) →
  `media-access-denied`. Fail-closed: nooit een open deur.
- Er is al een sessie open voor dezelfde peer → `session already open`.
- Telemetrie boven het budget → de frames worden **gedropt** (op de signaling-
  kant: `code: "telemetry-drop"`), de sessie zelf blijft gewoon actief.
- Onbekende `sessionId` → `no such session`.
