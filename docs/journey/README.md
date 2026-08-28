# docs/journey — gestructureerde architectuurhistorie

**Bron van waarheid** voor architectuurbesluiten en ontwerpsessies. `docs/wiki/`
wordt hieruit gegenereerd (door Hermes, op basis van deze bronbestanden).

## Nummering & layering

- `0000-template.md` — kopieer dit voor een nieuwe aantekening.
- Bestandsnaam = `JJJJMMDD-NNN-kebab-slug.md` (datum van de sessie, oplopend
  nummer). Logs die bestaand werk *vastleggen* krijgen de datum van vastlegging;
  het `Datum`-veld in de tabel houdt de werkelijke sessiedatum.
- Eén log per **brief / grotere opdracht**. Vervolgslices horen in hetzelfde log
  (extra sectie + commit-referenties), niet in een nieuw nummer.
- Statusveld in de tabel: `Accepted` / `Proposed` / `Superseded-by <NN>`.

## Register

| Log | Titel | Wiki-sectie |
| --- | --- | --- |
| `001` | WAN-transport via operator circuit-relay (network-libp2p) | `03-wan-networking-and-relays.md` |
| `002` | SmartProjects v1.1: single-writer concurrency, topic-auth, proof-of-completion | `04-smartprojects-engine.md` |
| `003` | Fase 0 — fundering, multi-peer testlab & cross-platform CI | `01-architecture-overview.md` |
| `004` | Fase 1 — protocolcontract, identity binding & abuse limits | `02-security-and-trust-model.md` |
| `005` | Fase 2A — platform-afgedwongen remote access (TaskBroker) | `02-security-and-trust-model.md` |
| `006` | Fase 2B — capability-matrix & derde-partij plugin security | `02-security-and-trust-model.md` |
| `007` | Fase 2C — manifest-signing & dot-free plugin identity | `01-architecture-overview.md` |
| `008` | Fase 2-Eindcriterium — P2P static website (`p2p-hub:website:v1`) | `05-p2p-content-sharing.md` |
| `009` | PeerSite — Fase 2 t/m 4B (ctx.trust, site-containment, passes, ENS) | `05-p2p-content-sharing.md` |
| `010` | A1 — agent-identiteit, media-gate & telemetrie-frequentiecaps | `02-security-and-trust-model.md` |
| `011` | Fase 3 — proces-sandbox (crash/abuse-containment, géén OS-sandbox) | `02-security-and-trust-model.md` |
| `012` | Stap 3 — plugin-certificatieservice & AST-scanner | `02-security-and-trust-model.md` |
| `013` | Stap 4 — `p2p-hub:media:v1` sessie-capability | `02-security-and-trust-model.md` |
| `014` | Netwerklaag — one-sided mDNS-fix + `ctx.network`-wiring | `03-wan-networking-and-relays.md` |
| `015` | Stap 5 — P2P pub/sub (distributed subscriptions & event framing) | `07-realtime-events-and-subscriptions.md` |
| `016` | Stap 6 — Trust Governance & Management Interface | `02-security-and-trust-model.md` |

De wiki-slugs zijn *voorstellen* (01–07); Hermes mag de `docs/wiki/`-indeling
aanpassen zolang de koppeling per log behouden blijft.
