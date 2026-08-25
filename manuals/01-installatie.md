# Handleiding 01 — Installatie

> **Status: eerste stappen.** Dit is een actieve ontwikkel-repo: de app en de
> `P2P_HUB_*`-variabelen veranderen nog. Zie deze handleiding als leidraad voor
> "installatie + eerste contacten", niet als een bevroren waarheid.

Dit project draait op **twee stations** die op hetzelfde LAN moeten staan:

| Station | Rol | Wat erop draait |
| --- | --- | --- |
| **Laptop (Windows)** | Bediening | core-server + desktop-shell (Tauri) |
| **Homeserver (headless)** | Altijd-aan-node | alleen core-server |

De twee stations vinden elkaar via mDNS op het LAN en praten daarna over een
versleutelde verbinding met een geverifieerde Ed25519-identiteit. De HTTP/WS
brug (`127.0.0.1:8787`) is alleen voor de lokale bediening — Hermes en de
webUI — en wordt beveiligd met een per-boot token.

## Vereisten

- **Node.js 20+** op beide stations (LTS is prima).
- Alleen voor de **Tauri-shell op de laptop**: Rust (MSVC toolchain), Visual
  Studio Build Tools en WebView2. De uitgeschreven stappen daarvoor staan in
  `HERMES.md` aan de repo-root — volg die eerst als de shell nog niet werkt.
- De homeserver heeft niets extra nodig: alleen Node.

## Repo binnenhalen en bouwen

Op **beide** stations:

```bash
git clone <repo-url> p2p-hub && cd p2p-hub
```

Installeer en bouw (de server draait uit `dist/`, dus `build` is verplicht
vóór elke run):

```bash
npm install
npm run build
```

## De `.env` (de `P2P_HUB_*`-variabelen)

De core-server leest alle instellingen uit de omgeving. Zet ze per station in
een `.env`-bestand in de projectroot (en laad die met `set -a; source .env;
set +a` op Linux / `for /f ... in (.env) do set ...` op Windows), of exporteer
ze direct.

### Laptop

```dotenv
P2P_HUB_HOST=127.0.0.1
P2P_HUB_NETWORKING=1
P2P_HUB_PORT=8787
P2P_HUB_DATA_DIR=%USERPROFILE%\.p2p-hub
```

### Homeserver

```dotenv
P2P_HUB_HOST=127.0.0.1
P2P_HUB_NETWORKING=1
P2P_HUB_PORT=8787
P2P_HUB_DATA_DIR=/home/<user>/.p2p-hub
```

Houd `P2P_HUB_HOST=127.0.0.1` (loopback). De HTTP/WS-brug is alleen beveiligd
met het per-boot token en hoort dus niet op het netwerk te luisteren. Hermes
bereikt de homeserver gewoon via SSH (zie handleiding 05). Wil je de brug
toch over het LAN blootstellen, dan geldt: een non-loopback adres wordt
**geweigerd tenzij** `P2P_HUB_EXPOSE=1` (precies `"1"`, niet `"true"`). Zet die
alleen als je precies weet wat je doet — de server waarschuwt luid bij start.

## Variabelen-overzicht

| Variabele | Default | Betekenis |
| --- | --- | --- |
| `P2P_HUB_HOST` | `127.0.0.1` | Bindadres HTTP/WS-brug. Non-loopback vereist `P2P_HUB_EXPOSE=1`. |
| `P2P_HUB_EXPOSE` | — | Precies `"1"` om de brug buiten loopback te mogen binden. |
| `P2P_HUB_PORT` | `8787` | Poort van de HTTP/WS-brug. |
| `P2P_HUB_NETWORKING` | aan (`!= "0"`) | `0` zet het hele P2P-deel (mDNS + TLS) uit → lokale-only node. |
| `P2P_HUB_DATA_DIR` | `~/.p2p-hub` | Waar identiteit, vault en boot-token staan. |
| `P2P_HUB_PLUGINS_DIR` | `<repo>/plugins` | Waar de plugins staan (meestal niet nodig om te zetten). |
| `P2P_HUB_VAULT_KEY` | dev-fallback | Masterkey voor de vault. Zet er een eigen, sterke waarde op; zonder geldige waarde draait de server met een luide dev-fallback. |
| `P2P_HUB_BOOT_TOKEN` | per-boot random | Overschrijf het per-boot token (hoeft meestal niet; zie handleiding 02). |

> Belangrijk: de identiteit en vault van beide stations staan elk in hun eigen
> `P2P_HUB_DATA_DIR`. Er wordt geen vault gedeeld — de stations worden via P2P
> aan elkaar voorgesteld, niet via een gedeelde schijf.

## Volgende stap

Handleiding 02 — bouwen, starten en de boot-token lezen.
