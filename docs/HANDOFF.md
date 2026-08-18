# HANDOFF — p2p-hub-agentic

Handoff state for future sessions. Read this first; it replaces re-exploring
the repo from scratch. Keep it updated at the end of every task.

## Repo state (last verified)

- Branch `main`, remote `origin` = `https://github.com/juustesout/p2p-hub-agentic`.
- Recent commits on `origin/main`:
  - `3c23801` feat(hardening): defensive parsing for manifests, PBX and formulas
  - `35a91cd` feat(core): network resilience, peer TTL expiry and plugin disposal
  - `7baf54c` feat(core): security boundary guard, AST sanitizer and action validator
- Test suite: **246 tests, 0 failures** (`npm run build && npm test` from root).
- Working tree is clean (everything committed/pushed).

## What exists / is done

- P2P-first plugin suite, npm workspaces: `sdk`, `core`, `plugins/*`,
  `apps/core-server`, `apps/desktop-shell`.
- `PluginHost` loads plugins with capability-scoped `PluginContext`
  (storage/hooks/skills/vault/ai/identity/network/timers/onDispose).
- Network: `network-light` (mDNS + TLS with cert-fingerprint pinning) and
  `network-agentanycast` (daemon status only, transport NOT implemented).
- HTTP/WS bridge in `apps/core-server` guarded by a per-boot token (0600 file,
  constant-time compare). Reserved vault namespaces enforced at BOTH the
  plugin `VaultContext` and the HTTP bridge.
- `core/src/security/` (action-validator only now): `action-validator.ts` →
  `validateActionPayload` → `ChatActionPayload` (rejects unsafe content +
  prototype-pollution, strips unknown keys).
- `sdk/src/boundary-guard.ts` + `sdk/src/sanitizer.ts` (moved from core in the
  P0 pass): `validatePayloadSize` (256KB), `validateObjectDepth` (10),
  `validateKeyCount` (500), `validateTextLength` (10k) + typed errors;
  `stripHtml`, `sanitizeText`, `sanitizeMarkdown`, `sanitizeUrl`,
  `isDangerousUrl`, `containsUnsafeContent` (single-pass, no ReDoS, no eval).
- `core/src/tests/security-boundary.test.ts` (24 tests incl. deterministic fuzz).

## PENDING — security roadmap (highest value first)

These are concrete findings from the last exploration. Do them in order.

### P0 — wire the security modules (they are currently dead code)

~~DONE~~ (wired in this pass):

1. **`apps/core-server/src/app.ts` `readJson()`** now stream-caps the body at
   `MAX_PAYLOAD_BYTES` (throws `PayloadTooLargeError`) and calls
   `validateObjectDepth` on the parsed body.
2. **`TaskBroker.execute`** now runs `validateObjectDepth(payload)` +
   `validatePayloadSize(JSON.stringify(...))` before `record.handler`, covering
   `handle`/`handleRemote`/`handleHttp`.
3. **`plugins/network-light` `tryDecodeFrame`** now uses `MAX_PAYLOAD_BYTES`
   (was `FRAME_MAX = 16MB`), throws `PayloadTooLargeError` on oversized
   frames (both data handlers catch it and destroy the socket — fixes a latent
   uncaught-exception DoS), and `validateObjectDepth` on the decoded JSON.
4. **Chat plugin** now `validateTextLength` on send + receive (size cap) and
   `sanitizeText` at render in `messageToRecord`.

Note: `boundary-guard.ts` and `sanitizer.ts` were **moved from
`core/src/security/` to `sdk/src/`** so `network-light` (which depends only on
the SDK, not core) could import them without a circular dependency. Core's
`security/index.ts` now re-exports only `action-validator`; consumers import
the primitives from `@p2p-hub/sdk`. `action-validator.ts` stays in core and
imports `isPlainObject`/`MAX_*`/`containsUnsafeContent` from `@p2p-hub/sdk`.

### P1 — input validation & DoS hardening

