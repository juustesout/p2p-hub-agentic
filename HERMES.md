# HERMES.md

Installation and run instructions for **Hermes**, the Nous Research desktop
agent. Read this before installing, building, or launching the Tauri shell on
the local Windows machine. It exists so you do not have to re-derive every
gotcha yourself.

## What this repo is

`p2p-hub-agentic` is a P2P-first, plugin-extensible desktop suite
(TypeScript, npm workspaces). Plugins are loaded by a `PluginHost` in
`@p2p-hub/core` and exposed through two processes:

- `apps/core-server` — HTTP + WebSocket bridge, default `127.0.0.1:8787`.
- `apps/desktop-shell` — a Tauri 2 + React shell that is a **thin wrapper**:
  it has almost no logic of its own. Everything it shows comes from the
  core-server over `/api/*` (HTTP) and `/ws` (WebSocket).

The native Tauri shell **starts the core-server itself** as a *sidecar*: the
Rust layer spawns the core-server with `P2P_HUB_PORT=0` (an OS-assigned port)
and `P2P_HUB_SIDECAR_READY=1`, waits for the
`[P2P_HUB_READY] {"port":…,"token":"…","state":"locked"|"ready"}` stdout
handshake, and hands those coordinates to the frontend via the
`get_backend_config` Tauri command. The shell does not need a separately
started core-server. Plain-browser dev mode is the exception: there is no Rust
host, so you still start the core-server first and Vite proxies to it.

### Sidecar resolution: SEA binary vs dev layout

`resolve_core_command` (in `src-tauri/src/sidecar.rs`) picks what actually gets
spawned, in this order:

1. **`P2P_HUB_CORE_BIN`** — explicit override, always wins.
2. **Release builds**: the Single Executable Application binary
   `p2p-hub-core` produced by `npm run build:sea` and bundled by Tauri
   (`bundle.externalBin`). A shipped desktop app has no Node — the SEA binary
   is the only thing that can run there. The node-script dev layouts below
   remain a fallback so a release binary still boots on a machine with the
   monorepo checked out.
3. **Debug builds**: `node <repo>/core-server/dist/index.js` (always current
   after `npm run build`), with the SEA binary as the fallback so
   `cargo tauri dev` against a built binary behaves like release.

The SEA binary is produced by `npm run build:sea` (see below) and must exist
before `cargo tauri dev` / `tauri build`, because Tauri requires the
`externalBin` file at build time.

### Vault lock-gate (Slice 2)

If a vault file already exists (`~/.p2p-hub/vault.json`) and networking is
enabled, the sidecar boots **locked**: the HTTP/WS bridge binds and answers
health, but P2P transports and plugin storage stay down until the operator
enters the master key.

- The ready handshake reports `"state":"locked"`, and `/api/health` returns
  `{locked: true, vaultExists: true, networkPaused: false}`. Unknown or
  missing `state` is rejected fail-closed on both the Rust and frontend sides.
- The shell renders a full-screen unlock screen (no desktop, no stale vault
  data) until the master key is in. Unlock goes through
  `POST /api/vault/unlock` (`{masterKey}`). A wrong key returns a terse
  401 `"invalid master key"` — no hint about whether the vault exists.
- Only after a successful unlock does the core-server call `host.boot()`,
  start the LAN/WAN transports, broadcast `vault:unlocked`, and let the
  desktop render.
- A fresh install (no vault file) boots straight to `"state":"ready"` — no
  unlock screen.
- **Plain-browser dev mode is not locked.** Without the sidecar flag the
  server runs as before; the lock-gate only activates under the Tauri sidecar
  (where a real desktop with a real key is expected). The same vault file in
  both processes is why dev and native must agree on `P2P_HUB_DATA_DIR`.

## Prerequisites (Windows)

- **Node.js 20+** (repo is developed against Node 22).
- **Rust stable with the MSVC toolchain** — install via `rustup` with
  `rustup default stable-x86_64-pc-windows-msvc`, plus the **Visual Studio
  Build Tools (C++ build tools)** component. `cargo check` is already green on
  MSVC.
