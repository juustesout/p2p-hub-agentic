# 17 – core-server als Single Executable Application (SEA) voor de Tauri-sidecar

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 |
| **Opdracht/brief** | Vervolg op `feat(desktop-shell): sidecar core-server` (`b999b05`) — "future SEA" follow-up |
| **Commits** | nog te committen (zie Git-status) |
| **Wiki-sectie** | `docs/wiki/017-core-server-sea-binary.md` |

## Context

De desktop-shell start de core-server als sidecar: Rust spawnt
`apps/core-server/dist/index.js` met `node`. Een gedistribueerde app heeft geen
Node; de sidecar moet zonder runtime werken. Deze slice maakt van de
core-server een Node Single Executable Application: één `p2p-hub-core`-binary
(121.8 MiB) die het volledige core-server draait op elke glibc-Linux / Windows
/ macOS-machine zonder Node.

## Besluiten

### 17.1 — esbuild CJS-bundle is de SEA-entry

`apps/core-server/scripts/build-sea.cjs` bundelt `src/index.ts` →
`dist/bundle.cjs` (platform node, target node22, minified, geen sourcemaps,
externals `["*.node", "bufferutil", "utf-8-validate"]`). De bundle is
**byte-reproduceerbaar** (twee builds, zelfde bytes) en lekt geen absolute
monorepo-paden. SEA-blob via `node --experimental-sea-config
sea-config.json` met `useCodeCache: true` — Node ≥21 stampt de V8 code-cache
al bij blob-build-tijd, er is geen "eerst draaien om te warmen"-stap
(geverifieerd: prep-blob en binary-grootte wijzigen niet na runs).

### 17.2 — Native-module-prelude in plaats van bundelen

`*.node`-addons worden nooit geïnlined. De bundle krijgt een banner-prelude:
`globalThis.crypto = webcrypto` shim + een `Module._resolveFilename`-override
die `.node`-requires opnieuw probeert vanaf `bin/lib`, `lib` en `bin` naast de
binary, en anders luid faalt met de kandidaat-paden. ws's optionele natives
(`bufferutil`, `utf-8-validate`) blijven plain runtime-requires (JS-fallback;
geverifieerd dat ws ze lazy-requiret: `lib/buffer-util.js:117`,
`lib/validation.js:144`).

### 17.3 — Injectie met postject + macOS-ad-hoc-signering

De blob wordt in een kopie van `process.execPath` geïnjecteerd met postject
(gebruikt de `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`-sentinel);
op macOS wordt het resultaat ad-hoc hertekend (injectie breekt de originele
signatuur). Outputs: `dist/bin/p2p-hub-core[.exe]` én de Tauri-copy
`src-tauri/bin/p2p-hub-core-<target-triple>` (`bundle.externalBin`).
Beide zijn gitignored (121.8 MiB).

### 17.4 — Rust-resolver: env-override → profiel-afhankelijke kandidaat

`apps/desktop-shell/src-tauri/src/sidecar.rs` `resolve_core_command`:
`P2P_HUB_CORE_BIN` wint altijd; release-builds prefereren de SEA-binary
(geen Node op een shipped app), debug-builds prefereren `node
<repo>/dist/index.js` (altijd vers na `npm run build`), elk valt terug op de
ander. Pure functie `pick_entrypoint(&sea, &scripts, release)` + const
`SEA_BIN_NAME` (geen hardcoded triples). `find_sea_binary_in` prefereert het
blote `p2p-hub-core[.exe]`, dan een prefix-scan op de triple-suffix.

### 17.5 — Plugins-gedrag standalone

Zonder monorepo `plugins/` valt de binary terug op `<dataDir>/plugins`
(aangemaakt, waarschuwing) in plaats van niet te booten; een expliciete maar
ontbrekende `P2P_HUB_PLUGINS_DIR` faalt luid.

### 17.6 — SIGTERM-handler vóór de ready-handshake

Gevonden en gefixt tijdens het schrijven van de regressiesuite: `index.ts`
registreerde SIGINT/SIGTERM pas **na** het emitten van de ready-line — de
test/desktop-shell stuurt SIGTERM meteen bij het lezen van die lijn, dus de
default-signaal-afhandeling kon het proces met signaal (i.p.v. `exit 0`)
doden. Handlers staan nu vóór de handshake (`src/index.ts:113-127`).

## Alternatieven overwogen

- **`node --sea-config` op de node-binary zelf (zonder esbuild)** — de
  core-server heeft meerdere packages + ws; een bloated multi-blob/asset-setup
  en geen bronminificatie. De esbuild CJS-bundle is zelfbevattend en
  reproduceerbaar.
- **Twee-fasen code-cache ("draai een keer om te warmen")** — nodig vóór Node
  21; Node 22 stampt de cache al in de prep-blob. Afgewezen als overbodig.
- **SeaSpace/assets per pakket** — meer bewegende delen; de prelude-override
  lost `.node`-requires op zonder node_modules aan boord.
- **Grotendeels gebundelde ws-natives** — onmogelijk zonder ze te compileren;
  de JS-fallback van ws is de bedoeling en blijft extern.

## Gevolgen & grenzen

- De sidecar draait zonder Node; dezelfde `[P2P_HUB_READY]`-handshake
  (`P2P_HUB_PORT=0`, `P2P_HUB_SIDECAR_READY=1`).
- **Bewust niet-doen**: de Fase-3 process-sandbox kan niet onder SEA — die
  spawnt `process.execPath` (de binary zélf) en zou zo de hele core-server
  opnieuw starten. SEA laadt plugins in-process; met geen gebundelde plugins
  is dat doorgaans "geen plugins". Bundelen/on-disk plugins onder SEA is een
  latere packaging-slice; `P2P_HUB_PLUGINS_DIR` is de escape hatch.
- Binair is dynamisch gelinkt tegen de build-machine-glibc (standaard node
  SEA-gedrag); Windows/macOS-builds moeten op resp. OS lopen.
- Volledige `tauri build`-validatie niet lokaal uitgevoerd (geen
  `cargo-tauri` geïnstalleerd); de resolver is profiel-geparame-triseerd en
  unit-getest voor beide profielen.

## Status & testbewijs

Gebouwd en getest. Suite-stand:

- `apps/core-server && npm run test:sea`: 4/4 (bundle-prelude/geen
  dev-artefacten, byte-reproduceerbaarheid, FUSE-sentinel aanwezig, standalone
  boot + clean SIGTERM-shutdown). 8 opeenvolgende runs groen.
- `cargo test` (src-tauri): 32/32 — 26 oud + 4 `sea_binary` + 6
  `pick_entrypoint` (beide profielen, fallbacks, fail-closed).
- Volledige repo `npm test`: **1040 tests / 0 fail** (core-server 146,
  desktop-shell 38).
- Handmatig standalone-boot geverifieerd onder schone env
  (`env -i PATH=/nonexistent`): handshake `[P2P_HUB_READY] {"port":…,
  "token":"…","state":"ready"}`, versie-log `p2p-hub-core v0.1.0`,
  SIGTERM → exit 0. Net als met `P2P_HUB_NETWORKING=0`.

## Gerelateerd

- `docs/journey/20260828-011-fase-3-proces-sandbox.md` (sandbox-beperking hierboven)
- `HERMES.md` — sectie "Standalone core-server binary (`p2p-hub-core`, SEA)"
- `apps/core-server/scripts/build-sea.cjs`, `scripts/test-sea.cjs`,
  `apps/desktop-shell/src-tauri/src/sidecar.rs`
