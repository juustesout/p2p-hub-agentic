# 002 – SmartProjects v1.1: single-writer concurrency, dynamische topic-auth, proof-of-completion

| | |
|---|---|
| **Status** | Accepted |
| **Datum** | 2026-08-28 |
| **Opdracht/brief** | SmartProjects v1.1: samenwerkingslaag bovenop `plugins/tasks` (dependencies, delegatie, proofs, plugin-UI) |
| **Commits** | `a759465` (per-peer subscription guards + bounded topics), `35793e2` (tasks v1.1), `3211035` (Stap 5 pub/sub-funderstuk) |
| **Wiki-sectie** | `docs/wiki/04-smartprojects-engine.md` |

## Context

`plugins/tasks` (SmartProjects) beheert projecten/taken op één node. v1.1 voegt de
**samenwerkingslaag** toe: taken krijgen dependencies, kunnen aan een netwerk-peer
worden gedelegeerd, en de voltooiing wordt door de toegewezen peer cryptografisch
bewezen — allemaal over de bestaande event-bus (Stap 5) en de TaskBroker-gates
(Fase 2A). Scope-besluit: v1.1 breidt **uitsluitend `plugins/tasks`** uit; er
komen geen nieuwe netwerk- of vertrouwensgrenzen bij — het platform (broker,
events, identity) levert de mechanismen, de plugin alleen het projectdomein.

## Besluiten

### 002.1 — Single-Writer FIFO concurrency (geen CRDT's)

Geen conflict-resolution-algoritmen. De **project-eigenaar is autoritair**: alle
incoming mutatie-requests (lokaal én via de netwerk-skill `requestMutation`,
gated `verified-contact`) worden **sequentieel in één deterministische queue**
verwerkt. Elke mutatie krijgt een monotoon `mutationSeq`. De enqueue gebeurt
**synchroon vóór de eerste await** — daardoor is de volgorde van `Promise.allSettled`
op dezelfde event-loop per definitie de aanroepvolgorde en is de uitkomst zelf het
orderingsbewijs, zonder enige timing-heuristiek. De FIFO-test bewijst dit: drie
mutaties in één `allSettled` — de tweede faalt deterministisch (`not pending
(status: accepted)`) en de mutationSeq-asserties kloppen.

Reden: de workflow is lineair (assign → accept → sign → submit → done); een CRDT
zou conflicten slechts uitstellen en introduceert sync-complexiteit die de
overheidsrol van de eigenaar ondermijnt. Single-writer is de eerlijke, testbare
invulling van "de eigenaar beslist".

### 002.2 — Dynamische topic-authorisatie: per-project SubscriptionGuard

Remote events zijn per-project genamespaced: `tasks:project:<projectId>:*`
(concreet `tasks:project:<id>:updated`), gedeclareerd als
`"exposedEvents": ["tasks:project:*"]` in `manifest.json`. Statische exposure is
echter te grof: elk project in de workspace zou zo door elke geverifieerde peer
subscribable worden. Daarom hangt de plugin een **per-peer guard** op
(`ctx.events.registerSubscriptionGuard("tasks:project:", guardProjectTopic)` in
`plugins/tasks/src/index.ts:2013`). De guard:

