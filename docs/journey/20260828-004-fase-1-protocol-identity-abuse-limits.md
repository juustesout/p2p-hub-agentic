# 004 – Fase 1: protocolcontract, identity binding & abuse limits

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 (vastlegging van werk sinds begin van het traject) |
| **Opdracht/brief** | plan.md Fase 1A–1C |
| **Commits** | `0697fa8` (1A), `633c9f4` (1B/1C), `207481e` (retrofit: transport identity verplicht), `06d9318` (keep-alive + remote capabilities) |
| **Wiki-sectie** | `docs/wiki/02-security-and-trust-model.md` |

## Context

Regel: **een P2P-peer is een onbetrouwbare externe actor, ook op eigen
machine/LAN**. `network-light` (mDNS + TLS) moest vóór verdere uitbreiding een
expliciet wire-contract en een verifieerbare identiteitsketen krijgen.

## Besluiten

- **1A Wire-contract & handshake** — `plugins/network-light/src/wire-contract.ts`:
  frame `[4-byte BE lengte][UTF-8 JSON]`, envelope `{protocol, version, type, body}`
  in canonieke veldvolgorde, gepinde bytes in tests; `negotiateVersion` (hoogste
  overlap, anders close), `parseEnvelope` default-denied op onbekend
  protocol/versie/vorm. Elke connectie start met hello → hello_ack over de
  fingerprint-geverifieerde TLS-sessie; `maxPayloadBytes`-limiet beide kanten.
  Bytes zijn de source of truth — proza-spec in de docblock zodat een onafhankelijke
  implementatie interoperabel kan zijn zonder TS te delen.
- **1B Identity binding / cert-pinning** — hello draagt client-nonce, hello_ack
  server-nonce + `{peerId, certFingerprint, signature}`; nieuwe `auth`-message
  vóór de eerste task. Signature = Ed25519 over
  `IDENTITY_BINDING_CONTEXT ‖ clientNonce ‖ ":" ‖ serverNonce ‖ ":" ‖ certFingerprint`;
  verificatie bewijst "claimed peerId ↔ Ed25519 key ↔ transport cert" in één stap.
  Beide nonces + fingerprint in de signature maken cross-connectie-replay onmogelijk.
  Mutual TLS (`requestCert: true`, **nooit** `rejectUnauthorized: true`); de private
  key blijft in `IdentityManager`, de provider krijgt alleen ondertekende bytes
  (`identitySigner`-capability).
- **1C Peer-level abuse protection** — `peer-limiter.ts`: per-IP caps
  (maxConnectionsPerIp, maxConcurrentTasksPerIp, maxRequestsPerWindowPerIp),
  connectie-cap vóór byte-parse, task-concurrency bij dispatch, payload-size via
  het SDK-guard `validatePayloadSize` in `tryDecodeFrame`.
- **Retrofit** — transport-identity werd later verplicht (niet meer optioneel in de
  handshake): een peer zonder bewezen identiteit is een anonieme caller die de
  verified-contact-gates nooit passeert.

## Status & testbewijs

1A/1B/1C GEDONE; gepinde wire-bytes + default-deny + abuse-limit tests. Fundering
voor 001 (WAN): dezelfde identity-binding-keten geldt over libp2p.
