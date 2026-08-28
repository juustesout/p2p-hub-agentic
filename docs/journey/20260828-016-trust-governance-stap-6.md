# 016 – Stap 6: Trust Governance & Management Interface

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 (vastlegging van werk sinds begin van het traject) |
| **Opdracht/brief** | Stap 6: Trust Governance & Management Interface (plan.md) |
| **Commits** | `7809c3a` |
| **Wiki-sectie** | `docs/wiki/02-security-and-trust-model.md` |

## Context

Een operator-oppervlakte om te bepalen wát een peer over het netwerk mag: de
matrix moet de TaskBroker-gates verfijnen zonder ze te kunnen verbreden.

## Besluiten

- **Permissiematrix = intersectie, geen unie** —
  `EffectiveAccess = ManifestExposed ∩ PeerMatrixAllowed ∩ VerifiedStatus`. De
  matrix is een **narrowing-only** store: élke skill/topic in een entry wordt bij
  schrijven gevalideerd tegen de live manifest-geëxposeerde catalog
  (`AccessDeniedError` ⇒ 403) — een entry kan een skill structureel nooit openen
  die het manifest niet exposeert. In de broker geïnjecteerd als `PeerSkillGate`;
  de broker-`localOnly`/`httpBridgeOnly`/`remote`-checks blijven onafhankelijk
  doorlopen. Peers zónder entry houden de manifest-default.
- **Governance-API** — `GET /api/governance/v1/{catalog,topology,matrix}`,
  `POST …/peers/:peerId/verify`, `PUT|DELETE …/peers/:peerId/permissions`,
  authenticated SSE `…/stream`.
- **Tier-2 verplicht op alle writes** — `POST /verify` en `PUT/DELETE /permissions`
  (én de `governance-ui.*`-bridgeskills) door `TrustTierGate.authorize("critical", …,
  { authenticated: true })`; boot-token alleen is onvoldoende. Persistentie atomair
  (`<dataDir>/governance-matrix.json`, corrupt ⇒ `StorageCorruptionError`).
- **Topology = functioneel-only** — `peerId`, `displayName`, `trustState`,
  `lastSeen`, `activeSubscriptions`, per-peer matrix-entry; **nooit**
  address/RTT/bandwidth (topology-leak-preventie, getest).
- **`governance-ui`-plugin = admin HTTP bridge** — alle zes skills
  `httpBridgeOnly: true`, door core-server geregistreerd; `customRateLimit`
  bounded (`1..500`, daarboven ⇒ 422).

## Status & testbewijs

GEDONE. 4 broker-unit + 18 governance (matrix/HTTP/SSE: delta-replay + heartbeat +
fresh-subscriber-replay) + 3 governance-ui-plugin tests. Full suite 0 fail.
