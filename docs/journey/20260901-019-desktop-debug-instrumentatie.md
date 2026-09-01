# 019 – Desktop-app (installed) debug-instrumentatie

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-09-01 |
| **Opdracht/brief** | Desktop shell operabiliteit; vervolg op `docs/journey/20260828-017-core-server-sea-binary.md` |
| **Commits** | `d7c59ed` (CORS + CREATE_NO_WINDOW), `86b68b4` (docs gh-token), `d43c334` (stderr-redirect), `a8fd7cb` (instrumentatie) — via PR #12 (gemerged, merge-commit `a6a62a7`) en PR #13 (open) |
| **Wiki-sectie** | `docs/wiki/019-desktop-debug-instrumentatie.md` |

## Context

De geïnstalleerde Windows-desktopapp (Tauri-shell + SEA core-server) vertoonde
twee opeenvolgende onverklaarbare verschijnselen die op de dev-machine niet
reproduceerden: (1) een donkerblauw scherm (`bg-slate-950`-fallback) in plaats
van de UI, en (2) na het invullen van de dev-master-key een `"internal error"`
(HTTP 500) op vault-unlock, met de echte exceptie uitsluitend zichtbaar op de
Windows-box — die voor de gebruiker onzichtbaar was.

De root-cause van (1) was een **CORS-gat**: de Tauri-webview-origin
(`http://tauri.localhost` op Windows) is cross-origin ten opzichte van de
loopback-bridge, en elke `/api/*`-fetch draagt een `Authorization`-header → de
browser stuurde eerst een preflight (OPTIONS, zonder token), die de server met
401 beantwoordde → `gateKnown` bleef onwaar → fallback-scherm. Dev werkte wél
omdat de Vite-proxy same-origin maakt.

De 500 in (2) reproduceerde lokaal niet (dev-key + vault → 200 ok); de fout
moest dus op de doelmachine zelf zichtbaar gemaakt worden, zonder nog een
speculatieve boot-fix te schrijven.

## Besluiten

### 019.1 — CORS-grant beperkt tot `/api/*`, origin-echo deny-by-default

`apps/core-server/src/cors.ts` + `app.ts:672-701`: OPTIONS-preflight op
`/api/*` wordt vóór de tokengate beantwoord (204 + CORS-headers); daadwerkelijke
`/api/*`-responses krijgen `Access-Control-Allow-Origin` alleen wanneer de
`Origin`-host loopback/`localhost`/`tauri.localhost`/`tauri:` is. Buiten
`/api/*` geen CORS-headers (de tokenloze `/site` `/ui` `/remote-site`
`/peersite`-surfaces zijn iframes en krijgen bewust geen fetch-read-surface).
De boot-token blijft de bindende controle; CORS beslist alleen of een browser
het antwoord mag *lezen* (CLAUDE.md: accepted risk rond preflight-voor-tokengate
gedocumenteerd in `app.ts`).

### 019.2 — CREATE_NO_WINDOW + stderr-drain naar `<dataDir>/core-server.log`

`apps/desktop-shell/src-tauri/src/sidecar.rs`: de core-server wordt op Windows
met `CREATE_NO_WINDOW` gestart (geen eigen console-venster meer). Alle stdout
die niet de `[P2P_HUB_READY]`-handshake is wordt via de drainer naar stderr en
daarna naar `<dataDir>/core-server.log` geschreven. Zonder deze drain was stderr
in de geïnstalleerde app volledig weg — een crash was onvindbaar. Het
`[P2P_HUB_READY]`-protocol (met boot-token) blijft stdout-only en wordt nooit
gelogd.

### 019.3 — Sidecar-mode loglevel `debug` by default

`apps/core-server/src/logger.ts`: bij `P2P_HUB_SIDECAR_READY=1` (desktop shell)
zakt het default-loglevel naar `debug` (expliciet `P2P_HUB_LOG_LEVEL` wint). Het
logbestand is er voor troubleshooting en begint dus verbose.

### 019.4 — 500-responses dragen `detail`; request-trace; fatal-handlers

`apps/core-server/src/app.ts`:
- elke HTTP-request logt zijn completion-status (≥400 op `warn`, anders
  `debug`) via `res.on("finish")` — de request-trace in het logbestand;
