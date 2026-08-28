# 010 – A1: agent-identiteit, media-gate & telemetrie-frequentiecaps

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 (vastlegging van werk sinds begin van het traject) |
| **Opdracht/brief** | `docs/agent-identity-streaming-design.md` (besluit 1–3) |
| **Commits** | `ed26400` (slice 1), `b289903` (slice 2), `f2ea35b` (slice 3), `635437a` (slice 4) |
| **Wiki-sectie** | `docs/wiki/02-security-and-trust-model.md` |

## Context

Drie formeel vastgelegde architectuurbesluiten voor de agent-richting, op basis
van vragen die uit media/streaming-scenario's kwamen.

## Besluiten

1. **Agent krijgt altijd een eigen, afgeleide identiteit** (child-keypair, aparte
   IdentityManager-instantie), nooit de peerId van de operator. Reden: auditability,
   gedifferentieerde trust-gates, geen agent-bypass van het default-deny-model.
   `deriveChildIdentity`/`getChildIdentity`/`listChildIdentities`/
   `deleteChildIdentity`; parent-ondertekend certificaat
   (`p2p-hub:agent-identity:cert:v1`); vault-isolatie onder `identity.agent.*`.
   Broker-escalatiematrix: Tier 1 telemetry (normale gate), Tier 2 discrete acties
   (per-invocatie native goedkeuring, fail-closed zonder confirmer), Tier 3 kritiek
   (`never`). Audit-velden `initiatedBy: "operator"|"agent"` op basis van de
   transport-verified `peerId`, nooit caller-supplied.
2. **P2P-media (camera/mic) = Tier-2 native-confirm**, nooit de lichte browser-
   `getUserMedia`-popup. Een P2P-mediastroom is een andere dreiging dan "een website
   wil je camera".
3. **Capability-type-split Discrete Acties vs Lichte Telemetrie/Streams** —
   `CapabilityType = "action" | "telemetry"`; telemetrie krijgt een **per-peer
   frequency-cap** (`TelemetryRateLimiter`, sliding window per transport-verified
   peerId × skill), geen kopie van de request/response-rate-limiter. Overflow ⇒
   getypeerde `TelemetryRateLimitExceededError`; anonieme callers delen één budget.

## Status & testbewijs

Alle drie gebouwd (slices 1–4). Suite groen; details in `docs/agent-identity-streaming-design.md`.
Vastleggingseis voor de toekomst: elke IdentityManager-wijziging moet child-key
derivatie behouden.
