# Handleiding 03 — De eerste contacten: toevoegen en verifiëren

> Eerste stappen; de app verandert nog veel.

Een `peerId` is een permanente 64-hex Ed25519 publieke sleutel. Op zichzelf
bewijst die niets: iedereen kan beweren "ik ben peerId X". De contactsplugin
maakt van een opgeslagen contact daarom een **proof-of-possession-relatie**:
verifiëren (zie onder) stuurt een challenge naar de peer zelf en promoveert het
contact pas naar `verified` wanneer de retourneerde handtekening klopt met de
opgeslagen sleutel.

Contactbeheer (`addContact`, `listContacts`, `verifyPeer`, `blockContact`,
`unblockContact`, `removeContact`) is een **lokale-bediener-voorrecht**:
bereikbaar via de lokale HTTP-brug met het boot-token — voor Hermes en de
webUI — maar structureel nooit over het P2P-netwerk. Een peer kan dus nooit
zijn eigen contactstatus bij jou wijzigen; de enige peer-bereikbare skill is
`contacts.signChallenge` (het challenge-antwoord).

## Manier 1: via de webUI (laptop)

Open **Peer & Capability Inspector** in de shell:

1. **Contacts** bovenaan toont je contactenboek (leeg in het begin).
2. Onder **Remote peers** zie je de ontdekte node. Klik **"Add contact"** op
   een peer met een `peerId` — het contact verschijnt als `pending`.
3. Klik **Verify** op het contact. De plugin stuurt nu een challenge naar de
   peer over P2P; bij een geldig antwoord wordt het contact `verified`.
4. Gebruik de **Block / Unblock / Remove**-knoppen voor het verdere beheer
   (handleiding 04).

## Manier 2: via de API (Hermes)

Alle calls gaan naar `/api/execute` met `Authorization: Bearer <token>`.
Voorbeeld (op de machine waar de core-server draait, of via SSH op de
homeserver):

```bash
TOKEN=$(cat ~/.p2p-hub/boot-token)
curl -s -X POST http://127.0.0.1:8787/api/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"serviceId":"contacts","method":"addContact","arguments":{"peerId":"<peerId>","publicKeyHex":"<peerId>","displayName":"Homeserver"}}'
```

Regels die de plugin hard afdwingt:

- `peerId` moet 64 hex-karakters zijn (`^[0-9a-f]{64}$`).
- `publicKeyHex` moet **exact gelijk zijn aan** `peerId` (in de identiteitslaag
  zijn het dezelfde waarde; een mismatch wordt geweigerd).

Haal de `peerId` van de andere node uit `/api/capabilities` → `remote.peers[]`
(voor `name` en `address`):

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8787/api/capabilities
```

Opvragen en verifiëren:

```bash
# Lijst contacten
curl -s -X POST http://127.0.0.1:8787/api/execute \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"contacts","method":"listContacts"}'

# Verifieer (stuurt een challenge naar de peer over P2P)
curl -s -X POST http://127.0.0.1:8787/api/execute \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"contacts","method":"verifyPeer","arguments":{"peerId":"<peerId>"}}'
```

`verifyPeer` geeft `{"verified":true}` bij een geldig bewijs, of
`{"verified":false,"error":"..."}` wanneer de peer niet bereikbaar is, geen
networking heeft of de handtekening niet klopt. Een mislukte verificatie
verandert de trust-state niet (het contact blijft `pending`).

## Wat "verified" wél en níét betekent

- **Wél:** "deze peer bewijst dat hij de privésleutel achter dit `peerId`
  bezit" — de triviale spoof ("ik claim toevallig jouw peerId") is dicht.
- **Niet:** "dit is echt Jan". Echte identiteit blijft een menselijke/koppel-
  kwestie. Voeg alleen peers toe die je uit een vertrouwd kanaal kent en
  vergelijk de `peerId` op beide stations.

## Volgende stap

Handleiding 04 — blokkeren en verwijderen.
