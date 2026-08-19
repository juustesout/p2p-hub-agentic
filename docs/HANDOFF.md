# HANDOFF — p2p-hub-agentic

Handoff state for future sessions. Read this first; it replaces re-exploring
the repo from scratch. Keep it updated at the end of every task.

## Repo state (last verified)

- Branch `main`, remote `origin` = `https://github.com/juustesout/p2p-hub-agentic`.
- Recent commits on `origin/main`:
  - `49055e7` feat(core): crash-safe atomic storage and fail-loud corruption handling
  - `6f6674d` docs(handoff): record P2 hardening completion and clean working tree
  - `b18f264` feat(security): P2 hardening — gate non-loopback bridge, lock down skill advertising
  - `34671e7` feat(security): P1 hardening — identifier validation, task concurrency cap, provider selection
  - `366c733` feat(security): wire boundary guards and sanitizers across trust boundaries (P0)
- Test suite: **303 tests, 0 failures** (`npm run build && npm test` from root).
- Working tree is **dirty**: the `smartbase` plugin and the security-coherence
  phase (both below) are implemented and tested but NOT yet committed/pushed
  (commit only when asked).

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

## Storage durability & corruption handling (this task — NOT yet committed)

Implemented crash-safe atomic storage and fail-loud corruption handling across
`ScopedStorage` and `VaultManager`, plus two correctness fixes found along the
way. Build green, 267 tests pass.

- **One shared atomic helper** `core/src/storage/atomic-write.ts`:
  `atomicWriteFile(filePath, data, mode=0o600)` (mkdir parent → temp
  `.{basename}.tmp-{pid}-{ts}-{rand}` in the SAME dir → `fd.sync()` → `rename`)
  and `readJsonFile<T>()` (`ENOENT` → `null`; JSON parse failure →
  `StorageCorruptionError` with `filePath`+`cause`; other I/O errors rethrown).
  `ScopedStorage` and `VaultManager` both rewritten to use it; the old
  `atomic.ts` / `backup.ts` (auto-quarantine/auto-restore/silent fallback) were
  DELETED — they embodied exactly the behavior the task forbids.
- **No silent empty, no auto-recovery**: corruption throws loudly; stray
  `.tmp-*` files are never read as data and never auto-cleaned. `emitSystemWarning`
  / `onWarning` plumbing removed.
- **`PluginHost.boot()` no longer eagerly creates identity.** The previous
  unconditional `await this.identity.getOrCreateIdentity()` meant a corrupt
  vault aborted the whole boot (even for `enableNetworking: false` local apps).
  Removed; identity is now created lazily — only when networking starts
  (`startNetworking`, already try/catch-guarded) or a plugin calls
  `ctx.identity.peerId()`. New tests: corrupt vault + local boot still
  activates plugins; corrupt vault + networking logs the failure but still
  boots plugins.
- **`JSON.stringify` vs `JSON.parse` depth correction** (documented in
  CLAUDE.md): `JSON.parse` is iterative in Node 22/V8 12.4; `JSON.stringify` is
  recursive and overflows on deep graphs. `validateJsonNestingDepth` is
  defense-in-depth on JSON *strings* at `apps/core-server` and
  `network-light`; the real invariant is every `stringify` of
  externally-derived data sits after `validateObjectDepth`.
- New tests: `atomic-write.test.ts`, `scoped-storage.test.ts` (incl. a 50-way
  concurrent `set` no-lost-update test), expanded `vault-manager.test.ts` and
  `plugin-host.test.ts`; `resilience.test.ts` rewritten (old auto-recovery/
  `.bak`/`.corrupt` tests removed as obsolete).

## SmartBase plugin (this task — NOT yet committed)

New `plugins/smartbase`: an Airtable-like structured-data plugin on the PBX/OLE
standard, `localOnly`, no new `PluginContext` capabilities — pure `ctx.storage`.

- **Document schema (Deel 1)**: `P2P.Database` root `{ title, tables: $ref[] }`
  → `P2P.Table` `{ name, schema: { fields: [{name, type}] }, records: $ref[] }`
  → `P2P.Record` `{ fields: Record<string, string|number|boolean> }`. Field
  types are `string | number | boolean | date` (date stored as an ISO 8601
  string). Insert/update validate values against the schema: unknown keys and
  type mismatches are rejected — no free-form writes outside the schema.
- **Skills**: `createDatabase`, `createTable`, `insertRecord`, `updateRecord`,
  `deleteRecord`, `query`, `listTables`, `getSchema` (all `localOnly: true`).
- **No SQL parsing / no eval (the hard rule)**: `query` takes a structured
  `QueryFilter = Record<string, FieldFilter>` where
  `FieldFilter = {op, value}` with a fixed op set (`eq/neq/gt/gte/lt/lte/
  contains`); evaluation is a `switch` over `op` doing pure typed comparisons.
  A filter value is always literal text — never parsed, interpolated or
  executed. Unknown ops are rejected with a clean error. No `OR`, no nesting.