- **WebView2 runtime** — usually preinstalled on Windows 10/11; required by
  Tauri.
- **Tauri CLI** — NOT a repo dependency, install it yourself:
  `cargo install tauri-cli --locked` (or `npm install -g @tauri-apps/cli`).

## Install and build

Run everything from the repo root. This is a **single npm workspace** — install
once at the root, never inside a subpackage:

```sh
npm install
npm run build      # tsc -b: builds sdk, core, plugins/*, core-server
```

`npm run build` is a prerequisite before running the core-server, because the
server executes from `apps/core-server/dist/index.js`, not from source.

### Tests

Tests use `node:test` and run against compiled output, so build first:

```sh
npm run build && npm test
```

Expect all workspaces green (historically 1038 tests, 0 failures). One harmless
log line `[hooks] action handler for "demo:event" failed: Error: boom` is a
deliberate test artifact.

## Run

### Browser/dev mode (Vite on `:5173`) — still two processes

```sh
# 1. Start the core-server first
node apps/core-server/dist/index.js
```

- Listens on `127.0.0.1:8787` by default (`P2P_HUB_PORT` overrides; `0` lets the
  OS assign a port).
- On boot it writes a per-boot token to `<data-dir>/boot-token`.
- Default data dir is `~/.p2p-hub` (`P2P_HUB_DATA_DIR` overrides).
- It auto-resolves the plugins dir from the monorepo (`plugins/`), so plugins
  are picked up from the compiled `dist/` of each plugin.

```sh
# 2. Then start the shell
cd apps/desktop-shell && npm run dev
```

This runs `build:core` + the core-server + Vite concurrently, and Vite proxies
`/api` and `/ws` to `127.0.0.1:8787`.

### Native Tauri shell — one process (sidecar)

```sh
# 1. Build the SEA sidecar binary once (also produces the Tauri externalBin)
npm run build:sea
# 2. Run the shell
cd apps/desktop-shell/src-tauri && cargo tauri dev
```

`beforeDevCommand` runs `npm run ui` (Vite), and `devUrl` points at
`http://localhost:5173`. The Rust host spawns the core-server sidecar itself
and the frontend learns the real port + token from `get_backend_config` — do
NOT start a second core-server on `8787` manually (the sidecar uses port 0).

### Standalone core-server binary (`p2p-hub-core`, SEA)

`apps/core-server` builds itself into a **Single Executable Application**: a
single `p2p-hub-core` binary (the Node runtime + the whole core-server + all
its runtime dependencies inlined) that runs on any glibc Linux / Windows /
macOS machine **without Node installed**. It is the desktop app's production
sidecar and the target of the standalone boot tests.

```sh
# From apps/core-server (or the repo root):
npm run build:sea     # bundle + SEA blob (V8 code cache) + inject + Tauri copy
npm run test:sea      # regression suite against the built binary
```

- **Bundling**: esbuild bundles `src/index.ts` → `dist/bundle.cjs`
  (CommonJS, Node 22 target, minified). The bundle carries the crypto +
  native-module prelude: `*.node` requires are never inlined (they ship as
  files next to the binary; the prelude retries `<bin>/bin/lib`,
  `<bin>/lib`, `<bin>/bin` and otherwise fails loudly with the module path).
- **Blob**: `node --experimental-sea-config sea-config.json` → the V8 code
  cache is generated **at blob-build time** (Node ≥ 21 behavior — there is no
  "run once to warm the cache" step).
- **Injection**: `postject` embeds the blob in a copy of `process.execPath`.
  On macOS the result is re-signed (ad-hoc) because injection invalidates the
  original signature.
- **Outputs**:
  - `apps/core-server/dist/bin/p2p-hub-core[.exe]` — runnable standalone.
  - `apps/desktop-shell/src-tauri/bin/p2p-hub-core-<target-triple>` — the
    Tauri `externalBin` copy (gitignored, rebuilt by `build:sea`).
- The binary reports its version at boot (`[core-server] p2p-hub-core v0.1.0`);
  standalone (non-Tauri) runs print it too.

Manual standalone smoke (boots a fresh server on an OS-assigned port):

