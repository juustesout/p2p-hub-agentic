# 006 – Fase 2B: capability-matrix & derde-partij plugin security

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 (vastlegging van werk sinds begin van het traject) |
| **Opdracht/brief** | plan.md Fase 2B — **Optie 1**: capability-matrix-verscherping zonder proces-isolatie (expliciet geaccordeerd) |
| **Commits** | `614b34f` |
| **Wiki-sectie** | `docs/wiki/02-security-and-trust-model.md` |

## Context

Derde-partij-plugins kregen geen automatische OS/fs/netwerk-rechten. De
capability-matrix is de autoriteitsgrens, structureel afgedwongen op élke surface
die eerder op documentatie/aannames leunde. Harde OS-isolatie bleef een documented
accepted risk → Fase 3.

## Besluiten

1. **HTTP-bridge opt-in** — `httpExposed: true` vereist manifest-permissie
   `network:http:<id>.<skill>` vóór laden (onafhankelijke surface, eigen gate;
   CLAUDE.md #1).
2. **`ctx.dataDir`-scoping** — plugins krijgen `<dataDir>/plugins/<pluginId>`;
   `isPathInsideDataDir` (trailing-separator-geankerd, realpath-aware) beschermt de
   echte datadir tegen user-supplied paden.
3. **Cross-namespace `hooks.on`-gating** — vereist `hooks:on:<event>`-permissie bij
   een ander namespace (delimiter-geankerd `<id>:`-prefix); eigen namespace vrij.
4. **`ctx.identity` structurele domain separation** — `sign(domain, data)`/
   `verify(pub, domain, data, sig)` met verplicht domein dat core prependt
   (`domain ‖ data`); een plugin kan nooit raw caller-gekozen bytes tekenen.
5. **Plugin-UI-server `/ui/<pluginId>/*`** — hardened CSP (`default-src 'none';
   script-src 'self'` …), loopback-gate, `resolveAndContainFile`-containment,
   **geen boot-token** (een token in de iframe-URL is leesbaar door de plugin-code
   zelf — daarmee zou een sandboxed plugin elk `/api/*`-skill kunnen aanroepen).
6. **Plugin-UI bridge (shell)** — sandboxed iframe + **origin-gepinde**
   `plugin-bridge.ts` (alleen exacte `CORE_ORIGIN`), manifest-gedeclareerde
   `ui.skills`-allowlist (geen `"*"`), elke entry in eigen namespace + matching
   `network:http:`-permissie.

## Status & testbewijs

GEDONE (Scoped 2B, Optie 1). 484 tests / 0 fail ten tijde van afronding. Principe #10
(geen boot-token in /ui) is een blijvende architectuur-richtlijn; hieruit volgde
later de site-mirror van 008 en de source-pinning voor shared-origin surfaces.