- **`limit` is always bounded**: `DEFAULT_QUERY_LIMIT = 100`,
  `MAX_QUERY_LIMIT = 500`; `limit: 1000000` → 500 records (`truncated: true`),
  no error, no unlimited result set. `QueryResult` carries `truncated` so a
  caller can tell when more matched than were returned.
- **Boundary-guard reuse**: `validateObjectDepth` / `validateKeyCount` /
  `isPlainObject` / `MAX_KEY_COUNT` from `@p2p-hub/sdk` run on the externally
  shaped `fields` and `filter` objects; the schema/type/unknown-key checks are
  smartbase-specific (not generic boundary concerns).
- **Known perf trade-off (deliberate, non-optimized)**: `query` is a full
  linear scan over the table's records per query (no index), and every
  mutation does a whole-document read-modify-write via `ctx.storage.set`. Fine
  for now; a table with hundreds of thousands of records would make each query
  and each mutation O(n) on a growing document. `limit` caps the returned set
  but not the scan itself.
- **Build plumbing**: added `{ "path": "./plugins/smartbase" }` to the root
  `tsconfig.json` references (necessary for `tsc -b` to build the plugin; the
  only change outside `plugins/smartbase/`).

## Security coherence & trust foundation (this task — NOT yet committed)

Pure settings-risk engine, a fail-closed trust-tier gate, a native tier-2
confirmation path, and a blast-radius settings UI. No new features, no
P2P/plugin/vault redesign, no remote JS execution.

- **Pure engine lives in `@p2p-hub/sdk`** (`sdk/src/settings-risk.ts`), NOT
  `core/src/security/` as first planned. Reason: the desktop shell (Vite,
  browser bundle) must evaluate risk live on every settings change, and the
  shell has no dependency on `@p2p-hub/core` (which pulls Node builtins). The
  SDK is pure (no Node builtins) and browser-safe. Core re-exports the engine
  and `TrustTier` from `core/src/security/index.ts`, so it is also part of the
  "core security module". The only `Buffer` in the SDK is inside
  `validatePayloadSize` (function body, never called by the shell), so the
  browser bundle is safe.
- **`evaluateSettingsRisk(settings)`** is pure/deterministic/side-effect-free
  (<5ms), returns `RiskAssessment { findings, aggregate }`. The three mandatory
  rules and their exact ids/severities:
  - `p2pHubExposed && chatAutoNotify && unrestrictedRemoteSkills` →
    `ERR_EXPOSED_UNRESTRICTED_SKILL` (critical)
  - `allowExternalApiExecution && unrestrictedRemoteSkills` →
    `ERR_REMOTE_EXTERNAL_API_ACCESS` (high)
  - `p2pHubExposed && localVaultStorage` → `WARN_P2P_VAULT_EXPOSURE` (medium)
  `aggregate` = `highestSeverity(findings)`; findings are sorted highest-first.
  `normalizeSettings` coerces a partial input to all-`false` defaults.
- **`TrustTier` (0|1|2)** + `requiredTrustTier(severity)` in
  `sdk/src/trust-tier.ts`: critical→2, high→1, else→0.
- **`TrustTierGate`** (`core/src/security/trust-gate.ts`) is the fail-closed
  enforcement: tier 0 → allow; tier 1 → allow only for an authenticated session
  (existing boot-token capability context); tier 2 → require a fresh native
  `TrustConfirmation.confirmTier2` (no `window.confirm`). No confirmer, a
  confirmer that returns false, or one that throws all surface as
  `TrustConfirmationDeniedError` (deny).
- **core-server** (`apps/core-server/src/app.ts`) gained `trustConfirmation`
  (injectable, default absent → deny) plus two endpoints:
  - `GET /api/settings` → `{ settings, risk }` (defaults all-false before first
    apply).
  - `POST /api/settings/apply` → `normalizeSettings` → `evaluateSettingsRisk` →
    `trustGate.authorize(aggregate, …, { authenticated: true })` (the `/api/*`
    path is already token-guarded). Denied → `403 { requiredTier }`; allowed →
    persisted to `<data-dir>/settings.json` via `atomicWriteFile`, then
    `200 { ok, risk }`.
  - **Phase-1 scope note:** these settings are *recorded, evaluated and gated*;
    they do NOT yet drive runtime behaviour (e.g. actually relaxing
    remote-skill restrictions). Wiring the effective settings into behaviour is
    the follow-up "coherence" work.
- **Native confirmation**: `apps/desktop-shell/src-tauri/src/lib.rs` adds a
  `request_tier2_confirmation(window, summary)` command using
  `tauri-plugin-dialog` (`MessageDialogBuilder::blocking_show`), scoped to
  `window.label() == "main"`. Cargo.toml adds `tauri-plugin-dialog = "2"`.
  **UNVERIFIED**: no Rust toolchain in this environment — needs `cargo build`.
  The frontend wrapper `services/trust-confirm.ts` (`confirmTier2`) invokes it
  and returns `false` (fail-closed) on any error/unavailability.
