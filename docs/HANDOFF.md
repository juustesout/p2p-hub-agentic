# HANDOFF — p2p-hub-agentic

Handoff state for future sessions. Read this first; it replaces re-exploring
the repo from scratch. Keep it updated at the end of every task.

## Repo state (last verified)

- Branch `main`, remote `origin` = `https://github.com/juustesout/p2p-hub-agentic`.
- Recent commits on `origin/main`:
  - `ad51482` feat(core): add ctx.trust capability and PeerSite inbound peer-auth
  - `58bd274` feat(sdk): add in-process contact trust-lookup seam
  - `369899d` feat(core-server): add scoped PeerSite API and LAN opt-in (PeerSite Fase 2)
  - `a74963d` docs(peersite): add design plan and record Fase 0 status
  - `21762e7` feat(sdk): add peersite settings flags and risk rules
  - `ef59164` docs(handoff): record smartbase and security-coherence work
- Test suite: **378 tests, 0 failures** (`npm run build && npm test` from root).
- Working tree is **dirty**: PeerSite Fase 4A (ENS, `plugins/ens`) and Fase 4B
  (access passes + native peer-access confirmation) are implemented and tested
  but NOT yet committed/pushed (commit only when asked).

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

## Storage durability & corruption handling (committed)

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

## SmartBase plugin (committed)

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

## Security coherence & trust foundation (committed)

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
  with a 60s timeout and returns `false` (fail-closed) on any error,
  unavailability, or timeout.
- **Capability isolation** (audited, no change needed beyond the command):
  `capabilities/default.json` is already `windows: ["main"]` + `core:default`
  only (no fs/shell/dialog/vault plugin permissions). Plugin panels are iframes
  inside the main window, not Tauri webviews, so they have no Tauri IPC access.
  Boot token stays in a module-scoped variable (not window/React/storage); the
  only URL exposure is the documented `?token=` WS-upgrade accepted risk.
- **Shell UI**: `BlastRadiusBadge` + `RiskFindingBanner` + `SettingsWindow`
  (5 toggles, live `evaluateSettingsRisk` on every change, per-field warnings,
  Save → `confirmTier2` for critical → `coreBridge.applySettings`). The window
  keeps a `lastSaved` (server-confirmed) snapshot and rolls back any optimistic
  toggles when a tier-2 confirm is denied/failed or the server rejects the
  apply — no drift between UI state and persisted state.
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

## Coherence follow-ups (Phase 2) & Rust verification

Flagged during review of the trust foundation; NOT done yet — do these when the
runtime binding and the Rust build happen.

1. **Rust / Tauri native dialog**
   - `blocking_show()` can block the OS main loop on some platforms. Prefer the
     async `show(|result| …)` form (or an `async fn` command) so the IPC stays
     non-blocking. The frontend `confirmTier2` already wraps the call in a 60s
     timeout that fails closed (`false`) — keep that even after switching to the
     async dialog.
   - **Main-window isolation is not yet provably hard-gated.** The
     `window.label() == "main"` check in `lib.rs` is a good first line, but the
     definitive boundary in Tauri v2 is a capability/permission gate for the
     custom command. Verify with `cargo build` + a test command that a secondary
     window (or an external webview iframe) cannot invoke
     `request_tier2_confirmation`. If Tauri v2 cannot gate custom commands via
     capabilities, keep the label check AND document that plugin panels are
     iframes with no Tauri IPC access at all.
2. **Runtime binding (the "coherence" step).** The 5 flags are currently only
   *recorded + evaluated + gated* in `settings.json`; they do not yet change
   behaviour. When wiring them in, give each consumer (P2P hub listener, skill
   executor, chat auto-notify, vault storage mode, external-API gate) a
   direct-read or event-driven subscription to `EffectiveSettings`, and keep the
   `settings:updated` broadcast as the change signal. Avoid a second,
   independent settings store — subscribe to the one written by
   `POST /api/settings/apply`.
