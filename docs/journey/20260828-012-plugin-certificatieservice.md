# 012 – Stap 3: plugin-certificatieservice & AST-scanner

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 (vastlegging van werk sinds begin van het traject) |
| **Opdracht/brief** | `docs/plugin-certification-scanner.md` |
| **Commits** | `17d45e9` (brief), `7f7b5b1` (service), `d944c5d` (CLI), `02f8206` (status) |
| **Wiki-sectie** | `docs/wiki/02-security-and-trust-model.md` |

## Context

"Scanner schoon" is geen certificaat. Een certificatieservice moest de scheiding
tussen automatisering en menselijk oordeel eerlijk houden: rode vlaggen nooit
onderdrukken, beperkingen altijd luid.

## Besluiten

- **Scanner (Pijler B) als TS-service** (`core/src/certification/scanner.ts`,
  runtime-dep `typescript`) — AST-scanner (geport van een gevalideerde
  cross-check) vangt alle module-vormen (incl. `node:`-prefix,
  constant-folding, dynamische import, `(0, eval)`, `import type`-skip). Flagt
  eval/`new Function`/runtime-computed require als critical,
  sensitive-module-require als critical/advisory, `process.env`-read als advisory.
  `passed` = geen critical findings; `eval` via variabele-alias is een
  gedocumenteerde statische blinde vlek (runtime-redirection). Pijler A
  (hard-only eslint-set) bleek 0 echte bevindingen te geven op de eigen plugins.
- **Certificatie = mens-in-de-lus, los van 2C-signing** — `certification.json`:
  `{pluginId, contentHash, certifiedAt, expiresAt?, certificateVersion, reviewerId,
  signature}`; de reviewer ondertekent exact `{pluginId, contentHash, certifiedAt}`
  (Ed25519). `contentHash` = deterministische aggregatie over de 2C-file-hashkaart —
  elke byte-change breekt de binding.
- **Host-gate** — `requireCertifiedPlugins`/`reviewerPublicKeys`/
  `certificationRevocationListPath`; lege reviewerPublicKeys ⇒ niets verifieert
  (default-deny); corrupt register stopt de boot luid (CLAUDE.md #9).
- **CLI** — `scan`, `certify` (weigert bij critical findings), `revoke`
  (per contentHash, atomair, optioneel pluginId).

## Status & testbewijs

Service GEBOUWD (core 366 → 398 tests, 20/20 workspaces groen). Open slices uit de
brief: eslint-hard-only-integratie, UI-review-flow, npm-install-time window,
undefined-behaviour-only-beoordeling.
