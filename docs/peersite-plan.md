# PeerSite — Local-First Creator Workflow (plan)

Status: **proposal / pre-implementation**. No code written yet. This document is
the design and phased plan; treat each phase as its own scoped task.

## Goal

Let a user build and host a website **on their own disk**, served by their own
desktop agent, without any central server. The site lives as ordinary files in
a user-chosen directory (`~/MyPeerSite/` with `index.html`, `style.css`,
assets, markdown/templates). The agent is the local runtime: it serves the
static files and wires the *dynamic* bits (contact form, "ask this peer" box,
agent status) to the existing trust-tier machinery.

The emphasis is **local-first**: build, test and use at home. Public-internet
reachability for strangers is explicitly **not** a goal (see Non-goals).

## Why this is tractable here

This is not a greenfield feature. The repo already contains most of the
substrate:

- `apps/core-server` is already an HTTP/WS bridge (loopback + per-boot token,
  `src/auth.ts`, trust-gated `settings.json` via `POST /api/settings/apply`).
- Skills already carry an `httpExposed` flag, separate from `localOnly`, i.e.
  a capability-scoped deny-by-default gate per skill already exists.
- `sdk/src/settings-risk.ts` (pure risk engine), `core/src/security/trust-gate.ts`
  (`TrustTierGate`, fail-closed) and the native tier-2 confirmation path were
  added in the security-coherence phase and are directly reusable.
- `sdk/src/boundary-guard.ts` + `sdk/src/sanitizer.ts` provide the
  depth/size/sanitize guards to place at every new trust boundary.
- `network-light` already does mDNS discovery + TLS with cert-fingerprint
  pinning, and identity already exists via `getOrCreateIdentity` / `peerId`.

So the work is chiefly: (a) a validated static-file serve path in core-server,
(b) a scoped (non-boot-token) credential for the site's interactive API, and
(c) new settings-risk rules. Reachability stays local/LAN/friend-only.

## Non-goals (deferred deliberately)

- **No public-internet hosting for strangers.** That is where NAT traversal,
  hole punching, and a browser-facing relay/gateway become unavoidable. A
  gateway is a server someone must run; deferring it keeps this feature
  free of any "central actor" and keeps the scope small.
- **No new network transport.** `network-agentanycast` remains
  "transport NOT implemented"; PeerSite does not change that.
- **No full WYSIWYG editor in v1.** Live-reload on file change is nice-to-have;
  the user edits files with whatever they like. Revisit only after phase 1.
- **No public-internet hosting for strangers is a *phase* decision, not an
  architectural one.** The interfaces built in phases 1–2 must not make that
  future gateway impossible (see the transport-agnostic principle below).

## Architecture: model PeerSite as a service, transport-agnostic

PeerSite must be modeled as a **service/capability**, not as a function glued
into `core-server/src/app.ts`. This mirrors how the repo already structures
`NetworkRegistry`, `TaskBroker`, and the `PluginHost` — a peer is a composition
of services, and PeerSite is one more:

```
PeerSite
├── StaticServer     (validated site-root serve)
├── SiteAPI          (scoped endpoints, trust-gated)
├── SiteCredential   (scoped token, never the boot token)
└── Reachability     (loopback → LAN → trusted P2P → future gateway)
```

The critical rule: **the StaticServer and SiteAPI layers must be
transport-agnostic.** Phase 1 ships loopback-only, but nothing in the serve or
API layer may assume `localhost` is the final transport. Reachability is an
injected binding policy (a "what address can reach me" switch), not a hardcoded
fact baked into the handlers. That way the same PeerSite can later be reached
via loopback → LAN → P2P → relay/gateway → normal browser without reopening the
design.

This also re-frames the goal: we are not building a mini web-server; we are
building a web interface for a peer identity, of which static serving is only
the first surface.

## Core design tension: the boot token is all-or-nothing

This is the single most important decision and the thing that distinguishes
this plan from "just serve a directory".