3. **No sensitive values in `EffectiveSettings`.** It is a 5-boolean record;
   `normalizeSettings` structurally drops any non-boolean field, so API keys or
   other secrets passed to the engine can never be carried into browser state or
    logs. Keep it that way: the settings engine must only ever see boolean flags
    + metadata, never secrets. Re-audit the `settings:updated` broadcast payload
    and any future settings-adjacent logging to confirm they serialize only
    booleans.

## PeerSite — Fase 0: boundaries, settings & risk engine (committed)

First phase of the "local-first creator workflow" initiative (see
`docs/peersite-plan.md` for the full phased design). Data model + risk rules
only — no HTTP serving, no UI components yet.

- `EffectiveSettings` gained two boolean fields, both defaulting `false` via
  `normalizeSettings`: `peersiteEnabled` (master switch) and
  `peersiteLanExposed` (bind beyond loopback + mDNS advertise).
- `RiskFinding` gained an optional `affectedFields?: string[]` (populated only
  by the new rules; existing findings are unchanged).
- Three new rules in `evaluateSettingsRisk` (pure, deterministic, no side
  effects):
  - `WARN_PEERSITE_LAN_EXPOSURE` (medium) — `peersiteEnabled && peersiteLanExposed`.
  - `WARN_PEERSITE_UNRESTRICTED_SKILLS` (high) — the above plus
    `unrestrictedRemoteSkills`.
  - `ERR_EXPOSED_PEERSITE_EXECUTION` (critical) — `peersiteEnabled &&
    peersiteLanExposed && allowExternalApiExecution`.
- Fixture updates required by the type change (not new features):
  `apps/desktop-shell/src/components/SettingsWindow.tsx` `DEFAULTS` and
  `apps/core-server/src/settings.test.ts` `SAFE`/`CRITICAL` gained the two
  `false` fields so the build and `deepEqual` assertions stay green.
- Tests: `sdk/src/settings-risk.test.ts` gained 6 new cases (disabled peersite
  triggers nothing; exact medium; high; critical; aggregate scales to critical;
  severity-sorted ordering). Total suite now **308 tests, 0 failures**.

## PeerSite — Fase 1: static serve (loopback-only, hardened) (committed)

Second phase: hardened static file serving from a user-chosen directory in
`apps/core-server`, strictly loopback-only. No dynamic `/peersite/*` API, no
scoped credentials, no LAN exposure yet.

- `CoreServerOptions.siteRoot?: string` — resolved and validated at startup in
  `initSite()`: `realpathSync`, a **data-dir block** (site root may never be
  the agent data dir or a path inside it — this keeps `boot-token`,
  `settings.json` and vault files out of the served tree), and a **loopback
  gate** (non-loopback bind disables static serving with a loud warning, not a
  silent widen).
- Static route under `/site/*` (`tryServeSite` in `app.ts`):
  - Pre-check rejects raw `%2e`/`%00`/`..`/null-byte sub-paths, then decodes
    and re-checks segment-by-segment (dot-segments, dotfiles, backslashes, null
    bytes). Note: `new URL(...)` already collapses literal and `%2e`-encoded
    dot segments; the guard that actually fires on the wire is the
    encoded-slash (`%2f`-based) traversal and the dotfile check.
  - `realpath` containment: the resolved file must be the real root or a path
    under it (`startsWith(root + path.sep)`), which blocks symlink escapes.
  - Directory requests resolve to `index.html` (re-containment-checked).
  - All rejects are **404** (never 403) to avoid leaking directory structure.
  - Security headers on every asset: `X-Content-Type-Options: nosniff` +
    restrictive `Content-Security-Policy`; explicit extension→MIME map with
    `application/octet-stream` default.
- Tests: `apps/core-server/src/peersite.test.ts` (7 tests) — valid serving +
  headers, directory index, traversal (encoded/raw/encoded-slash), symlink
  escape, dotfile/dot-dir deny, data-dir rejection at startup, and
  disabled-by-default.

