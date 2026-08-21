# p2p-hub-agentic — CLAUDE.md

Context for any Claude Code session working in this repo. Read this before
making changes, and especially before touching anything under `core/`,
`sdk/`, `apps/core-server/`, or a plugin's `manifest.json`.

## What this is

A P2P-first, plugin-extensible desktop suite (Node.js/TypeScript, npm
workspaces: `sdk`, `core`, `plugins/*`, `apps/*`). Plugins are loaded by a
`PluginHost`, get a capability-scoped `PluginContext` (storage, hooks,
skills, vault, ai), and can optionally be reached over the local mDNS/P2P
layer (`network-light`/`network-agentanycast`) or the local HTTP bridge
(`apps/core-server`). Documents use the PBX/OLE object-graph standard
(`sdk/src/pbx.ts`) for cross-plugin embedding.

## Non-negotiable security principles

These came out of real bugs found in this repo, not hypotheticals. Every
one of them was initially missing and had to be added after review — treat
that as a signal that these are exactly the kind of thing that's easy to
miss, not boilerplate to skim.

1. **Deny by default at every trust boundary, independently per boundary.**
   A skill's `localOnly` (P2P/network reachability) and `httpExposed` (local
   HTTP bridge reachability) are separate flags. Opting a skill into one
   does **not** opt it into the other — a LAN peer and a local HTTP client
   are different threat models. New boundaries (a future WS push channel, a
   plugin-to-plugin RPC layer, anything else that lets an external actor
   trigger code) need their own default-deny gate, not a reuse of an
   existing one.

2. **Namespace/prefix checks must anchor on the delimiter, not just the
   prefix string.** `event.startsWith("calendar")` wrongly matches
   `"calendarevil:x"`. Always check `startsWith("calendar:")` (or whatever
   the delimiter is) — same class of bug as the classic
   `/data/calendar` vs `/data/calendar-evil` path-containment mistake.
   Check this on every new namespace-scoped string comparison
   (hook events, skill names, storage keys, vault prefixes).

3. **Any identifier that becomes part of a filesystem path must be
   validated before it's used that way, even if it also appears
   elsewhere as "just a string."** `manifest.id` is validated
   (`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`) specifically because it's used to build
   `<dataDir>/<pluginId>.json`. `manifest.entry` is resolved and then
   checked to stay within the plugin directory
   (`entryPath.startsWith(pluginDirResolved + path.sep)` — note the
   trailing separator, a bare `startsWith` has the same prefix-leak bug as
   #2). Storage **keys** are safe by construction (stored as JSON object
   keys, never path components) — don't conflate "a key is safe" with "an
   id used to build a filename is safe"; they're different guarantees.

4. **TLS/crypto: never disable peer verification without replacing it with
   something.** `rejectUnauthorized: false` alone is decorative encryption
   — it stops passive eavesdropping but not MITM. If you must use
   self-signed certs (no CA in a P2P context), pin the fingerprint via a
   side channel you already trust (here: the mDNS TXT record announced at
   discovery) and verify it explicitly after `secureConnect`.

5. **Reserved/sensitive namespaces need structural enforcement at every
   surface that can write them, not just the "main" one.** `ai.*` in the
   vault is enforced in `VaultContext` (plugin-facing) **and** separately
   in `apps/core-server` (`reservedPrefixFor`, mirroring the same list from
   `VaultManager.reservedPrefixes`) — the HTTP bridge is a distinct write
   path and was initially missing this check entirely. When adding a new
   sensitive prefix, grep for every place secrets can be written and check
   each one, don't assume one central guard covers all callers.

6. **A component that reads a secret is the only component allowed to.**
   `VaultManager.getSecret` is core-only. Plugins get `ctx.vault` without
   `getSecret`. `ctx.ai` never exposes the raw key to the plugin — only
   `CoreAIProvider` reads it and injects it into the outbound request. Any
   new AI/secret-consuming feature must follow this shape: raw secret stays
   in exactly one place, everything else gets a capability, not a value.

7. **Errors on the "wrong secret / can't decrypt" path return null/absent,
   never leak *why*.** Wrong master key or corrupted ciphertext in
   `VaultManager.getSecret` → `null`, not a thrown error with details.

8. **A dev-only fallback secret is only safe if it's loud.** If a
   component falls back to a hardcoded/well-known value when no real
   config is present (e.g. a vault master key), it must warn clearly at
   startup, and ideally refuse to start in a production-like environment
   without an explicit override. A silent fallback in an open-source repo
   means the fallback value is public.