- is **delimiter-geankerd** op het namespace-prefix `tasks:project:` (geen
  `startsWith("tasks:project")`-prefixlek, CLAUDE.md #2);
- valideert `projectId` tegen `^[A-Za-z0-9][A-Za-z0-9_.-]*$` (+ optioneel
  `:updated`-suffix) en controleert dat de caller in het projectlidmaatschap zit;
- wordt geconsulteerd **bovenop** de statische `exposedEvents`-gate, bij subscribe
  én vóór élke `event_emit`-dispatch naar een al gesubscribeerde peer — een peer
  die na subscribe uit het project wordt gehaald, stopt onmiddellijk met
  ontvangen;
- faalt **closed**: een guard die ontbreekt, gooit of niet past ⇒ deny.

De guard-functionaliteit zelf (fail-closed, meerdere guards per event, wildcard-re-auth)
is algemeen in de `SubscriptionHub` gebouwd (`core/src/events/subscription-hub.ts`,
`subscription-hub-guard.test.ts`) — `tasks` is de eerste afnemer.

### 002.3 — Cryptografische proof-of-completion met structurele domain separation

De toegewezen peer bewijst dat hij de taak voltooid heeft door de **eigenaar** een
handtekening te sturen over een payload met **verplichte domeinbinding**:

```
payload  = COMPLETION_PROOF_DOMAIN_PREFIX + "<taskId>:<projectId>:<timestamp>"
prefix   = "p2p-hub:tasks:completion-proof:v1:"
signature = ctx.identity.sign(prefix, payload)   // domein wordt door core prependt
```

De eigenaar verifieert met `ctx.identity.verify(publicKeyHex, prefix, payload, sig)`
onder exact dezelfde prefix. Omdat core het domein **structureel** prependt
(`domain ‖ data`, Fase 2B), is een signature uit een ander domein
(`p2p-hub:chat:message:v1:`) bytes-gewijs betekenisloos — de tests bewijzen dat
met een vreemd-domein-signature die netjes faalt. Verder:

- `signedBy` moet gelijk zijn aan de **transport-geverifieerde afzender** (een
  forged `signedBy` of een corrupte signature faalt);
- een proof vóór accept wordt geweigerd (levenscyclus: delegate → accept → sign →
  submit → done); declined blijft definitief rejected.

Onderliggende beschermingslaag: de dependency-guard — een taak met niet-`done`
`dependencies[]` kan (lokaal én via `requestMutation`) niet naar `in-progress`/`done`,
en de done-cascade kan geen onafgewerkte dep meeslepen (fout `Invalid Dependency
State`).

## Alternatieven overwogen

- **CRDT / LWW-conflict-resolution** — complex, ondermijnt de overheidsrol van de
  eigenaar, levert geen testbaar ordeningsbewijs; afgewezen voor lineaire workflows.
- **Statische `exposedEvents`-exposure zonder guard** — projecttopics zouden naar
  élke geverifieerde peer lekken; per-project membership-check toegevoegd.
- **Client-side signature zonder domeinbinding** — een signature die in een ander
  protocol gedomineerd is (bv. chat) zou herbruikbaar zijn; de v1:-prefix-constante
  is verplicht, geen optionele conventie.

## Gevolgen & grenzen

- De eigenaar is de single-writer bottleneck — accepté voor project-schaal; een
  multi-writer project is een bewust niet-doel.
- Guard-semantiek is per-surface consistent (broker/events apart geïmplementeerd,
  beide fail-closed); nieuwe `tasks:project:*`-emits buiten de guard zijn een
  regressie-risico.
- Tweede node in tests vereist een eigen `IdentityManager`-instantie (eigen vault,
  eigen keypair) — daarom exporteert `@p2p-hub/core` nu `IdentityManager`
  (`core/src/index.ts`), zodat `sign`/`verify` structureel over node-grenzen werkt.
- Plugin-UI mutaties verlopen uitsluitend via 13 manifest-declared
  `httpBridgeOnly`-skills (lokaal operatorprivilege, structureel nooit peer-facing);
  `requestMutation` blijft de enige net-skill.

## Status & testbewijs

Gebouwd. `plugins/tasks/src/tasks.test.ts`: 28 tests (10 nieuw in v1.1) — guard
lokaal + netwerkpad, dependency-cascade, delegatie-handshake met echte tweede node
(eigen vault + identity), domain-separation-afwijzingen (verkeerde timestamp,
corrupte sig, vreemd domein, forged `signedBy`), FIFO-zonder-timing,
computations-units (critical path, capacity, working days). **999 tests / 0 fail**
(root `npm run build && npm test`).

## Gerelateerd

- `015` (Stap 5: P2P pub/sub — de event-laag waarop de guard draait)
- `005` (Fase 2A: TaskBroker `verified-contact`-gate voor `requestMutation`)
- `006` (Fase 2B: structurele domain separation via `ctx.identity`)
- `plugins/tasks/src/types.ts:46` (`COMPLETION_PROOF_DOMAIN_PREFIX`)