- de catch in `handleHttp` logt `request failed: <method> <path>` mét stack en
  geeft `{ error: "internal error", detail: <message> }` terug — de echte
  exceptiemelding reist dus mee naar de toast, de stack blijft server-side.

`apps/core-server/src/index.ts`: `uncaughtException`/`unhandledRejection`
worden door de logger gerouteerd (met stack) vóór `process.exit(1)` — Node's
default-gedrag (crash + stderr) verandert niet, maar het landt nu gegarandeerd
op schijf.

### 019.5 — `POST /api/debug/log`: token-gated webview-diagnostiek

`apps/core-server/src/routes/operator.ts`: nieuwe route onder het bestaande
`/api`-token-gate. Accepteert `{level, message, context}`, mapt level op de pino-
set, kapt de message af op 4 kB, tagt `source: "webview"`. Permissief (slechte
level/message degraderen naar defaults — een falende webview mag het nooit
erger maken) en bewust **niet** achter de vault-lock: dit is het kanaal waarop
het lock-scherm zelf zijn fouten rapporteert.

### 019.6 — Webview-diagnostics capture (`diagnostics.ts`)

`apps/desktop-shell/src/services/diagnostics.ts` + `main.tsx`: `window.onerror`,
`unhandledrejection` en `console.*` worden gespiegeld naar `/api/debug/log`
(throttled: zelfde level+message max 1×/30s; best-effort, gooit nooit). De
eerder stille catches in `refreshHealth`/`refreshVault`/`refreshCapabilities`
en de WS-frame-catch loggen nu via `console.error`, zodat ze het log halen.
`unlockVault` toont `detail` vóór `error` in de toast (de 500-reden wordt dus
direct zichtbaar).

### 019.7 — Shell-spawn-fout landt in hetzelfde logbestand

`apps/desktop-shell/src-tauri/src/lib.rs` (`append_core_log`): als de sidecar
helemaal niet start (er is dan géén drain die een log schrijft), appenden we
de fout zelf naar `<dataDir>/core-server.log` — het enige boot-geval waarin het
log alleen kan bestaan als wij het creëren.

## Alternatieven overwogen

- Speculatieve boot-fix voor de 500 — afgewezen: lokaal reproduceert het pad
  met 200 ok; eerst de echte exceptie zichtbaar maken.
- Pretty-printing in het logbestand — afgewezen: pino-pretty vereist een TTY;
  het JSON-contract op stdout (en dus in het bestand) blijft machine-parseerbaar.
- Alleen stderr-echo in de shell, geen `/api/debug/log` — afgewezen: de webview
  kan het logbestand niet lezen; het kanaal moest server-side landen.
- `rejectUnauthorized: false`-achtige hacks — niet van toepassing; geen TLS-
  wijziging in deze slice (CLAUDE.md principe #4 blijft geldig voor P2P).

## Gevolgen & grenzen

- De webview-kant kan de *stapel* van een server-exceptie niet zien (blijft
  server-side), maar `detail` geeft de melding — genoeg voor gerichte triage.
- `console.*`-spiegeling schakelt de webview-devtools niet uit (wrap roept het
  origineel aan) en is gebonden aan de throttel om poll-ruis te beperken.
- Verbose logging in sidecar-mode kan groter worden; bewust accepteerde
  trade-off voor een single-user desktop.
- Open follow-up: de werkelijke 500-oorzaak van de unlock op de doelmachine
  (verwacht in `finishBoot` → `startNetworking`, TLS-bind/mDNS) zodra de log uit
  de nieuwe build binnen is.

## Status & testbewijs

- Gebouwd. `tsc -b` groen; core-server `207/207` (`vault-gate.test.ts` +
  `/api/debug/log`-test: accept/permissief/token-gate); desktop-shell `53/53`
  (`core-bridge.test.ts`: `detail`-surfacing, `reportClientError` auth +
  swallow-on-failure); `cargo check` groen.
- PR #12 (CORS + console) gemerged in `main` (`a6a62a7`); PR #13
  (stderr-redirect + instrumentatie) open.

## Gerelateerd

- `docs/journey/20260828-017-core-server-sea-binary.md` (SEA-sidecar, handshake)
- `docs/journey/20260828-018-dns-rebinding-host-allowlist.md` (HostGate)
- CLAUDE.md: boot-token, accepted-risk WS `?token=`, CORS-sectie