5. **`app.ts` `execute()`**: validate `body.serviceId` / `body.method` against a
   safe identifier pattern before building `${serviceId}.${method}`; `timeout`
   field is unused (either enforce or drop); `peerId` remote-execution path
   needs format validation.
6. **WebSocket `maxPayload`**: `new WebSocketServer(...)` has no `maxPayload` →
   `ws` defaults to 100MB. Set to `MAX_PAYLOAD_BYTES`.
7. **TaskBroker rate limiting / concurrency caps**: no per-peer or global
   concurrency limit — a malicious peer/token-holder can flood tasks. Add a
   bounded queue / per-peer budget.
8. **`app.ts` returns `err.message` on 500** — potential info leak (mirrors
   security principle #7: don't leak *why*). Return a generic message, log the
   detail server-side.

### P1 — identity & addressing consistency

9. **`app.ts` remote execute uses `peer.id` (per-boot instance id) while
   `ctx.network.sendTask` uses `peer.peerId` (persistent Ed25519).** Two
   different "peer id" concepts with the same name. Decide on one and
   reconcile (likely: HTTP accepts persistent `peerId` and the provider maps
   it to a reachable instance).
10. **`NetworkRegistry.selectActive()`** — `agentanycast` has `priority: 100`
    (vs `network-light` 10) but its `discover`/`sendTask`/`onTask` throw
    "not implemented". Verify `selectActive()` never selects a provider that
    cannot actually transport, and that `buildNetworkCapability` handles it.

### P2 — follow-ups (from CLAUDE.md, still open)

11. `P2P_HUB_HOST=0.0.0.0` widens the HTTP bridge with no warning/gate.
12. `network-light` advertises ALL local skill names via mDNS regardless of
    `localOnly`/`httpExposed` (rejected correctly at broker, but leaks
    which skills exist to the LAN).
13. `birthday-cards` title regex `/verjaardag|birthday/i` lacks word boundaries.
14. Plugin dotted-id collision: `"a.b"` + `"a"` registering `"b.x"` → same
    broker skill key (theoretical until third-party plugin ids exist).
15. Chat canonical message = `JSON.stringify` over fixed-key-order object —
    only sound while there is a single implementation. Revisit when a second
    impl appears.
16. `network-agentanycast`: when gRPC transport is added it needs its own
    auth/encryption + the same size/depth guards as network-light.

### P2 — hygiene / verification

17. **Audit `CoreAIProvider`** (`core/src/ai/core-ai-provider.ts`): confirm the
    `ai.apiKey` raw secret is never logged/returned and prompts are handled
    safely. (Not read this session.)
18. **`npm audit` + dependency review**: `node-forge` is dated; review
    `bonjour-service`, `ws` and pin. Add to CI if none exists.
19. **desktop-shell** (`apps/desktop-shell`): review how it renders chat/peer
    text (should be text-only or sanitized) and confirm it uses the boot token
    correctly. (Not read this session.)
20. **notepad `miniMarkdown`** (already escapes `&<>` before building tags —
    verified safe) — keep an eye on any new plugin UI that renders content via
    `innerHTML`; they must escape first or use `sanitizeMarkdown`.

## Conventions (for any task)

- Tests: `node:test`; run `npm run build && npm test` from root. Core test
  files live under `core/src/tests/` and `core/src/<area>/*.test.ts`.
- Security principles in `CLAUDE.md` are authoritative (deny-by-default,
  delimiter-anchored prefixes, path validation, TLS pinning, reserved
  namespaces enforced at every write surface, secret isolation, null-on-
  decrypt-failure, loud fallback secrets). Re-read before security work.
- `@p2p-hub/core` must not depend on a plugin (e.g. `@p2p-hub/calc`); keep
  per-package tests split accordingly.
- Commit style: `feat(core): ...`, `fix(...): ...`, `test(core): ...`.
- Only commit/push when explicitly asked.

## Session hygiene (to keep context small)

- Read files in ≤200-line segments.
- Use subagents (`explore`/`general`) for codebase search; take summaries back.
- Update this file at the end of every task; a fresh session starts here.