9. **Storage writes are atomic; storage corruption fails loudly, never
   silently "empty".** All persistence goes through one shared helper —
   `atomicWriteFile` in `core/src/storage/atomic-write.ts` (temp file in the
   same directory → `fsync` → `rename`), used by both `ScopedStorage` and
   `VaultManager` — never a bare `fs.writeFile` over the target. On the read
   side, a file that exists but cannot be parsed must throw
   `StorageCorruptionError` (with the path attached), which is a *different*
   situation from "the file does not exist yet" (that one is an empty store).
   Never collapse a `JSON.parse` failure into "empty data" — that is silent,
   permanent data loss. There is **no** automatic quarantine (renaming to
   `.corrupt-*`) or automatic "start over empty": a human decides, the code
   only fails loudly. Stray `.{name}.tmp-*` files from a crashed write are
   never read as data (reads are always by exact path) and are not
   auto-cleaned.

10. **A capability token is granted to whatever code can read it.** Never put a
    token that authorizes sensitive endpoints (the boot token) in a URL that
    untrusted code can observe. An iframe `src="...?token=<boot-token>"` hands
    the token to the iframe's own JavaScript — which, in the plugin-UI model,
    *is* the untrusted code. This is why `/ui/<pluginId>/*` is served without
    the boot token (the plugin's own public UI assets are not secrets), and
    why the plugin bridge relies on an origin-pinned `postMessage` allowlist
    instead of the shell sharing its token. When a surface has to be
    reachable by code that must not hold the boot token, give it a *scoped*
    credential (site token) or no credential plus loopback + containment +
    CSP — never the boot token. The same reasoning applies in reverse: the
    `/ws` `?token=` in the query string is an accepted risk precisely because
    no third-party code observes it.

### Remote-access authorization (Fase 2A — don't re-learn this either)

Since Fase 2A the **TaskBroker is the single enforcement point** for "who may
invoke a skill over the network", not the plugin. A network-exposed skill
(`localOnly: false`) **without** a `remote` policy is denied by `handleRemote`
before dispatch — the handler never runs. Fail-closed invariants live in
`core/src/task-broker/task-broker.ts` + `remote-access.ts`: `access-pass`
requires a `scope` (rejected loudly at registration); an anonymous remote caller
(no transport-verified `task.peerId`, which only Fase 1B identity binding can
set) can never pass `verified-contact`/`access-pass`; a missing `RemoteGate`
denies; `any` requires the extra manifest permission `network:public:<id>.<skill>`
on top of `network:skill:<id>.<skill>`. When adding a new network-reachable
skill or a new external trigger surface, keep this shape: the platform decides
authorization from a transport-verified identity, never from a caller-supplied
payload field. Access passes are core-owned (`AccessPassManager` via `ctx.access`),
ephemeral, scoped and expiring — never bearer tokens (the peer still proves
possession over the transport).

### JSON nesting depth (corrected finding — don't re-learn this)

`JSON.parse` in current V8 (Node 22, V8 12.4) is **iterative**: it parses
million-deep nesting like `[[[[…]]]]` without throwing. `JSON.stringify` **is**
recursive and overflows (`RangeError: Maximum call stack size exceeded`) on a
deeply-nested object graph. An earlier analysis wrongly claimed `JSON.parse`
crashes on deep input; it does not, in this runtime.

What actually protects us:

- `validateObjectDepth` (in `sdk/src/boundary-guard.ts`) throws
  `ObjectDepthExceededError` at `MAX_OBJECT_DEPTH` (10) **before** recursing,
  so it is stack-safe and caps every parsed object graph at the trust
  boundaries (`apps/core-server` `readJson`, `network-light` `tryDecodeFrame`).
- The pre-parse `validateJsonNestingDepth` helper (same file) is therefore
  **defense-in-depth, not a crash fix**: it rejects over-deep JSON *strings*
  with a deterministic typed error before any parse/stringify work, and it
  protects recursive `JSON.parse` implementations (e.g. Rust `serde_json` in
  the Tauri shell, older/other engines).

The real invariant to maintain: **every `JSON.stringify` that touches
externally-derived data must sit after a `validateObjectDepth` check** — not
just on the happy path, but in error/logging/echo paths too (e.g. the WS ping
handler echoes `message.ts` back into a `stringify`; it now validates first).
When reviewing JSON handling, audit `stringify` sites, not just `parse`.

## Core-server boot token (local HTTP/WS bridge)

The core-server HTTP/WebSocket bridge listens on `127.0.0.1`, but that alone
is not a trust boundary: a hostile page in the user's browser can still reach
it via DNS rebinding or a same-origin `fetch`. Every `/api/*` request and
every `/ws` upgrade must present a per-boot token.

- The token is generated on boot (`randomBytes(32).toString("hex")`) and
  written to `<data-dir>/boot-token` with `0600` permissions. The write is
  atomic (opened with `0o600`) and `fchmod`-normalized before bytes are
  written, so the secret never sits on disk readable by other users.
- Comparison uses `crypto.timingSafeEqual` over fixed-size SHA-256 digests
  (see `apps/core-server/src/auth.ts`), so no length short-circuit leaks
  timing.
- The desktop shell reads the token out-of-band (`get_boot_token` Tauri
  command, or `VITE_P2P_HUB_TOKEN` in a plain-browser dev run) and presents
  it as an `Authorization: Bearer` header on HTTP.

### Accepted risk: token in the WebSocket query string

The browser WebSocket API cannot attach custom headers to the handshake, so
the `/ws` upgrade authenticates via `?token=<token>` in the query string.
This is a deliberate, accepted compromise:

- The token can end up in server access logs, browser history, and any
  reverse-proxy logs in front of the bridge.
- There is no strictly better option within the browser WebSocket API; a
  subprotocol or first-message auth would only move the exposure, not remove
  it.

Do not "fix" this by logging the token or by moving the token into an HTTP
header the browser cannot set. The mitigation is operational: keep the bridge
bound to loopback (default), keep the token short-lived (regenerated each
boot), and avoid logging `?token=` in front of the bridge.

## Review process for anything touching the above

When asked to review or verify security-relevant work in this repo:

- Ask for the actual diff/file contents, not a summary of what changed —
  summaries have repeatedly omitted the one line that mattered (e.g. an
  earlier `rejectUnauthorized: false` wasn't mentioned in its first
  summary).
- Prefer `git diff <last-approved-sha>..HEAD` over re-reading whole files —
  cheaper and makes scope drift immediately visible (did this change touch
  files it had no business touching?).
- For a new trust boundary (network, HTTP, IPC, anything an external actor
  can reach): check independently (a) is there a deny-by-default gate, (b)
  does every write path to a reserved namespace go through the same check,
  (c) can a raw secret leak into any response/log/error message.
- Prefer capability-scoped context objects (`ctx.vault` without
  `getSecret`, `ctx.skills.register` that auto-prefixes) over trusting
  plugin authors to self-restrict. If a restriction can be expressed
  structurally (the plugin *cannot* construct the unsafe call), do that
  instead of documenting "please don't."

## Known open follow-ups (check if still open before starting new work)

- ~~HTTP bridge authentication~~ — resolved: the per-boot shared token now
  guards `/api/*` and `/ws` (see "Core-server boot token" above).
- ~~`P2P_HUB_HOST=0.0.0.0` widens the HTTP bridge beyond localhost with no
  extra warning/gate~~ — resolved: `decideBindHost` requires an explicit
  `P2P_HUB_EXPOSE=1` for any non-loopback bind, with a loud warning at startup.
  Since Fase 0D there is also `P2P_HUB_NETWORKING=0` for a fully local-only
  core-server (no P2P transport, no identity created — the vault is never
  touched, so a corrupt vault cannot fail a local-only boot).
- `network-light` advertises all local skill names via mDNS regardless of
  `localOnly`/`httpExposed` — rejected correctly at the broker, but still
  leaks which skills exist to anything listening on the LAN.
- `birthday-cards` title matching (`/verjaardag|birthday/i`) has no word
  boundaries — false-positives on titles like "Birthday Films". Non-urgent,
  noted for whenever that plugin gets revisited.
- **Plugin UI residuals (Fase 2B, accepted):** (a) `/ui/*` responses set no
  `frame-ancestors`, so any page can embed a plugin's UI in an iframe — inert
  for an attacker, because the UI is sandboxed, origin-pinned to the core-server
  and its bridge calls are allowlisted and denied for non-core origins. (b) The
  plugin UI's *own* outbound `window.parent.postMessage(..., "*")` is their
  code and cannot be pinned from the shell; a hostile page that embeds the UI
  can receive (but never answer) those calls. Revisit if the bridge protocol
  gains outbound capabilities beyond skill invocation.
- **Fase 2B scope decision:** capability-matrix tightening without process
  isolation (Optie 1). OS-level plugin sandboxing is a documented accepted risk
  deferred to Fase 3 — the Ed25519 key holder is the trust boundary today.
- Plugin `id` values are allowed to contain `.`, so two plugins with
  colliding dotted ids (e.g. `"a.b"` and `"a"` registering skill `"b.x"`)
  can produce the same broker skill key. Theoretical today (single
  developer, no external plugin registration yet); revisit if/when plugin
  ids are ever assigned by a third party (marketplace). — ~~open~~ **opgelost
  (Fase 2C)**: plugin ids zijn nu dot-free; de `.` is gereserveerd als
  skill/hook-namespace-scheidingsteken, dus de collisie is structureel
  onmogelijk gemaakt in `validateManifest`.
- Chat's canonical message form is `JSON.stringify` over a fixed-key-order
  object (NFC-normalized text). That is only sound while sender and receiver
  reuse the same `canonicalMessage` constructor. Trigger to revisit: the
  moment a second, independent implementation of the chat protocol appears
  that cannot share that function — switch to an explicit byte-template
  canonicalization. Not needed until then.
- **Cross-process file-locking.** If two instances of the app run against the
  same storage directory at once, they can still race each other's
  atomic-write `rename` at the "who wrote last" level. The shared write queue
  only serializes *within* a process. Not prevented today; a write-with-lock
  architecture is a larger job and out of scope for now.
- **Windows rename semantics.** POSIX `rename()` atomicity is documented
  behaviour, but Windows has historically had subtle differences when
  renaming over an existing file. Everything is only developed/tested on
  Linux so far — add Windows verification to the checklist before claiming
  cross-platform durability.
- **Core-server identity/vault dependency is intentionally unconditional.**
  `apps/core-server` always starts the network bridge, so `getOrCreateIdentity()`
  in `start()` failing loudly on a corrupt vault is deliberate and consistent
  (the server is by definition where network functionality is expected). The
  `PluginHost` is the opposite: it only creates identity lazily, when networking
  starts or a plugin calls `ctx.identity.peerId()`. Keep this asymmetry if a
  "local-only mode" for the core-server itself is ever added — a local-only
  core-server must gate its identity/vault dependency behind networking the same
  way `PluginHost.boot()` now does, not fail hard on a corrupt vault.
- **PeerSite P2P mutual TLS (option c) is deferred.** PeerSite Fase 3
  authenticates inbound peer claims with a challenge-response
  proof-of-possession (`core/src/identity/peer-auth.ts`,
  `p2p-hub:peersite:auth:v1:`) over the existing `network-light` TLS session,
  gated on `ctx.trust.getContact` (verified contact only). A future
  hardening step is to additionally verify the peer's *certificate fingerprint*
  against the contact record so the transport layer itself is pinned to the
  claimed identity; that is a larger network-light refactor and is not done
  yet. Don't "fix" the gap with `rejectUnauthorized: false` (CLAUDE.md
  principle #4) — pin the fingerprint via the already-trusted mDNS TXT side
  channel and verify it after `secureConnect`, when that work happens.

## Spec-gaps: when an acceptance criterion hides a dependency

Acceptance criteria have repeatedly turned out to depend on a capability that
does not exist yet — a "spec-gap" (the `PluginContext` scope in the contacts
brief, and the identity `peerId` accessor in the chat brief are two of them).
The recurring failure mode is treating the criterion as if it *authorized*
filling that gap, which silently widens scope.

- When a criterion blocks on a missing capability, **stop and surface the
  dependency** — do not work around it. Propose the *minimal* extension and
  wait for explicit authorization. The extension should follow the
  capability-scoped shape of `ctx.ai`/`ctx.vault`: the plugin gets exactly
  what it needs, nothing wider.
- Keep capability additions present-tense and narrow. `peerId` and
  `publicKeyHex` are identical today, so `ctx.identity` exposes only
  `peerId()`; a separate `publicKeyHex()` is added **only if** `peerId` later
  gains a `did:key:`-style encoding. Do not pre-build a divergence that has
  not happened.
- When a scope expansion is authorized, record it explicitly — "acceptance
  criterion N expanded to include X" — in the task state and commit message,
  so the drift is visible in review (same spirit as "prefer `git diff` over a
  summary" above).

## Conventions

- Tests: `node:test`, run via `npm run build && npm test` from root.
- New plugin checklist: manifest validated by `loadManifest`
  (id/version/kind/permissions/entry, optional name/exposedEvents/ui), all
  skills default `localOnly: true` + `httpExposed: false` unless a
  matching `network:skill:<id>.<name>` manifest permission is present,
  cross-namespace hook `on` is free, cross-namespace `registerFilter`/
  `emit`/`applyFilters` require namespace ownership or an explicit
  `hooks:filter:<event>` permission.
- Documents that need cross-plugin embedding use `@p2p-hub/sdk`'s
  `PBXBuilder` — don't invent ad-hoc JSON shapes for anything that might
  need an OLE `$ref` later.
