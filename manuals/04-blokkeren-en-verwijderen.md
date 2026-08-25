# Handleiding 04 — Blokkeren en verwijderen

> Eerste stappen; de app verandert nog veel.

Elk contact heeft een `trustState`: `pending` (toegevoegd, nog niet
geverifieerd), `verified` (bewezen eigenaar van de peerId) of `blocked`.
"Blokkeren" is simpelweg die status op `blocked` zetten — en de rest van het
systeem respecteert dat al: de chatplugin weigert berichten van geblokkeerde
afzenders, en de peer-access-gate weigert geblokkeerde peers ook in publieke
modi. Vóór deze handleiding bestond er alleen een blokkeer-*status* zonder
enige knop; nu is de levenscyclus compleet.

## Blokkeren

WebUI: open **Peer & Capability Inspector** → Contacts → **Block**.

API (Hermes):

```bash
TOKEN=$(cat ~/.p2p-hub/boot-token)
curl -s -X POST http://127.0.0.1:8787/api/execute \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"contacts","method":"blockContact","arguments":{"peerId":"<peerId>"}}'
```

Antwoord: het bijgewerkte contact met `"trustState":"blocked"`. Blokkeren van
een onbekend `peerId` faalt luid (geen stille no-op).

Effect van `blocked`:

- De peer kan geen contact-initiatief meer nemen dat via `blocked`-controles
  loopt (chat, access-gates) — het is geen "verwijderen", de peer blijft in
  je boek, maar geweigerd.
- De peer wordt níét uit je contactenboek verwijderd; je ziet nog steeds dat
  hij er is (met het `blocked`-label).

## Deblokkeren

WebUI: **Unblock** op het contact.

API:

```bash
curl -s -X POST http://127.0.0.1:8787/api/execute \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"contacts","method":"unblockContact","arguments":{"peerId":"<peerId>"}}'
```

`unblockContact` zet het contact terug op `pending`. Het eerdere `verified`
wordt niet automatisch hersteld — verifieer opnieuw (handleiding 03) als je de
peer weer volledig vertrouwt.

## Verwijderen

WebUI: **Remove** op het contact.

API:

```bash
curl -s -X POST http://127.0.0.1:8787/api/execute \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"serviceId":"contacts","method":"removeContact","arguments":{"peerId":"<peerId>"}}'
```

Antwoord: `true` als het contact bestond en verwijderd is, `false` als het
niet bestond. Verwijderen is definitief — de peer staat weer als "onbekend"
tegenover jou, en eventuele `verified`-status is weg.

## Samenvatting van de levenscyclus

```text
toevoegen (addContact)  →  pending
verifiëren (verifyPeer) →  verified   (alleen via bewijs van bezit)
blokkeren (blockContact)→  blocked
deblokkeren (unblockContact) → pending (verifieer opnieuw voor verified)
verwijderen (removeContact) → weg
```
