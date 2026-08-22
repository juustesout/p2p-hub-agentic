# Agent Identity & Streaming Guidelines — Implementation Design (A1)

Status: **design; Slice 1 (child-key derivation) and Slice 2 (shell/operator
wiring + agent policy escalation) implemented**. This document turns the three
formally-recorded decisions in `plan.md` ("Toekomstige Capabilities: Agent
Identity & Streaming Guidelines") into concrete implementation designs and a
slice plan. Treat each slice as its own scoped task, same as
`docs/peersite-plan.md`. (The subsequent Fase 3 OS-sandboxing work — the
plugin-hosting IPC engine that keeps plugins out of the host process — is a
separate workstream tracked in `plan.md` under "Fase 3: OS-level
plugin-sandboxing"; Slice 1 there is the `sdk/src/sandbox` + `core/src/sandbox`
IPC protocol/transport/runner, and Slice 2 adds the hardened `spawn` launcher,
the plugin-activating runner and the host-side `SandboxedPluginAdapter` with
skill-proxy + manifest permission gates.)

## Decision 1 — Agent identity: own derived PeerID (child-keypair)

### Goal

An AI agent gets a **derived** identity — a child keypair — never the
operator's `peerId`. Goals from `plan.md`: auditability / non-repudiation
(logs distinguish human-from-agent actions), differentiated trust-gates
(agent-initiated `sendTask` may need a stricter threshold), and no agent bypass
of the default-deny capability model.

### Why derived, not independently generated

`plan.md` offers "(child-keypair / aparte IdentityManager-instantie)". An
*independently generated* random keypair is not linkable to its operator
without a registry. A **deterministically derived** child key is provably
bound to the operator (the operator can recompute the child from the parent
seed), and the linkage is additionally **publicly verifiable** via a
parent-signed certificate — registry-free auditability. Derivation is the
stronger choice and is what CLAUDE.md's "every future IdentityManager change
must preserve the ability to derive child keys" anticipates.

### Child-key derivation

- The parent's Ed25519 private key, in JWK form, carries its 32-byte **seed**
  as `d` (`node:crypto` exports this). The seed never leaves `IdentityManager`.
- Child seed = `HKDF-SHA256(ikm = parentSeed, salt = empty, info =
  "p2p-hub:agent-identity:v1:<label>", length = 32)`. Deterministic and
  domain-separated per label.
- Child key = the seed wrapped in a **PKCS8 DER** blob
  (`SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING {
  OCTET STRING { seed } } }`). `node:crypto` computes the public key from the
  seed internally on import/export — no hand-rolled curve arithmetic.
  Verified empirically: same seed ⇒ same public key, and the derived `x`
  matches the JWK `d`-import path.
- Determinism ⇒ a child identity is **stable across restarts** and across
  fresh `IdentityManager` instances on the same vault. No separate registry.

### Persistence (vault isolation)

Child keys live under the already core-reserved `identity.` namespace:

- `identity.agent.<label>.privateKey` → PKCS8 PEM
- `identity.agent.<label>.publicKey` → hex
- `identity.agent.<label>.certificate` → the parent-signed certificate

The `identity.` prefix is in `DEFAULT_RESERVED_PREFIXES`
(`core/src/storage/vault-manager.ts`), so no plugin-facing vault surface can
read or write them — only `IdentityManager` (core) touches them.

### Auditability certificate

A parent-signed certificate binds the child to the operator without exposing
the derivation secret:

```
context  = "p2p-hub:agent-identity:cert:v1"
payload  = { context, parent, child, label, issuedAt }   // canonical, sorted keys
signature = parent signs canonicalize(payload)  // domain-separated: distinct
                                                    // from manifest/peersite/knock domains
```

`IdentityManager.verifyChildCertificate(parentPublicKeyHex, cert)` recomputes
the canonical payload and verifies with the parent's public key. Any peer with
the operator's public key can confirm "this agent identity was created by
operator X" — the auditability claim — while only the operator can produce
such a certificate.

### API shape (`IdentityManager`)

```ts
interface ChildIdentity {
  peerId: string;          // child's hex Ed25519 public key
  publicKeyHex: string;    // identical to peerId today (kept distinct in type)
  label: string;           // validated ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$
  certificate: ChildCertificate;
}

deriveChildIdentity(label: string): Promise<ChildIdentity>       // derive + persist + sign cert
getChildIdentity(label: string): Promise<ChildIdentity | null>   // load persisted
listChildIdentities(): Promise<Array<{ label: string; peerId: string }>>
static verifyChildCertificate(parentPublicKeyHex: string, cert: unknown): boolean
```

### Plugin surface (built in Slice 2, broker-level)

Agents are created by the **shell/operator**, never by plugins — no plugin
capability is added. The differentiated-trust layer (Slice 2) lives entirely in
the platform:

- `GET /api/agents`, `POST /api/agents {label}`, `DELETE /api/agents/:label` on
  the core-server HTTP bridge (boot-token guarded) let the operator create/list/
  delete agent identities. Only public material is returned (peerId,
  publicKeyHex, the operator-signed certificate, `createdAt`); the private key
  never leaves `IdentityManager`.
- `TaskBroker` gains an injected **`AgentGate`** (resolves a transport-verified
  `peerId` to an agent label via the local child-identity registry) and a
  **`TaskApprovalGate`** (per-invocation native human approval). The broker
  evaluates the three-tier escalation matrix *before dispatch*:

| Caller is a declared agent | Skill's `remote.agent.level` | Outcome |
|---|---|---|
| yes | (gate is `any`) | **denied** — the public path is structurally closed to agents |
| yes | `telemetry` (Tier 1) | allowed on the normal gate (verified-contact/access-pass), no approval |
| yes | `approved` (Tier 2, **default**) | normal gate + per-invocation native approval; no confirmer ⇒ denied |
| yes | `never` (Tier 3) | **denied** even with a passing gate |
| no | any | unchanged pre-A1 behavior |

- Handlers receive the audit facts on the network path:
  `initiatedBy: "operator" | "agent"` and `agentLabel` when agent — platform
  verdicts derived from the transport-verified identity, never caller-supplied.

The agent policy is inert until the operator creates an agent identity: no
peer is an agent by default, so existing deployments see no behavior change.

## Decision 2 — Media capabilities: Tier-2 native-confirm gate

`plan.md` decision: requesting live camera/microphone access **from a remote
peer** is a Tier-2 native-confirm action, never a lighter browser
`getUserMedia` popup.

- The `p2p-hub:media:v1` capability is **not** invocable through any route
  that skips the shell's native confirm flow. The transport delivers a media
  *request* (peer, kind: camera/mic, requested stream params); the shell shows
  the same Tier-2 native prompt as execute-skill / vault-access /
  `peersite.requestAccess` (`TrustTierGate.confirmPeerAccess` in
  `apps/core-server/src/app.ts` is the existing integration point that
  `confirmMediaRequest` mirrors). Only an approved request mints a grant.
- The browser's own permission UI stays out of this path entirely.
- **Slice 3 (done):** the SDK wire contract (`sdk/src/media-contract.ts`,
  `p2p-hub:media:v1`, fail-closed parsing, canonical serialization, no
  identity/token fields), the `media-access-request` tier-2 prompt kind, and
  the `core.media.request` skill registered by core-server
  (`apps/core-server/src/media.ts`). The handler parses the envelope
  fail-closed, requires a transport-verified `context.peerId` (Fase 1B), and
  gates every grant through `TrustTierGate.confirmMediaRequest` — no confirmer
  wired, a denial, or a throw all resolve to `denied`. It is
  `remote: { gate: "verified-contact" }` (media is sensitive, so an established
  relationship is required before the native prompt is shown), is NOT
  HTTP-exposed (the local HTTP bridge is not a media-request surface), and a
  per-peer cooldown stops a peer from spamming native prompts. The actual
  stream transport is out of scope; a grant is the verified verdict a future
  transport would consume.

## Decision 3 — Real-time traffic vs discrete actions

`plan.md` decision: the capability abstraction gets an explicit **type split**
between "Discrete Actions" and "Light Telemetry/Streams"; telemetry gets a
**per-peer frequency cap** (bandwidth/message throttling), not a copy of the
request/response rate-limiters.

- The capability/skill model gains a discriminator: `type: "action"`
  (today's behavior) vs `type: "telemetry"`.
- Telemetry frames flow at the **transport** level (continuous 20 Hz-style
  updates), so the per-peer frequency cap lives there — a token-bucket or
  fixed-window message+byte budget **per peer**, with overflow handled by
  drop/backpressure, never error-spam or connection close.
- The existing request/response controls stay exactly where they are: broker
  concurrency cap, peersite knock limits, payload-size guards, per-IP
  connection limits. No copy-paste of that logic into the streaming path.
- **Built (A1 Slice 4):** the request/response instantiation of this decision.
  `CapabilityType = "action" | "telemetry"` (`sdk/src/capability.ts`,
  fail-closed default `"action"`), declared on `SkillRegistrationOptions
  .capabilityType`. The `TaskBroker` enforces a per-peer, per-skill
  sliding-window frequency cap (`TelemetryRateLimiter`,
  `core/src/task-broker/telemetry-rate-limiter.ts`) for `"telemetry"`
  capabilities, applied inside `evaluateRemotePolicy` as the final step after
  the gate and agent matrix — a rate-limited call is never dispatched and a
  gate-denied caller never consumes a peer's budget. Overflow fails with a
  typed `TelemetryRateLimitExceededError` / `code: "telemetry-rate-limit"` on
  the `TaskResult`, distinct from a gate denial. Anonymous remote callers share
  one budget so a public `any`-gated telemetry skill cannot be flooded. The
  *transport-level* frequency cap for continuous streaming frames (20 Hz-style)
  is still a later slice — the broker limiter covers Tier-1 telemetry calls
  today.

## Slice plan

- **Slice 1 (done):** Decision 1 core — `deriveChildIdentity` / persistence /
  parent-signed certificate / `verifyChildCertificate` / `listChildIdentities` /
  `deleteChildIdentity` + tests. This is the part CLAUDE.md's follow-up ("every
  future IdentityManager change must preserve the ability to derive child keys")
  protects.
- **Slice 2 (done):** shell/operator wiring + the differentiated-trust policy.
  `GET/POST/DELETE /api/agents` CRUD; `TaskBroker` agent escalation matrix
  (any-closure, telemetry/approved/never levels) via injected `AgentGate` +
  `TaskApprovalGate`, wired by `PluginHost` from its child-identity registry;
  `initiatedBy`/`agentLabel` audit facts on the handler context. The operator's
  native approval prompt is the same `trustConfirmation` channel, extended with
  an `agent-task-approval` kind. Cross-node agent recognition (verifying a
  foreign child's certificate and importing it as a declared agent) is not part
  of this slice — the registry is the operator's own child identities.
- **Slice 3 (done):** `p2p-hub:media:v1` + Tier-2 native-confirm gate
  (Decision 2). SDK wire contract + `media-access-request` prompt kind +
  `core.media.request` skill (fail-closed parse, transport-verified peerId
  required, every grant gated through `confirmMediaRequest`, `verified-contact`
  remote policy, no HTTP exposure, per-peer cooldown). See Decision 2 above.
- **Slice 4 (done):** capability type split + per-peer telemetry frequency caps
  (Decision 3). `sdk/src/capability.ts` (`CapabilityType`, fail-closed default
  `"action"`), `SkillRegistrationOptions.capabilityType`, the in-broker
  `TelemetryRateLimiter` (sliding window per transport-verified peerId × skill,
  bounded memory), the `TelemetryRateLimitExceededError` /
  `telemetry-rate-limit` result code, `listSkills()`/`/api/capabilities`
  exposure, and explicit labeling of the built-in capabilities
  (`core.echo`/`core.ai.generateText`/`core.media.request`/peersite ⇒ action,
  `peersite.status` ⇒ telemetry).

## Security invariants (non-negotiable, mirrored from CLAUDE.md)

- The parent seed stays inside `IdentityManager`; child keys live under the
  reserved `identity.agent.*` vault namespace; the certificate is the only
  public artifact and exposes no secret.
- No agent bypass: a child `peerId` is subject to the same default-deny gates
  as every other peer — and to *stricter* ones. The `any` gate never authorizes
  an agent, and every non-telemetry agent invocation needs an explicit native
  approval. The escalation is decided by the platform from the
  transport-verified caller `peerId` (via the injected `AgentGate`); a
  caller-supplied field can never claim agent status.
- Domain separation: the certificate context
  `p2p-hub:agent-identity:cert:v1` is distinct from
  `p2p-hub:peersite:auth:v1:`, `p2p-hub:peersite:knock:v1:`, and the manifest
  signature domain — a certificate signature can never be replayed as another
  protocol's signature.
- Reuse the pinned canonical serializer from `manifest-signing`; do not invent
  a second, divergent canonical form.