```sh
P2P_HUB_PORT=0 P2P_HUB_SIDECAR_READY=1 ./apps/core-server/dist/bin/p2p-hub-core
```

With no monorepo `plugins/` present the binary falls back to
`<dataDir>/plugins` (created empty, with a warning) instead of failing to
boot; `P2P_HUB_PLUGINS_DIR` pointing at a missing dir still fails loudly.

### Systray, OS notifications & window lifecycle (Slice 2)

The native shell owns the OS chrome; the webview owns the logic. Their split:

- **Systray.** Built in `lib.rs::setup()`: a disabled status header
  ("P2P Hub — connecting…" until the webview reads health and pushes
  `set_tray_state`), then Open Dashboard / Lock Vault / Pause-or-Resume
  Network / Quit P2P Hub. Lock and pause are **intents only**: the tray emits
  `p2p:lock-vault` / `p2p:toggle-network` to the `main` webview, which calls
  `/api/vault/lock` and `/api/network/pause|resume` (the JS tests cover the
  actual HTTP). `set_tray_state` (status text + pause/resume label) is invoked
  from the frontend on health changes.
- **Close = hide, Quit = exit.** `on_window_event` intercepts
  `CloseRequested` and hides the window instead (the sidecar keeps running).
  Quit-from-tray sets a `QuitState(AtomicBool)`, SIGTERMs the sidecar via
  `SidecarHandle::stop()` and calls `app.exit(0)`.
- **OS notifications.** The frontend sanitizes bridged events
  (`chat:messageReceived`, `tasks:taskUpdated` accept/decline/completion) in
  `src/services/notify-lib.ts` — never message text or raw payloads, only
  sanitized labels like "Nieuw bericht van Peer X" — then calls the `notify`
  Rust command (`tauri-plugin-notification`). Click-to-focus is exposed as the
  `focus_main_window` command. Tray-event wiring lives in
  `src/services/tray.ts`; plain-browser dev has no tray/notification surface
  and degrades silently.

## Things to watch out for (gotchas)

These are the mistakes that have already burned someone here. Do not re-learn
them.

1. **Rust crate name.** The Cargo package is `p2p-hub-shell`, so `main.rs` must
   call `p2p_hub_shell::run()` (hyphen becomes underscore). A previous version
   wrongly said `p2p_hub_shell_lib` — that does not exist. Do not rename the
   lib crate or the package.

2. **Icons.** `src-tauri/icons/icon.ico` (multi-res) and `icon.png` (512) are
   already committed, and `tauri.conf.json` `bundle.icon` lists both. A Windows
   build fails without `icon.ico`. If you regenerate icons, keep both files and
   both entries.

3. **Tauri CLI is not vendored.** There is no `@tauri-apps/cli` in
   `package.json`. Install it (cargo or npm global) or `tauri dev`/`tauri build`
   will not exist.

4. **Boot token.** Every `/api/*` request and `/ws` upgrade needs the per-boot
   token. The native shell gets it out-of-band: the sidecar reports
   `{port, token}` over the `[P2P_HUB_READY]` stdout handshake, which the Rust
   host serves to the frontend via `get_backend_config` (the token also lands in
   `<data-dir>/boot-token`, read by the legacy `get_boot_token` command). In
   plain-browser dev mode (no Tauri), the frontend falls back to
   `VITE_P2P_HUB_TOKEN`. If `/api/capabilities` returns 401, the token is
   missing or the data dirs differ (`P2P_HUB_DATA_DIR` must match in both
   processes). Never put the token on a shell's stdout unless the sidecar flag
   `P2P_HUB_SIDECAR_READY=1` is set — that gate is what keeps a plain terminal
   run from leaking it into an unwatched log.

5. **Do not bind non-loopback casually.** The bridge is token-guarded but binds
   to `127.0.0.1` by default. Setting `P2P_HUB_HOST=0.0.0.0` alone is refused;
   it requires an explicit `P2P_HUB_EXPOSE=1`.

6. **`@p2p-hub/sdk` is CommonJS.** The Vite config already carries an
   `optimizeDeps`/`build.commonjsOptions.include` fix (`/node_modules/` and
   `/sdk/dist/`) so Rollup resolves named exports like `evaluateSettingsRisk`.
   Do not remove that block or the production shell build silently breaks.