## PeerSite — Fase 2: scoped agent API & LAN opt-in (committed)

Third phase: a scoped `/peersite/*` API plus explicit LAN opt-in, still in
`apps/core-server`. No friends/P2P discovery, no TLS/fingerprint work yet.

- **Scoped site credential** (`generateSiteToken` in `auth.ts`): a separate
  in-memory random token generated at boot, exposed to the host only via
  `CoreServer.siteCredential()`. It is **never** persisted, never injected into
  served HTML, and never printed. `isSiteAuthorized()` authenticates only the
  `/peersite/*` routes; the site token is rejected on `/api/*` and `/ws`
  (which keep requiring the boot token), and the boot token is not accepted on
  `/peersite/*` — credential isolation is asserted by a test.
- **Tiered endpoints** in `tryServePeersite()`:
  - `GET /peersite/status` — tier 0 public metadata: `{ online, peerName,
    activePluginsCount }` (no tokens, paths, vault keys, or internal names).
  - `POST /peersite/message` — tier 1: site token + per-IP fixed-window rate
    limit (30/min → 429), `validateTextLength` + `sanitizeText`.
  - `POST /peersite/execute-skill` — tier 2: site token + identifier
    validation, `trustGate.authorize("critical", …)` → 403
    `{ ok:false, requiredTier:2 }` when no native confirmation approves, 200
    with the task result when it does.
- **LAN opt-in** in async `initSite()`: a non-loopback bind only enables the
  site when `peersiteEnabled && peersiteLanExposed` are both true in
  `settings.json`, and it logs a loud `EXPOSING` warning with the aggregate
  risk level. Otherwise the site stays disabled (loopback still serves).
- `this.peerId` is captured from `getOrCreateIdentity()` in `start()` and used
  by `/peersite/status`.
- Tests: `apps/core-server/src/peersite.test.ts` grew from 7 → 14 tests (the
  Fase 2 ones: credential isolation on `/api`/`/ws`, clean status metadata,
  fail-closed and approving execute-skill, message auth + rate limit, LAN
  refuse-without-flags and serve-with-flags). Total suite now **322 tests, 0
  failures**.

## PeerSite — Fase 3: PeerSite as a plugin + shared containment (NOT yet committed)

Fourth phase: the site-root ownership and file containment move out of
`apps/core-server` into a real `plugins/peersite` plugin, with the P2P
`fetchAsset` surface on top. This is the "P2P published site" leg of the
creator workflow.

- **New plugin `plugins/peersite`** (`generic`, entry `./dist/index.js`),
  owning the site-root config in its own `ctx.storage`:
  - `peersite.setSiteRoot` — `localOnly: true, httpExposed: true` (reachable
    only over the authenticated HTTP bridge, so the desktop shell configures
    the site without any network exposure). Validates via `validateSiteRoot`
    and persists the raw path; returns the canonical realpath.
  - `peersite.status` — `localOnly: false`, returns `{ online, peerName,
    siteRootConfigured }`.
  - `peersite.fetchAsset` — `localOnly: false`, tier-2 P2P asset read. Fail-
    closed: `authenticateIncomingPeer` first (verified-contact challenge over
    `peersite.signAuthChallenge`, domain `p2p-hub:peersite:auth:v1:`), then
    `resolveAndContainFile`. Returns base64 `data` + `contentType` + `name`,
    or `{ ok:false }` (auth failure → `unauthorized`, containment failure →
    `not found`, never which-path-exists to an unverified peer).
  - `peersite.signAuthChallenge` — `localOnly: false`, signs
    `PEERSITE_AUTH_CONTEXT || nonce` (never caller-chosen bytes), mirroring
    `contacts.signChallenge` but domain-separated.
