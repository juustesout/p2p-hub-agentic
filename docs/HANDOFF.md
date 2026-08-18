# HANDOFF — p2p-hub-agentic

Handoff state for future sessions. Read this first; it replaces re-exploring
the repo from scratch. Keep it updated at the end of every task.

## Repo state (last verified)

- Branch `main`, remote `origin` = `https://github.com/juustesout/p2p-hub-agentic`.
- Recent commits on `origin/main`:
  - `34671e7` feat(security): P1 hardening — identifier validation, task concurrency cap, provider selection
  - `366c733` feat(security): wire boundary guards and sanitizers across trust boundaries (P0)
  - `3c23801` feat(hardening): defensive parsing for manifests, PBX and formulas
  - `35a91cd` feat(core): network resilience, peer TTL expiry and plugin disposal
  - `7baf54c` feat(core): security boundary guard, AST sanitizer and action validator
- Test suite: **250 tests, 0 failures** (`npm run build && npm test` from root).
- Working tree is clean (P0 and P1 items 5–10 committed and pushed).

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

~~DONE~~ (wired in this pass, tested):

5. **`app.ts` `execute()`**: `serviceId` / `method` validated against
   `IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/`, `peerId` against
   `PEER_ID_RE = /^[a-zA-Z0-9-]{1,128}$/` before building
   `${serviceId}.${method}` or addressing a peer. `ExecuteBody.timeout` was
   dropped from the backend, and the desktop shell's `ExecuteRequest.timeout`
   field has now been removed too (no consumer used it).
6. **WebSocket `maxPayload`**: `new WebSocketServer(...)` now sets
   `maxPayload: MAX_PAYLOAD_BYTES`.
7. **TaskBroker concurrency cap**: `maxConcurrentTasks` (default 100); new
   tasks are rejected when at capacity instead of being queued.
8. **`app.ts` 500 responses are generic** (no `err.message` leak); details are
   logged server-side via `console.error`. 413 for oversized bodies, 400 for
   `SyntaxError` / `ObjectDepthExceededError`.

### P1 — identity & addressing consistency

~~DONE~~ (wired in this pass, tested):

9. **Remote execute now resolves peers by persistent `peerId` first, falling
   back to per-boot `id`.** `app.ts` `executeRemote` matches
   `p.peerId === peerId ?? p.id === peerId` (mirroring `ctx.network.sendTask`,
   which addresses by `peerId`). The `/api/peers` payload now also exposes
   `peerId` so HTTP clients can address peers by identity, and the desktop
   shell sends `peer.peerId ?? peer.id` for remote runs.
10. **`selectActive()` can no longer select a non-transporting provider.**
    `NetworkProvider` gained an optional `canTransportTasks` flag (default
    `true`); `AgentAnycastProvider` sets it `false` (stage-1 status probe), and
    `NetworkRegistry.selectActive()` skips providers where it is `false` even
    at higher priority. `buildNetworkCapability.sendTask` now wraps the
    retried/timeout-bounded call in a try/catch and returns an error
    `TaskResult` instead of rejecting, upholding the "never throws" contract.
    New tests in `core/src/network-registry.test.ts` cover both cases.

## Tests added in this pass

- `core/src/network-registry.test.ts`: 2 tests — `selectActive` skips a
  higher-priority provider with `canTransportTasks: false`, and returns `null`
  when the only ready provider cannot transport.
- `core/src/task-broker/task-broker.test.ts`: 1 test — a task arriving while
  the broker is at capacity is rejected, not queued (locks in P1-7).
- `apps/core-server/src/token.test.ts`: 1 test — `/api/execute` rejects unsafe
  `serviceId`/`method`/`peerId` identifiers with a `safe identifier` error
  result (locks in P1-5).

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
