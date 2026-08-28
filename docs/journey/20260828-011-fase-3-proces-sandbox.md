# 011 – Fase 3: proces-sandbox (crash/abuse-containment, géén OS-sandbox)

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 (vastlegging van werk sinds begin van het traject) |
| **Opdracht/brief** | plan.md Fase 3 (Slice 1–2) |
| **Commits** | `a0c6873` (slice 1: IPC-engine), `eb507a4` (slice 2: lifecycle + dispatch) |
| **Wiki-sectie** | `docs/wiki/02-security-and-trust-model.md` |

## Context

Na 2B (capability-matrix) de volgende accorderingsstap: een plugin in een
**child-proces**. Naamgeving is cruciaal: dit is *process isolation voor
crash/abuse-containment*, géén OS-level security sandbox — de plugin draait nog
als dezelfde OS-user met volledige `require("fs")`/`require("net")`/
`require("child_process")`-toegang binnen het child. De vertrouwensgrens blijft
"Ed25519-sleutelbezitter = in-process toegang".

## Besluiten

- **`spawn()`, géén `fork()`** — fork's verborgen `'ipc'`-kanaal omzeilt de
  length-prefixed framing (onze security-boundary); met plain spawn + stdio is het
  framed protocol het **enige** kanaal.
- **IPC-engine** (`core/src/sandbox/`, `sdk/src/sandbox/`) — dependency-vrije
  JSON-RPC 2.0-subset, length-prefixed framing, `maxFrameBytes` vóór allocatie aan
  beide kanten; malformed frame ⇒ teardown (de proces-grens is de security-grens).
- **Hardening-vlaggen** — `--no-addons`, `--disallow-code-generation-from-strings`,
  `--max-old-space-size=<cap>`; `NODE_OPTIONS` altijd gestript; gefilterde env
  (geen host-credentials).
- **Fail-closed `ctx`-shim** — alleen `skills.register/unregister`, `timers`,
  `onDispose` echt; storage/hooks/ai/vault/identity/access/dataDir werpen
  `SandboxCapabilityUnavailableError`; network/trust = null.
- **Host-trust-regels** — registratieclaims uit het child worden nooit vertrouwd
  (host valideert tegen het zelf geladen manifest); PID/transport strict aan
  `pluginId` gebonden (source-pinning); TaskBroker blijft het enige autorisatiepunt.
- **Timeout/crash** — invoke-/hartslag-timeout ⇒ SIGKILL + crashed; skills
  unregistered, pending rejected met `PluginCrashError`; geen auto-respawn.
- **Permission-gates host-side** — `localOnly: false` ⇒ `network:skill:`,
  `httpExposed` ⇒ `network:http:`, gate `"any"` ⇒ `network:public:`; afwijking ⇒
  registratie geweigerd + sandbox down.

## Status & testbewijs

Slice 1 + 2 GEBOUWD. 37 (slice 1) + 16 (slice 2) nieuwe tests. Open (Slice 3+):
privilege-decoupling, host-integratie, verdere capability-proxy's, en — als
OS-isolatie ooit gewenst — een module-loader-restrictie in het child
(`--permission`/`--experimental-policy`). Zonder dat is dit GEEN security-sandbox
tegen kwaadwillige plugins — zie CLAUDE.md "Node Permission Model"-notitie.
