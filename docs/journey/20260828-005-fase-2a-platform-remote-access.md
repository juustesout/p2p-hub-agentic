# 005 – Fase 2A: platform-afgedwongen remote access (TaskBroker)

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 (vastlegging van werk sinds begin van het traject) |
| **Opdracht/brief** | plan.md Fase 2A + `docs/skill-authorization.md` |
| **Commits** | `1d5a22f`, `4128ff1` (centralisatie in `checkPeerAccess`), `9acdcfb` (broker-`RemoteGate` migratie) |
| **Wiki-sectie** | `docs/wiki/02-security-and-trust-model.md` |

## Context

Wie mag een skill over het netwerk aanroepen was een per-plugin conventie.
Remote-access-autorisatie moest **platform-afgedwongen** worden, op één punt.

## Besluiten

- **TaskBroker = het enige enforcement point.** `core/src/task-broker/remote-access.ts`:
  een skill declareert bij registratie een `remote`-policy
  (`{ gate: "verified-contact" | "access-pass" | "any" | […OR…], scope? }`);
  `handleRemote` evalueert die **vóór** dispatch — de handler draait nooit als de
  gate dicht is.
- **Fail-closed op elke manier** — network-exposed skill (`localOnly: false`)
  zonder policy ⇒ deny; `access-pass` vereist een `scope` (luid bij registratie);
  anonieme remote caller (geen transport-geverifieerde `peerId`, Fase 1B) kan nooit
  aan `verified-contact`/`access-pass` voldoen; een gooiende gate opent niet.
- **`any` is expliciet publiek** — vereist manifest-permissie `network:public:<id>.<skill>`
  bovenop `network:skill:<id>.<skill>`.
- **Access passes zijn geen bearer tokens** — `AccessPassManager` + `ctx.access`
  (issue/revoke/hasPass): ephemeral, scoped, expiring per-peer; de peer bewijst
  possession over het transport.
- **Centralisatie** — `core/src/security/peer-access-gate.ts`: één fail-closed
  `checkPeerAccess(peerId, options, context)`-primitive (OR over modes,
  `allowSelf` alleen uit `context.selfPeerId`); de broker-`RemoteGate` is er
  naar gemigreerd (`9acdcfb`) zodat de peerauthorisatie niet twee OR-implementaties
  kent.

## Status & testbewijs

GEDONE; broker-gate-tests (deny/allow/fail-closed/anoniem/geen-gate/OR/`any`/
peerId-context/gooiende gate) + `checkPeerAccess`-units (21). Basis voor 002
(`requestMutation` = `verified-contact`) en 016 (governance-matrix = narrowing op
deze gate).