Today every `/api/*` and `/ws` upgrade on the core-server bridge is guarded by
a per-boot token (`apps/core-server/src/auth.ts`, `timingSafeEqual` over
SHA-256 digests). The token is written to `<data-dir>/boot-token` (0600) and
read out-of-band by the desktop shell; it is deliberately never exposed to the
browser page, cookies, localStorage or console.

The moment a PeerSite page wants to call the agent (a "prompt window"), a
problem appears: the site is served **same-origin** with `/api/*` by the very
same bridge. For the page's client JS to call the agent API it would need the
token — but putting the boot token into page source hands the *entire* bridge
(settings apply, task broker, WS bus) to anyone who can view the page (a LAN
visitor, a browser extension, an XSS on the user's own site).

Therefore:

- **The site's interactive API must NOT use the boot token.** It gets its own
  scoped credential/capability with a much smaller blast radius.
- This is a **new trust boundary**, not a reuse of an existing one
  (CLAUDE.md principle #1). It needs its own deny-by-default gate.

### Design direction for the scoped credential (to be finalized in phase 2)

- A separate, per-site or per-boot **site token** scoped to a fixed allowlist
  of `peersite:*` endpoints, or
- a capability object injected by the local creator (the desktop shell) that
  the page receives only when the creator opts in, so a random LAN visitor's
  browser never gets it.
- Either way, the raw boot token stays out of page source, and the site token
  must never grant `/api/settings/apply`, `/ws`, or task execution by default.

## Threat model & hardening checklist

The biggest risks for a static file server, in priority order:

1. **Path traversal / file escape.** `startsWith(dir + sep)` on the resolved
   path is the baseline (CLAUDE.md principle #3), but a static server needs
   more: resolve the site root with `realpath` and require the *real* path of
   each served file to stay under the *real* root (this also kills symlinks
   pointing out of the tree). Reject `..` segments before resolving.
2. **Hidden/sensitive files.** Never serve dotfiles (`.env`, `.git`) or any
   file under the agent's own `<data-dir>`. The site root must be a
   user-chosen directory and must never be the data-dir — otherwise
   `boot-token` (and vault files) become servable. Default-deny dotfiles
   unless explicitly allowlisted by the creator.
3. **Content-type & response headers.** Serve correct `Content-Type`; set
   `X-Content-Type-Options: nosniff` and a restrictive `Content-Security-Policy`
   because the served HTML/JS is user-authored. No `Content-Disposition` leaks
   of arbitrary files unless intended.
4. **The token gate does not apply to static assets.** A browser visiting
   `localhost:PORT` has no token. Static serving is a distinct path from
   `/api/*`/`/ws`, and its exposure is controlled by the *host binding*, not
   the token: loopback (Tier 0) is fine; binding to LAN makes the site readable
   by anyone on the network *without* a token. This feature therefore must be
   designed together with the existing `P2P_HUB_HOST=0.0.0.0` open follow-up —
   a LAN binding for PeerSite must be an explicit, separate opt-in.
5. **No secrets in responses/logs.** The dynamic API returns only
   metadata/booleans/masked values, never vault contents, API keys, or the
   boot/site token. Reuses the vault-metadata-only discipline already in place.

## Reachability tiers → existing flags

Three clear "reach" levels, mapped onto what already exists:

| Level | Who | Binding | Advertising | Trust tier |
|-------|-----|---------|-------------|------------|
| Private | creator only | loopback only | none | 0 |
| LAN | household (phone/tablet) | explicit non-loopback bind | mDNS via `network-light` | 1 |
| Friends | agents you invited | existing TLS + fingerprint pinning | peer-ID invite | 2 (native confirm) |

New settings flag(s), following the pure `EffectiveSettings` shape
(`sdk/src/settings-risk.ts`):

- `peersiteEnabled` — master switch, default `false`.
- `peersiteLanExposed` — binds beyond loopback + advertises via mDNS, default
  `false`. (Mirrors `p2pHubExposed`; decide whether it reuses or extends it.)
- Dynamic agent interaction on the site is a separate, higher-risk opt-in
  (see the scoped-credential section).

New risk rules (same pure, tested pattern as the existing three):

- `peersiteEnabled && peersiteLanExposed && <site agent API enabled>` →
  MEDIUM/HIGH (site reachable off-box *and* the site can drive the agent).
- `… && unrestrictedRemoteSkills` → HIGH.
- `… && allowExternalApiExecution` → CRITICAL `ERR_EXPOSED_PEERSITE_EXECUTION`
  (a LAN-visible site that can auto-run external tasks = the blast-radius worst
  case).

## Phased plan

Execution is deliberately split into three separately reviewable, separately
committable phases (never one big PR — that produces security blind spots).

### Phase 1 — boundary + loopback-only static serve (the safe vertical slice)

Combines the old phase 0 (decisions) with the static serve, structured as the
`PeerSite` service skeleton so phase 2–3 plug in without rework:

- **Boundary decisions (do first, in this phase):** site-root selection UX and
  where the root is recorded (a `settings.json` field, validated like
  `manifest.id` before it becomes a path); scoped-credential shape + endpoint
  allowlist; flag names + exact risk rules added to the engine spec with tests.
- **Service skeleton:** `StaticServer` + `SiteAPI` + `Reachability` as a
  transport-agnostic capability, injected into `core-server` rather than
  inlined into `app.ts`. `Reachability` starts loopback-only.
- **Static serve:** validated `siteRoot` (realpath-resolved, user-chosen, never
  the data-dir); rejects `..`/encoded traversal, realpath containment, symlink
  escape, default-deny dotfiles, Content-Type + `nosniff` + CSP, 404 (not 403)
  for anything it will not reveal.
- `peersiteLanExposed` flag exists as a deny-by-default placeholder (not wired
  to any bind yet).
- Tests: traversal, symlink escape, dotfile, data-dir rejection, headers.

### Phase 2 — scoped agent API + LAN opt-in

- The dynamic endpoints (`/peersite/status`, `/peersite/message`, …) behind the
  scoped site credential — **not** the boot token. Rate-limit. Tier 0 read-only
  status; Tier 1 message; Tier 2 anything skill-exec (native confirm, reusing
  the existing tier-2 path).
- Wire `peersiteLanExposed` to a non-loopback bind + mDNS advertisement,
  explicitly separate from `P2P_HUB_HOST`, with a loud warning at startup when
  widening (CLAUDE.md principle #8: no silent widening).
- Re-audit the mDNS skill-name leak follow-up before advertising the site.

### Phase 3 — friends / P2P

- Peer-ID invite over the existing `network-light` TLS + fingerprint pinning.
- Documented as a separate opt-in; native tier-2 confirm on first enable.
- This is also where a future public gateway/relay would slot in as a new
  `Reachability` policy — the transport-agnostic skeleton is what makes that
  possible without reopening phases 1–2.

## Open questions (resolve at phase 1)

1. Does `peersiteLanExposed` reuse `p2pHubExposed` or become its own flag?
   (Lean: its own — a site and a P2P hub are different threat models, per
   CLAUDE.md principle #1.)
2. Is the scoped site credential per-boot (like the boot token) or a long-lived
   capability the creator revokes explicitly? (Lean: per-boot, regenerated on
   each start, low blast radius.)
3. Live-reload / file-watching: in or out of v1? (Lean: out; `fs.watch` is
   flaky and adds a watcher that must be torn down on dispose.)

## Files likely to touch (phase 1)

- `apps/core-server/src/peersite/` (new) — `StaticServer`, `SiteAPI`,
  `Reachability`, `SiteCredential` service skeleton, transport-agnostic.
- `apps/core-server/src/app.ts` — instantiate/wire the `PeerSite` service with a
  loopback-only `Reachability` policy.
- `apps/core-server/src/peersite.test.ts` — traversal, symlink escape, dotfile,
  data-dir rejection, headers.
- `sdk/src/settings-risk.ts` + `sdk/src/settings-risk.test.ts` — new flags and
  rules (pure, tested).
- `apps/desktop-shell/src/components/SettingsWindow.tsx` — new toggles once
  flags exist.
- `docs/HANDOFF.md` — record progress at each phase.