- **Shared containment in `core/src/site/site-files.ts`** (exported from
  `@p2p-hub/core`):
  - `validateSiteRoot(siteRoot, dataDir)` → canonical realpath, throws loudly
    on missing/unresolvable root or a root equal to / inside the data dir.
  - `resolveAndContainFile(siteRoot, requestedPath)` → canonical file path or
    `null` (quiet per-request denial): dot-segments/dotfiles/backslashes/NUL
    default-denied, `realpath` containment with a trailing-separator-anchored
    prefix check (symlink escape blocked), directory → `index.html`.
  - `contentTypeForPath` (extension-only MIME, moved out of `app.ts`).
- **`apps/core-server` refactor**: `CoreServerOptions.siteRoot` is **removed**.
  `initSite()` now only resolves the LAN gate (`lanSiteAllowed`); the effective
  root is read per request via `host.getActivated("peersite")` behind a
  `typeof`-guarded `PeerSitePlugin` interface (`effectiveSiteRoot()`), so the
  shell can configure the root after boot. `tryServeSite` uses
  `resolveAndContainFile` — the same helper as `fetchAsset`, so HTTP and P2P
  accept/reject identical paths by construction.
- **`ctx.dataDir`**: `PluginContext` gained a read-only `dataDir` (from a new
  `StorageManager.getDataDir()`), so the plugin can validate the site root
  against the data directory without core exposing anything wider.
- Tests: new `core/src/site/site-files.test.ts` (8) + `plugins/peersite/src/
  peersite.test.ts` (10: config persistence + data-dir/missing rejections,
  fetchAsset denied for pending/unknown/no-trust/no-network, served for a
  verified peer, traversal/symlink/dotfile/backslash deny, and a direct
  HTTP↔P2P parity assertion against `resolveAndContainFile`).
  `apps/core-server/src/peersite.test.ts` now loads only the peersite plugin
  (copied + a `node_modules` symlink) and configures the root via the bridge.
  Total suite now **358 tests, 0 failures**.

## PeerSite — Fase 4A: ENS → verified peerId (plugins/ens, NOT yet committed)

Fifth phase: map an ENS name to a *verified* peer identity. All Web3
dependencies (`viem`) are isolated in a new `plugins/ens` plugin — `core` and
`sdk` stay free of any Web3 code. No live network in tests (RPC fully mocked).

- **New plugin `plugins/ens`** (`generic`, entry `./dist/index.js`):
  - `ens.setConfig` / `ens.getConfig` — persist the ENS config (name + RPC) in
    `ctx.storage`. `ens.resolve(name)` — the lookup.
  - **Cross-sign authorization** (EIP-191 `personal_sign`, NOT EIP-712): the
    resolver must prove the ENS name's owner signed the exact statement
    `I authorize peer ${peerId} for name ${normalizedEnsName}`. The name's
    owner is read via `ENS Registry.owner(namehash(name))` and compared
    lowercased. `recoverMessageAddress` verifies the signature.
  - **`verified:false` never exposes `peerId`** — the result carries only
    `claimedPeerId`; the `peerId` field is physically absent until the
    cross-signature and owner match both hold.
  - **Homograph warning is UX-only** (not a security boundary): it runs on the
    *raw* input before `ens_normalize`, so normalized lookalikes (e.g. fullwidth
    `Ｏ` → `o`) are still flagged. Authorisation stays the cross-signature.
  - **1h verified-only cache**; `EnsDeps.ensClient` is the injected test seam.
  - `unicode-confusables@0.1.1` ships a misnamed types file (`index.ts.d`), so
    `plugins/ens/src/unicode-confusables.d.ts` provides ambient types (fixes
    TS7016).
- **`sdk/src/settings-risk.ts`**: `EffectiveSettings` gained `ensEnabled?: boolean`,
  read *raw* by `evaluateSettingsRisk` (`.ensEnabled === true` →
  `WARN_ENS_RESOLUTION_ENABLED`, medium) and deliberately NOT emitted by
  `normalizeSettings` (emitting it broke the core-server settings deep-equal).
