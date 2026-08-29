# P2P-Hub: Sovereign Local-First & Peer-to-Peer Network Architecture

> **Zero-server, identity-first, privacy-by-design P2P runtime.**
> Peers find each other over mDNS on the local network and talk directly over
> encrypted, authenticated TCP — no central servers, no cloud databases, no
> public ports.

`#p2p` `#local-first` `#privacy-by-design` `#plugin-architecture` `#identity-first`

[![CI Multi-OS](https://github.com/juustesout/p2p-hub-agentic/actions/workflows/ci.yml/badge.svg)](https://github.com/juustesout/p2p-hub-agentic/actions)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#-cross-platform-support)

---

## What is P2P-Hub?

**P2P-Hub** is a local-first application framework and peer-to-peer runtime.
It turns any device on your LAN into an active peer that can securely host
capabilities, publish static websites, route tasks between agents, and run
local AI workflows — all without central infrastructure.

It is a plugin architecture at heart: `sdk` defines the contracts, `core`
hosts plugins inside a capability-scoped `PluginContext` (storage, hooks,
skills, vault, ai), and plugins are reached either over the local P2P layer
(`network-light`) or the loopback-only HTTP/WebSocket bridge
(`core-server`).

### Key use cases

* **P2P static-site hosting (`p2p-hub:website:v1`):** serve a static website
  directly from your machine to verified contacts — no web server, no public
  IP (`plugins/peersite`).
* **Sovereign capability sharing:** offer local tools and subscriptions (AI,
  scrapers, compute) as skills to trusted peers behind explicit access gates.
* **Identity-first interaction:** every peer interaction is authenticated by
  an Ed25519 identity bound to the transport, with contact verification via
  challenge-response and name resolution via the ENS plugin.
* **No public attack surface:** the only listener is a loopback-only HTTP/WS
  bridge guarded by a per-boot token — invisible to anything off the host.

---

## Core architecture (four axes)

| Axis | What it is |
|------|-----------|
| **1. Identity** | Ed25519 keypairs per peer; transport identity binding (Fase 1B) pins the presented TLS certificate fingerprint to the announced `peerId` via the mDNS TXT side channel. |
| **2. Capability** | Versioned, default-deny wire contracts (`p2p-hub:website:v1`, `p2p-hub:peersite:auth:v1`). Unknown protocol/version or malformed envelopes are rejected. |
| **3. Transport** | `network-light`: mDNS discovery + encrypted, authenticated TCP. `network-libp2p`: opt-in WAN transport over a circuit-relay for reaching peers behind NAT (same identity, no discovery). Transport-agnostic by design (`network-agentanycast` is an alternative daemon-backed transport). |
| **4. Content** | Local-first assets served under strict directory containment, with per-asset byte caps and byte-exact transfer. |

**Agents get their own derived identities** (child keypairs, not the
operator's `peerId`) — a formal design decision in `plan.md` that keeps
agent-initiated actions gated and auditable.

---

## Security & containment principles

* **Default-deny at every boundary.** A skill is network-reachable only via
  an explicit `network:skill:<id>.<name>` manifest permission and a matching
  broker-side authorization (`verified-contact`, scoped and expiring access
  passes). `localOnly` and `httpExposed` are independent flags with separate
  gates.
* **Strict containment (`resolveAndContainFile`).** Path traversal, symlink
  escapes, NUL-byte and dot-segment attacks are structurally rejected;
  `mirrorDestination` applies the same rules on the write side.
* **Identity is never caller-supplied.** Authorization derives from a
  transport-verified `peerId`, never from a payload field; the TaskBroker is
  the single enforcement point for remote skill invocation.
* **Vault secrets stay in one place.** Raw secrets are read only by the core
  vault manager; plugins get a capability-scoped `ctx.vault` without
  `getSecret`, and `ctx.ai` never exposes the raw key.
* **Sandboxed viewing.** Remote P2P sites render inside origin-isolated,
  sandboxed iframes with an origin-pinned `postMessage` bridge — no access to
  internal APIs.
* **Fail-loud storage.** All persistence goes through atomic writes; a file
  that exists but cannot be parsed throws `StorageCorruptionError` rather
  than silently starting "empty".

---

## Network protocol stack

Hosts run no traditional web server, so capability traffic travels as a
versioned JSON envelope over the P2P transport:

```
┌──────────────────────────────────────────────────────────────┐
│  Capability : p2p-hub:website:v1 (versioned JSON envelope)    │
├──────────────────────────────────────────────────────────────┤
│  Broker     : TaskBroker (authorize -> dispatch)              │
├──────────────────────────────────────────────────────────────┤
│  Transport  : network-light (encrypted TCP / TLS)             │
├──────────────────────────────────────────────────────────────┤
│  Discovery  : mDNS (TXT record: id, cert fingerprint, peerId) │
└──────────────────────────────────────────────────────────────┘
```

Every connection goes through an authenticated handshake
(`hello` -> `hello_ack` -> `auth`); the presented TLS certificate must
match the announced fingerprint, and the handshake signs the identity
binding with Ed25519. There is no anonymous mode.

### Request / response (`p2p-hub:website:v1`)

```json
// REQUEST (verified peer)
{ "protocol": "p2p-hub:website:v1", "version": 1, "path": "/index.html" }

// RESPONSE (200-equivalent, body is base64 bytes)
{ "protocol": "p2p-hub:website:v1", "version": 1,
  "status": "ok", "contentType": "text/html",
  "name": "index.html", "data": "PGh0bWw+PC9odG1sPg==" }
```

---

## Reaching peers beyond the LAN (WAN relay, opt-in)

The LAN transport (`network-light`) finds peers over mDNS on the local network.
To reach peers on the internet — e.g. behind NAT/CGNAT — the core-server can
additionally run the **WAN transport** (`network-libp2p`) against an
operator-supplied [circuit-relay v2](https://libp2p.io/docs/circuit-relay/)
node. This is strictly **opt-in** (`P2P_HUB_WAN_ENABLED`, default `false`): a
default boot keeps the zero-public-surface posture unchanged.

The WAN transport:

* **Shares the p2p-hub identity.** The libp2p transport PeerId is derived from
  the *same* Ed25519 identity as the LAN peerId (`IdentityManager`'s
  `exportLibp2pKeySeed()`), so a peer is addressable by one identity over both
  LAN and WAN — no dual-identity split.
* **Is a pure bytepipe.** It carries the exact same authenticated wire contract
  as the LAN transport (`hello` → `hello_ack` → `auth` → `task` → `result`) and
  **discovers nothing**: it only dials the relay and listen addresses you
  configure. There is no WAN discovery/routing surface.
* **Keeps the TaskBroker as the single authorization point.** A
  network-exposed skill without a `remote` policy is still denied before
  dispatch, no anonymous traffic, and the broker-wide per-peer rate-limit gate
  is a hard start precondition.
* **E2E-encrypted content, visible participant metadata.** The relay forwards
  bytes and never terminates the Noise session, so message *content* stays
  confidential. That does **not** hide *who talks to whom*: the relay operator
  can observe the two endpoint PeerIds of every relayed connection plus its
  volume and timing — the same metadata trade-off this project already
  documents for the LAN transport and ENS resolution. Relay through an operator
  you control.

### Run against a relay

> **Whose relay is this?** The address below is a **first-party** relay operated
> by this project's own developer (the VPS is owned and paid through July 2027)
> and was used to verify this wiring end-to-end (reachability + encrypted
> reservation + relayed address, confirmed live). It is operator-controlled
> infrastructure, not an unaffiliated third-party service — but it is still a
> **single point of metadata**: every peer that uses it routes its connection
> metadata (endpoints + volume/timing) through this operator, and availability
> depends on that one VPS. For full sovereignty and redundancy, point
> `P2P_HUB_WAN_RELAY` at relays you run yourself (a circuit-relay node is ~20
> lines: `circuitRelayServer()` + tcp + noise + yamux) or configure more than
> one.

```bash
# Build once (the WAN provider is a workspace dependency)
npm run build

# Start the core-server with the WAN transport wired to a relay
P2P_HUB_WAN_ENABLED=true \
P2P_HUB_WAN_RELAY="/ip4/144.172.102.63/tcp/4002/p2p/12D3KooWJYuvYQS7jkknLkNfrNaqEtcej2qKn5uZwQgZwHUT2TyV" \
npm run start -w @p2p-hub/core-server
```

At startup the node dials the relay, claims an encrypted reservation and
advertises a relayed (`/p2p-circuit`) address, so peers behind NAT become
reachable. Full env-var table lives in `apps/core-server/src/config.ts`:

| Variable | Meaning |
| --- | --- |
| `P2P_HUB_WAN_ENABLED` | Enable the WAN transport. Default `false`; ignored while networking is disabled. |
| `P2P_HUB_WAN_RELAY` | Operator circuit-relay v2 multiaddr to dial and reserve through. |
| `P2P_HUB_WAN_LISTEN` | Optional comma-separated listen multiaddrs (default loopback ephemeral). |

---

## Getting started

### Prerequisites

* **Node.js >= 20** (CI runs 20 and 22)
* **npm** (workspaces enabled)
* **Rust** — only required for the native Tauri shell / `cargo test`

### Install & build

```bash
# Install dependencies across all workspaces
npm install

# Build the entire platform
npm run build
```

### Run the tests

```bash
# All unit tests across workspaces (excludes the multi-peer testlab)
npm run test:unit

# Multi-peer smoke scenario (3 in-process PluginHosts over real mDNS/TLS)
npm run test:smoke

# Everything (build first)
npm run build && npm test
```

### Scaffold a plugin

```bash
npm run scaffold-plugin
```

---

## Cross-platform support

Continuously integrated on real runners, with unit + smoke tests and Rust
`cargo check`/`cargo test`:

* **Ubuntu Linux** — Node 20 & 22
* **Windows** — Node 20 & 22 (PowerShell-safe scripts, canonical path handling)
* **macOS** — Node 20 & 22 (symlink-boundary containment validation)

> Known CI blind spot: mDNS multicast is not delivered between in-process
> peers on GitHub macOS runners, so discovery-dependent tests skip there with
> a visible reason. mDNS works on real macOS machines — see `CLAUDE.md`.

---

## Project structure

```
p2p-hub/
├── sdk/                  # Wire contracts, PBX/OLE object-graph, boundary guards
├── core/                 # PluginHost, TaskBroker, vault, identity, site mirroring
├── plugins/
│   ├── network-light/    # LAN transport: mDNS discovery + encrypted TCP
│   ├── network-libp2p/   # WAN transport: opt-in circuit-relay bytepipe (see below)
│   ├── peersite/         # P2P static-site publishing (website:v1)
│   ├── chat/             # Signed 1-on-1 messaging over the network
│   ├── contacts/         # Identity registry (challenge-response proof of possession)
│   ├── ens/              # ENS name -> verified peerId resolution (fail-closed)
│   ├── smartbase/        # Structured data on the PBX/OLE standard
│   ├── vault/            # Encrypted vault skills over the broker
│   └── ...               # demo plugins (calendar, tasks, notes, paint, calc)
├── apps/
│   ├── core-server/      # Loopback HTTP/WS bridge to core capabilities
│   │                     # + opt-in WAN transport wiring (P2P_HUB_WAN_*)
│   ├── desktop-shell/    # Tauri desktop shell for the P2P network
│   ├── testlab/          # Multi-peer integration lab (smoke scenarios)
│   └── create-p2p-plugin # Plugin scaffold & signing tooling
└── scripts/              # Cross-platform test runner
```

---

## License

Dual licensing, by component:

* **Core repository** — everything under `core/`, `apps/`, `plugins/` and
  the build tooling: **GNU AGPLv3**. See [`LICENSE`](LICENSE).
* **SDK** (`sdk/`) and **plugin templates** (plugins scaffolded via
  `create-p2p-plugin`, which default to `license: "MIT"`): **MIT**. See
  [`sdk/LICENSE`](sdk/LICENSE).

Pick a license only after understanding both: AGPLv3 (network-copyleft) for
the core platform, MIT (permissive) for the SDK and the plugins others
build on top of it.

(agent-hardening test: this line is a deliberate, harmless doc-only change
to observe how the AI reviewer treats PR content)
