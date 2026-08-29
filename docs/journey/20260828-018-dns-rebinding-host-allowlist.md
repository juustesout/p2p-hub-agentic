# 18 – DNS-rebinding-bescherming: Host-header-allowlist op élke core-server-route

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 |
| **Opdracht/brief** | GitHub Agent finding "[SECURITY][HIGH] DNS rebinding bypasses auth on /site, /ui, and /remote-site" (2026-08-28) |
| **Commits** | nog te committen |
| **Wiki-sectie** | `docs/wiki/018-dns-rebinding-host-allowlist.md` |

## Context

De core-server verdedigt `/api/*` en `/ws` met een per-boot token, maar de
bewust tokenloze surfaces (`/site`, `/ui`, `/remote-site`, `/peersite/status`)
waren alleen op loopback *gebonden*. Loopback-binding stopt netwerktoegang van
andere machines, maar géén DNS-rebinding: zodra `evil.com` naar `127.0.0.1`
resolved, stuurt de browser van het slachtoffer same-origin-requests die de
attacker *kan lezen*. `/remote-site` triggert bij een cache-miss bovendien een
uitgaande, geauthenticeerde peer-fetch namens de node (confused deputy).

## Besluiten

### 18.1 — Uniforme Host-header-allowlist (`HostGate`) als deny-by-default gate

Nieuwe module `apps/core-server/src/host-validation.ts`: `hostFromHeader`
(poort strippen, IPv6-brackets, lowercase; `null` bij absent/malformed) +
`HostGate` (per-boot gebouwd; `os.networkInterfaces()` is niet gratis). De gate
draait in `handleHttp` **vóór** de `/api`-token-gate, op élk pad, én in de
`/ws`-upgrade (via `WsActivityBus.handleSocket`, naast `isAuthorized`). De
allowlist:

- Loopback (`localhost`, `127.0.0.0/8`, `::1`, `::ffff:127.0.0.1`) altijd.
- Niet-loopback uitsluitend bij `P2P_HUB_EXPOSE=1` én host ∈ {configured bind
  adres} ∪ {eigen interface-adressen} — nooit willekeurig (geen wildcard zodra
  exposed). `P2P_HUB_ALLOWED_HOSTS` (comma-separated, `config.ts` →
  `CoreServerOptions.allowedHosts`) voegt operator-hostnames toe.
- Ontbrekende `Host`-header → 403 (fail-closed; HTTP/1.0 bereikt de handler
  wél zonder Host, HTTP/1.1 wordt al door Node geweigerd). Bewijs: 403 over
  alle routes, generiek `{ error: "forbidden" }`, alleen server-side gelogd
  (geen pad/token in de log — de token-log-hygiene-test blijft groen).

### 18.2 — Fetch-budget op `/remote-site/*` cache-misses

`SitesContext.allowRemoteFetch()` → `CoreServer.remoteFetchLimiter`
(`FixedWindowLimiter`, nieuwe module `src/fixed-window.ts`, 30/min,
`REMOTE_SITE_FETCH_RATE_LIMIT` in `routes/helpers.ts`). In `serveRemoteSite`
wordt de limiter geconsulteerd **vóór** `mirrorFetchAndStore`; over de cap
antwoordt een miss 429 zonder ook maar één peer te dialen. Mirror-hits zijn
disk-reads en raken het budget nooit. Dezelfde `FixedWindowLimiter` vervangt nu
ook de inline per-IP `allowMessage`-counter in `app.ts` (DRY, zelfde
semantiek).

## Alternatieven overwogen

- **Origin/Referer-verificatie op fetch-routes (Gemini-voorstel)** — bewust
  niet toegevoegd. (a) SOP/CORS blokkeert cross-origin *reads* op deze
  tokenloze routes al (geen `Access-Control-Allow-Origin`); de enige "actie" —
  de uitgaande fetch — is al gecapt. (b) Een Origin-gate moet de Tauri-webview
  (niet-loopback origin), de Vite-dev-origin en directe navigatie (geen
  Origin-header) allemaal toestaan of breekt legitieme flows. (c) Niet-browser
  clients kunnen Origin toch vrij invullen — het is geen echt vertrouwensgrens.
- **Scoped credential op `/site`/`/ui`/`/remote-site`** — de GitHub Agent stelde
  dit voor, maar het breekt PeerSite's kernfunctie (gewoon browsen) en een token
  in de URL van een sandboxed iframe is principieel verboden (principe #10).
- **Routes uitschakelen tenzij gehard** — te invasief; de Host-allowlist sluit
  het rebinding-pad zonder de feature te amputeren.

## Gevolgen & grenzen

- `/site`, `/ui`, `/remote-site`, `/peersite/status` blijven tokenloos voor
  toegestane hosts; `/api/*` en `/ws` eisen nog altijd het boot-token (aanvullend
  laagje, geen vervanging).
- Exposed-modus accepteert nu de eigen interface-adressen; een LAN-client op
  een machine-hostname die interface-enumeratie niet kent moet `P2P_HUB_ALLOWED_HOSTS`
  zetten.
- Bewuste niet-doelen: Origin-gating (zie boven), hostname-toegang zonder
  expliciete config, en per-peer i.p.v. globaal fetch-budget.

## Status & testbewijs

- `src/host-validation.test.ts` (9) + `src/fixed-window.test.ts` (3) +
  `src/rebinding.test.ts` (6, waaronder de volledige rebinding-sweep over
  /site, /ui, /remote-site, /peersite, /api mét/zonder token, /ws, en het
  429-fetch-budget met injectable limiter).
- Core-server: **164 tests / 0 fail**; volledige repo: **1058 tests / 0 fail**.
- SEA-binary herbouwd en handmatig geverifieerd: `Host: evil.com` → 403 op
  `/api/health` (met én zonder geldig token) en `/site/index.html`; geldige
  loopback-Host → 200; SIGTERM → exit 0.

## Gerelateerd

- `CLAUDE.md` — secties "Host-header allowlist" en "`/remote-site/*` fetch
  budget"; follow-up-item DNS-rebinding nu afgestreept.
- `docs/journey/20260828-009-peersite-2-tot-4b.md` (PeerSite Fase 2-4b,
  waarvan dit de beveiligingscorrectie is)
- `apps/core-server/src/host-validation.ts`, `src/fixed-window.ts`,
  `src/rebinding.test.ts`