7. **One workspace, one lockfile.** Do not `npm install` inside `sdk/`,
   `core/`, `plugins/*`, or `apps/*`. Dependencies (including the ENS plugin's
   `viem`/`unicode-confusables`) are resolved at the root.

8. **Web3 stays in `plugins/ens`.** Do not add `viem` or any web3 dependency to
   `core` or `sdk`. The ENS plugin is deliberately the only Web3-touching code.

9. **Native tier-2 confirmation.** The frontend calls
   `invoke("request_tier2_confirmation", { request })` with a discriminated
   union `{ kind: "critical-settings" | "peer-access-request", ... }`. The Rust
   `ConfirmationRequest` enum mirrors it via
   `#[serde(tag = "kind", rename_all = "kebab-case")]`. Keep the `kind` values
   and the field names (`peerId`, `expiresInMs`) in sync between
   `apps/desktop-shell/src/services/trust-confirm.ts` and
   `src-tauri/src/lib.rs`.

10. **Repos read this before changes.** `CLAUDE.md` documents the security
    invariants (deny-by-default boundaries, namespace prefix anchoring,
    atomic writes, boot token, JSON depth guards). If you change anything under
    `core/`, `sdk/`, `apps/core-server/`, or a plugin `manifest.json`, read
    `CLAUDE.md` first.

11. **Tray requires the `tray-icon` feature.** `Cargo.toml` pins
    `tauri = { version = "2", features = ["tray-icon"] }`. Dropping that
    feature breaks the tray (`tauri::tray` is `cfg`-gated behind it) and
    `set_tray_state`. The first `cargo check` after adding
    `tauri-plugin-notification` fetches new crates — do not read an offline
    failure as a code error.

12. **The tray menu ids are load-bearing.** `set_tray_state` rebuilds the menu
    with the same ids (`tray-status/open/lock/pause/quit`) so
    `tray_action_for` dispatch stays stable. Rename one and the toggle stops
    firing.

13. **Notification payloads are sanitized before they reach Rust.** The `notify`
    command is deliberately dumb — the frontend (`notify-lib.ts`) strips
    message text and secrets. Never push raw event payloads into a
    notification title/body; the OS lock screen would render them.

14. **`docs/journey/` stays untracked; `docs/wiki/` is never created.** Do not
    `git add` the journey notes, and do not invent a wiki directory.

15. **Sandboxed plugin loading is unavailable under the SEA binary.** The
    Fase-3 process sandbox (`core/src/sandbox/launcher.ts`) spawns
    `process.execPath`; inside a SEA binary that path IS the binary, so
    a sandboxed plugin would "spawn the whole core-server again". The SEA
    binary therefore loads plugins in-process only, and — with no bundled
    plugins dir — normally loads none. Bundled/on-disk plugins under SEA are a
    future packaging step; `P2P_HUB_PLUGINS_DIR` remains the escape hatch for
    pointing at real plugin dirs, in which case plugins load via the in-process
    loader (the sandbox path never activates).

16. **The SEA binary is large (~120 MiB) and gitignored.** `dist/bin/` and
    `src-tauri/bin/` are build artifacts — never commit them. `build:sea`
    always regenerates them from the current bundle; if a test or the Tauri
    build complains about a missing `p2p-hub-core-<triple>`, run `npm run
    build:sea` first.

## Quick sanity checklist before reporting "it works"

- `npm run build` exits clean.
- `npm run build && npm test` — 0 failures.
- Core-server logs that it is listening on `127.0.0.1:8787` and wrote the boot
  token.
- The shell window loads and `GET /api/capabilities` returns 200 (not 401).
- The native dialog appears for a critical settings change (no JS `confirm`
  fallback exists).
- With an existing vault file, the shell boots to the unlock screen and
  `/api/health` reports `locked: true`; wrong key → 401, right key → desktop +
  `vault:unlocked`.
- Close button hides to tray and the sidecar keeps running; tray Quit exits
  the process.
