# Handleiding 05 — Hermes API-cheatsheet

> Eerste stappen; de app verandert nog veel. Dit is het snelle naslagwerk voor
> Hermes om de installatie en de eerste contacten te begeleiden. Alles wat
> hieronder staat draait tegen `127.0.0.1:8787` van de core-server — op de
> laptop rechtstreeks, op de homeserver via SSH.

## Auth

Elke `/api/*`-aanroep heeft `Authorization: Bearer <token>` nodig. Het token
staat per boot in het data-dir:

```bash
TOKEN=$(cat ~/.p2p-hub/boot-token)
```

- Nooit in de URL van een `/api/*`-call zetten (wel een geaccepteerde
  uitzondering voor `/ws`).
- Per boot opnieuw gegenereerd; bij een herstart van de server het token
  opnieuw lezen.
- Op de homeserver: via SSH hetzelfde doen
  (`ssh <user>@<homeserver> 'cat ~/.p2p-hub/boot-token'`).

## Algemene endpoints

| Endpoint | Gebruik |
| --- | --- |
| `GET /api/health` | Leef de server? |
| `GET /api/capabilities` | Lokale skills/plugins + ontdekte `remote.peers[]` (met `peerId`, `name`, `address`, `skills`, `trust`). |
| `POST /api/execute` | Roep een skill aan. |
| `GET /api/settings` | Effectieve instellingen + risico-assessment. |
| `GET /api/vault/keys` | Beheerde secrets (alleen metadata). |

## Execute-envelope

```json
{ "serviceId": "contacts", "method": "listContacts", "arguments": null }
```

`serviceId` + `method` → skill `contacts.listContacts`. Een `peerId`-veld in
de envelope maakt er een **remote** call van (naar die peer); weglaten betekent
lokaal. Contactbeheer is lokaal.

## Contactlevenscyclus (voorbeelden)

```bash
TOKEN=$(cat ~/.p2p-hub/boot-token)
API=http://127.0.0.1:8787/api/execute

# 1. Toevoegen — peerId = publicKeyHex, 64 hex
curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"contacts","method":"addContact","arguments":{"peerId":"<peerId>","publicKeyHex":"<peerId>","displayName":"Homeserver"}}'

# 2. Lijst
curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"contacts","method":"listContacts"}'

# 3. Verifiëren (challenge-response over P2P; peer moet online zijn)
curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"contacts","method":"verifyPeer","arguments":{"peerId":"<peerId>"}}'

# 4. Blokkeren
curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"contacts","method":"blockContact","arguments":{"peerId":"<peerId>"}}'

# 5. Deblokkeren
curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"contacts","method":"unblockContact","arguments":{"peerId":"<peerId>"}}'

# 6. Verwijderen
curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"contacts","method":"removeContact","arguments":{"peerId":"<peerId>"}}'
```

## Contactskills: bereikbaarheidsmatrix

| Skill | HTTP-brug (Hermes/webUI) | P2P (peers) |
| --- | --- | --- |
| `contacts.addContact` | ja | **nee** |
| `contacts.listContacts` | ja | **nee** |
| `contacts.verifyPeer` | ja | **nee** |
| `contacts.blockContact` | ja | **nee** |
| `contacts.unblockContact` | ja | **nee** |
| `contacts.removeContact` | ja | **nee** |
| `contacts.signChallenge` | **nee** | ja (elk anoniem antwoord mag) |

Alleen `signChallenge` is netwerk-bereikbaar en dat is bewust zo: de peer moet
bezit kunnen bewijzen vóórdat hij contact/status krijgt. Al het beheer loopt
via de lokale brug (het `httpBridgeOnly`-voorrecht).

## Werkwijze voor "eerste contacten" (stappenplan Hermes)

1. **Installatie** — handleiding 01: clone, `npm install`, `npm run build`,
   `.env` per station.
2. **Start** — handleiding 02: server op beide stations, `npm run build` als
   er iets wijzigt; `GET /api/health` oké?
3. **Peers** — `GET /api/capabilities` → `remote.peers[]`; is de homeserver
   zichtbaar vanaf de laptop (zelfde LAN, networking aan)?
4. **Toevoegen + verifiëren** — `addContact` met de `peerId` uit stap 3,
   daarna `verifyPeer` (beide nodes online voor de challenge).
5. **Beheer** — `blockContact` / `unblockContact` / `removeContact` wanneer
   de gebruiker daarom vraagt.
6. **Rest** — doe via de webUI; bij twijfel vraag het de gebruiker.

## Valkuilen

- `publicKeyHex !== peerId` → `addContact` weigert. Gebruik hetzelfde
  peerId-veld voor beide.
- `verifyPeer` faalt met `"no active network provider"` als networking uit
  staat, of als de peer op dat moment niet bereikbaar is. Niet als fout zien:
  het contact blijft `pending`.
- Na een herstart: token opnieuw lezen; de poort/data-dir kunnen per machine
  verschillen (check `P2P_HUB_DATA_DIR`).
