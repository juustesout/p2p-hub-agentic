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
- `P2P_HUB_HOST=0.0.0.0` widens the HTTP bridge beyond localhost with no
  extra warning/gate — should probably require an explicit, separate
  opt-in rather than just an env var value.
- `network-light` advertises all local skill names via mDNS regardless of
  `localOnly`/`httpExposed` — rejected correctly at the broker, but still
  leaks which skills exist to anything listening on the LAN.
- `birthday-cards` title matching (`/verjaardag|birthday/i`) has no word
  boundaries — false-positives on titles like "Birthday Films". Non-urgent,
  noted for whenever that plugin gets revisited.
- Plugin `id` values are allowed to contain `.`, so two plugins with
  colliding dotted ids (e.g. `"a.b"` and `"a"` registering skill `"b.x"`)
  can produce the same broker skill key. Theoretical today (single
  developer, no external plugin registration yet); revisit if/when plugin
  ids are ever assigned by a third party (marketplace).
- Chat's canonical message form is `JSON.stringify` over a fixed-key-order
  object (NFC-normalized text). That is only sound while sender and receiver
  reuse the same `canonicalMessage` constructor. Trigger to revisit: the
  moment a second, independent implementation of the chat protocol appears
  that cannot share that function — switch to an explicit byte-template
  canonicalization. Not needed until then.

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