- Tests: `plugins/ens/src/ens.test.ts` (8, RPC mocked, no live network) +
  `sdk/src/settings-risk.test.ts` cases for the ENS rule. Root `tsconfig.json`
  gained a `./plugins/ens` reference.

## PeerSite — Fase 4B: access passes + native peer-access confirmation (NOT yet committed)

Sixth phase: let a *non-verified* peer request read-only site access with a
single, standalone proof-of-possession ("knock"), resolved through a native
tier-2 confirmation. `execute-skill` stays completely outside this mechanism.

- **`TrustConfirmation.confirmTier2` is now a discriminated union**
  (`core/src/security/trust-gate.ts`):
  - `{ kind: "critical-settings"; summary: string }`
  - `{ kind: "peer-access-request"; peerId: string; claim: string; expiresInMs: number }`
  - `TrustTierGate.confirmPeerAccess(peerId, claim, expiresInMs)` wraps the
    peer-access kind and fails closed (no confirmer / throw / user denial →
    `false`).
- **Knock proof** (`core/src/identity/peer-auth.ts`): `PEERSITE_KNOCK_CONTEXT =
  "p2p-hub:peersite:knock:v1:"` + `buildKnockMessage(peerId, claim, timestamp)`.
  New domain string; never shared with `PEERSITE_AUTH_CONTEXT`.
- **`plugins/peersite`** new surface:
  - `peersite.requestAccess` (`localOnly: false`, manifest permission
    `network:skill:peersite.requestAccess`): payload `{ peerId, claim,
    timestamp, signature }`, verified against the claimed `peerId` itself (raw
    public-key hex) — no contacts lookup, no prior handshake, no transport
    identity. Rejects: invalid peerId/claim/signature, `|now - timestamp| >
    5 min` (replay window), and >1 accepted knock/peerId/hour (in-memory rate
    limit, recorded only after a valid proof). A valid knock creates a
    *pending* request and emits `peersite:accessRequested`.
  - `peersite.setAcceptIncomingRequests` (`localOnly: true, httpExposed: true`),
    default **off** — knocks are denied (`not accepting`) until enabled.
  - `resolveAccessRequest(requestId, approved)` (plugin method, called by the
    host): on approval mints an ephemeral in-memory `AccessPass`
    (`scope: "site-read-only"`, 1h TTL) keyed by peerId — never persisted,
    never a bearer token.
  - `fetchAsset` pass-check: now proves key possession first
    (challenge-response via `signAuthChallenge`), then allows either a *verified
    contact* **or** a valid access pass. A pass only lifts the contact gate; it
    never touches `execute-skill`.
- **core-server** (`apps/core-server/src/app.ts`): `registerPeerAccessHandler()`
  listens for `peersite:accessRequested` → `trustGate.confirmPeerAccess(...)` →
  `peersite.resolveAccessRequest(...)` (duck-typed via the `PeerSitePlugin`
  interface). No-confirmer and any confirmation failure are fail-closed.
- **Desktop shell / Tauri**: `services/trust-confirm.ts` now types
  `confirmTier2(request: ConfirmationRequest)` (the shape is declared locally —
  the shell only depends on `@p2p-hub/sdk`, not `@p2p-hub/core`).
  `SettingsWindow.tsx` passes `{ kind: "critical-settings", summary }`.
  `src-tauri/src/lib.rs` `request_tier2_confirmation` takes a `#[serde(tag =
  "kind", rename_all = "kebab-case")]` `ConfirmationRequest` enum and renders
  the right dialog per kind. **UNVERIFIED**: no Rust toolchain in this
  environment — needs `cargo build`.
- Tests: `core/src/security/trust-gate.test.ts` +3 (peer-access kind + fail
  closed); `plugins/peersite/src/peersite.test.ts` +8 (valid knock + emit, bad
  signature, stale timestamp, rate limit, default-deny, approved pass serves a
  non-contact peer, denied request grants nothing, unknown request id).
  Total suite now **378 tests, 0 failures**.

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
