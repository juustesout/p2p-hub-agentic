# HERMES.md

Installation and run instructions for **Hermes**, the Nous Research desktop
agent. Read this before installing, building, or launching the Tauri shell on
the local Windows machine. It exists so you do not have to re-derive every
gotcha yourself.

## What this repo is

`p2p-hub-agentic` is a P2P-first, plugin-extensible desktop suite
(TypeScript, npm workspaces). Plugins are loaded by a `PluginHost` in
`@p2p-hub/core` and exposed through two processes:

- `apps/core-server` — HTTP + WebSocket bridge on `127.0.0.1:8787`.
- `apps/desktop-shell` — a Tauri 2 + React shell that is a **thin wrapper**:
  it has almost no logic of its own. Everything it shows comes from the
  core-server over `/api/*` (HTTP) and `/ws` (WebSocket).

Because the shell is a thin wrapper, **you must run the core-server alongside
it**. The native shell does not start the core-server for you.

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

Expect all workspaces green (historically 378 tests, 0 failures). One harmless
log line `[hooks] action handler for "demo:event" failed: Error: boom` is a
deliberate test artifact.

## Run — two processes

### 1. Start the core-server first

```sh
node apps/core-server/dist/index.js
```

- Listens on `127.0.0.1:8787` by default (`P2P_HUB_PORT` overrides).
- On boot it writes a per-boot token to `<data-dir>/boot-token`.
- Default data dir is `~/.p2p-hub` (`P2P_HUB_DATA_DIR` overrides).
- It auto-resolves the plugins dir from the monorepo (`plugins/`), so plugins
  are picked up from the compiled `dist/` of each plugin.

### 2. Then start the shell

Browser/dev mode (no native window, Vite on `:5173`):

```sh
cd apps/desktop-shell && npm run dev
```

This runs `build:core` + the core-server + Vite concurrently, and Vite proxies
`/api` and `/ws` to `127.0.0.1:8787`.

Native Tauri shell:

```sh
cd apps/desktop-shell/src-tauri && cargo tauri dev
```

`beforeDevCommand` runs `npm run ui` (Vite), and `devUrl` points at
`http://localhost:5173`. Start the core-server yourself first.

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
   token. The native shell reads it out-of-band via the `get_boot_token` Tauri
   command from `<data-dir>/boot-token`. In plain-browser dev mode (no Tauri),
   the frontend falls back to `VITE_P2P_HUB_TOKEN`. If `/api/capabilities`
   returns 401, the core-server was not started first or the data dirs differ
   (`P2P_HUB_DATA_DIR` must match in both processes).

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

## Quick sanity checklist before reporting "it works"

- `npm run build` exits clean.
- `npm run build && npm test` — 0 failures.
- Core-server logs that it is listening on `127.0.0.1:8787` and wrote the boot
  token.
- The shell window loads and `GET /api/capabilities` returns 200 (not 401).
- The native dialog appears for a critical settings change (no JS `confirm`
  fallback exists).
