# Handleiding 02 — Bouwen, starten en verbinden

> Eerste stappen; de app verandert nog veel.

De server draait uit `dist/`, dus na een wijziging altijd eerst bouwen:

```bash
npm run build
```

## Core-server starten (beide stations)

```bash
npm run start -w @p2p-hub/core-server
```

of rechtstreeks:

```bash
node apps/core-server/dist/index.js
```

Bij een geslaagde start verschijnt er zoiets als:

```
[core-server] listening on http://127.0.0.1:8787
```

Op de homeserver zet je dit achter systemd/nohup zodat het als dienst draait.
Beide stations moeten `P2P_HUB_NETWORKING` aan hebben (`1`, default) en op
hetzelfde LAN zitten, want de eerste kennismaking loopt via mDNS.

## Desktop-shell starten (alleen laptop)

```bash
npm run dev -w @p2p-hub/desktop-shell
```

Dit start de core-server en de Vite-UI samen. De UI is dan beschikbaar op
`http://localhost:5173` (Vite proxiet `/api` en `/ws` naar `127.0.0.1:8787`).
De Tauri-desktop-app bouw je zoals beschreven in `HERMES.md`.

## Het boot-token

Elke keer dat de core-server start, genereert hij een **per-boot token** en
schrijft dat naar:

```
<P2P_HUB_DATA_DIR>/boot-token
```

- Bestandspositie: standaard `~/.p2p-hub/boot-token`.
- Rechten: `0600` (alleen de eigen gebruiker kan het lezen).
- Gebruik: elke `/api/*`-aanroep met `Authorization: Bearer <token>`; de
  WebSocket gebruikt `?token=` in de query-string (alleen `/ws`, zie
  `CLAUDE.md` voor waarom dat een geaccepteerd risico is).
- Hermes leest het token uit dit bestand vóór elke API-call.
- In een browser-dev-run (zonder Tauri) kan de shell het token krijgen via de
  omgevingsvariabele `VITE_P2P_HUB_TOKEN` in plaats van de Tauri-command.

> Het token staat **nooit in de URL** van een `/api/*`-aanroep en wordt nergens
> gelogd. Houd de brug op loopback (zie handleiding 01).

## Gezondheidscheck

Zet het token in een variabele en check of de server leeft:

```bash
TOKEN=$(cat ~/.p2p-hub/boot-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/health
```

Antwoord zou moeten zijn: `{"ok":true,...}`.

## Peers ontdekken

Met beide stations aan op hetzelfde LAN:

```bash
TOKEN=$(cat ~/.p2p-hub/boot-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/capabilities
```

In de webUI verschijnt de andere node in **Peer & Capability Inspector** onder
"Remote peers" zodra mDNS hem heeft gevonden. Een peer heeft onder andere:

- `peerId` — de permanente 64-hex Ed25519 publieke sleutel (dit is óók de
  `publicKeyHex` die je bij het toevoegen van een contact nodig hebt);
- `name`, `address`, `skills` (welke vaardigheden de peer aanbiedt);
- `trust` — hoe de contactenplugin deze peer op dit moment beoordeelt.

> Zie je geen peer? Check dan: beide stations op hetzelfde (multicast-)
> netwerk, beide met networking aan, geen firewall die mDNS (UDP 5353) of de
> TLS-poort blokkeert. mDNS werkt niet door NAT/VLAN-grenzen heen.

## Volgende stap

Handleiding 03 — de eerste contacten: toevoegen en verifiëren.