- **Capability isolation** (audited, no change needed beyond the command):
  `capabilities/default.json` is already `windows: ["main"]` + `core:default`
  only (no fs/shell/dialog/vault plugin permissions). Plugin panels are iframes
  inside the main window, not Tauri webviews, so they have no Tauri IPC access.
  Boot token stays in a module-scoped variable (not window/React/storage); the
  only URL exposure is the documented `?token=` WS-upgrade accepted risk.
- **Shell UI**: `BlastRadiusBadge` + `RiskFindingBanner` + `SettingsWindow`
  (5 toggles, live `evaluateSettingsRisk` on every change, per-field warnings,
  Save → `confirmTier2` for critical → `coreBridge.applySettings`).
  `StartMenu`/`Taskbar` gained a Settings entry. `core-bridge.ts` gained
  `getSettings`/`applySettings`. `vite.config.ts` sets
  `build.commonjsOptions.include: [/node_modules/, /sdk\/dist/]` so Rollup
  resolves the symlinked CJS `@p2p-hub/sdk` barrel's named exports (the shell
  build failed without it). `desktop-shell/package.json` adds the
  `@p2p-hub/sdk` dependency.
- **Vault UI audit (clean)**: `VaultModal` shows only key names + metadata and
  boolean "configured/missing" for the AI model; stored values are never
  rendered. No `console.log`/`debug`, no `dangerouslySetInnerHTML`/`innerHTML`,
  no `localStorage`/`sessionStorage`/`document.cookie` anywhere in the shell.
- **Tests added**: `sdk/src/settings-risk.test.ts` (12), `core/src/security/
  trust-gate.test.ts` (8), `apps/core-server/src/settings.test.ts` (7).

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

~~DONE~~ (items 11–13) / still open (14–16):

11. ~~DONE~~ `P2P_HUB_HOST=0.0.0.0` no longer silently widens the bridge.
    `apps/core-server/src/host.ts` exports `isLoopbackHost` + `decideBindHost`;
    `index.ts` refuses to start on a non-loopback host unless
    `P2P_HUB_EXPOSE=1` is set, and warns loudly when it is. Tests in
    `apps/core-server/src/host.test.ts`.
12. ~~DONE~~ `network-light` already filtered `localOnly` skills before
    advertising (in `plugin-host.ts` and `app.ts`); the leak was already closed.
    Added a read-only `advertisedSkills` getter and a regression test
    (`plugin-host-networking.test.ts`) asserting a local-only skill is never in
    the advertised set.
13. ~~DONE~~ `birthday-cards` title regex now uses word boundaries
    (`/\b(verjaardag|birthday)\b/i`), so substring titles like "unbirthday
    party" no longer create a card. Note: this does NOT exclude titles where
    "birthday" is a standalone word (e.g. "Birthday Films"); that would need a
    stronger heuristic and was left out of scope.
14. Plugin dotted-id collision: `"a.b"` + `"a"` registering `"b.x"` → same
    broker skill key (theoretical until third-party plugin ids exist).
15. Chat canonical message = `JSON.stringify` over fixed-key-order object —
    only sound while there is a single implementation. Revisit when a second
    impl appears.
16. `network-agentanycast`: when gRPC transport is added it needs its own
    auth/encryption + the same size/depth guards as network-light.

### P2 — hygiene / verification

~~DONE~~ (items 17, 19, 20) / follow-up (item 18):

17. ~~DONE (audit, no change)~~ `CoreAIProvider` is the only reader of
    `ai.apiKey` (`vault.getSecret`); the key is injected solely into the
    outbound `Authorization` header and never logged or returned. Errors carry
    only HTTP status/statusText. `ctx.ai` exposes only
    `generateText`/`generateImage`; `fetchFn` is constructor-injectable for
    tests only, so a plugin cannot intercept the key. Matches principle #6.
18. ~~FOLLOW-UP~~ `npm audit` reports 2 vulns (1 moderate, 1 high), both via
    `esbuild` <=0.24.2 (GHSA-67mh-4wv8-2f99: dev-server request leak) pulled in
    by `vite` <=6.4.2. Dev-server only (not a runtime path). `npm audit fix
    --force` would jump to vite@8 (breaking). Decide whether to upgrade vite or
    accept for now; `node-forge`/`bonjour-service`/`ws` had no reported
    advisories.
19. ~~DONE (audit, no change)~~ desktop-shell renders all peer/plugin/skill
    text through React JSX (auto-escaped); no `dangerouslySetInnerHTML` or
    `innerHTML` anywhere in `apps/desktop-shell`. Boot token is read via Tauri
    `get_boot_token` (or `VITE_P2P_HUB_TOKEN` in dev) and sent as
    `Authorization: Bearer` on HTTP and `?token=` on the WS upgrade (the
    documented accepted risk). Minor note: `plugin-bridge.ts` uses
    `postMessage(..., "*")` for plugin iframe panels — same-origin local
    content today, but worth tightening to a specific origin if plugin panels
    ever load remote content.
20. ~~DONE (prior verification)~~ notepad `miniMarkdown` escapes `&<>` before
    building tags. Watch any new plugin UI rendering via `innerHTML`.

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
