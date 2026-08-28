# 007 – Fase 2C: manifest-signing & dot-free plugin identity

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 (vastlegging van werk sinds begin van het traject) |
| **Opdracht/brief** | plan.md Fase 2C (geen marketplace vóór signing + identity correct zijn) |
| **Commits** | `2ae864e` |
| **Wiki-sectie** | `docs/wiki/01-architecture-overview.md` |

## Context

Veilige plugindistributie vereist: een unieke plugin-identity, een verifieerbare
handtekening over de volledige content, en een oplossing voor de dotted
skill-ID-collision (`"a.b"` en `"a"` claimen beiden `b.x`).

## Besluiten

- **Dot-free plugin-ids** — `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`; de `.` is gereserveerd
  als skill/hook-namespace-scheidingsteken, dus de collisie is **structureel
  onmogelijk** (CLAUDE.md follow-up opgelost).
- **Canonieke manifest-signing** (`sdk/src/manifest-signing.ts`) — Ed25519 over een
  deterministische, gesorteerde-key-serialisatie; signer en verifier delen exact
  dezelfde bytes. `manifest.files` = SHA-256 content-hashes van élk shipped
  bestand (excl. manifest.json/node_modules/…; symlinks nooit gevolgd).
  `manifest.signature = {alg:"ed25519", publicKey, value}` in peerId-formaat.
- **Default-deny in de loader** — een manifest dat een signature claimt moet die
  bewijzen; elke content-hash moet matchen; tamper/malformed/wrong-alg ⇒
  `InvalidManifestError` + load geblokkeerd. Ongesignde plugins laden nog (dev-flow)
  maar worden één keer **luid** als unsigned/untrusted gelogd;
  `requireSignedPlugins: true` weigert ze hard.
- **Tooling** (`apps/create-p2p-plugin`) — `new`, `sign`, `keygen`, `verify`.
- **Bewuste openstaande**: first-party plugins in `plugins/` blijven ongesignd
  (content-hashes churnen bij elke build; signing bij packaging) — zie ook 012.

## Status & testbewijs

GEDONE (fundering). SDK/loader/host/CLI-tests: canonieke bytes gepind, elk veld
getamperd ⇒ fail, wrong key ⇒ fail, file-hash coverage/missing/changed ⇒ blocked.
