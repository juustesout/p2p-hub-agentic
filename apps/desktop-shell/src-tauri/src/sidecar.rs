//! Sidecar lifecycle for the p2p-hub core-server.
//!
//! The desktop shell is a thin native wrapper: all logic lives in the
//! core-server (reached over HTTP/WebSocket). The shell spawns that server as a
//! child process ("sidecar") with `P2P_HUB_PORT=0` (OS-assigned port) and
//! `P2P_HUB_SIDECAR_READY=1`, then reads a single machine-readable line on the
//! child's stdout:
//!
//!   `[P2P_HUB_READY] {"port":<bound>,"token":"<boot-token>","state":"ready"}`
//!
//! `state` is the vault lock gate (Slice 2): `"ready"` for a full boot, or
//! `"locked"` when a pre-existing vault is awaiting its master key (the bridge
//! is up, but plugins/identity/P2P transports are deferred). The line
//! format/prefix is defined once on the Node side
//! (`apps/core-server/src/sidecar.ts`) and mirrored here; the delimiter is
//! anchored on the prefix + a space so a `[P2P_HUB_READYING]`-class mismatch can
//! never be misread as the handshake (CLAUDE.md principle #2). Fail-closed both
//! ways: a malformed line is logged and ignored, never accepted as "ready".

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// Must match `SIDECAR_READY_PREFIX` in `apps/core-server/src/sidecar.ts`.
/// Deliberately includes the trailing space: the anchor is `[P2P_HUB_READY] `,
/// not the bare prefix.
pub const SIDECAR_READY_PREFIX: &str = "[P2P_HUB_READY] ";

/// Upper bound on how long to wait for the ready line before declaring the
/// sidecar failed to boot and killing it.
pub const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// What the core-server reports over the stdout handshake.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SidecarConfig {
    pub port: u16,
    pub token: String,
    /// `"locked"` (vault awaiting its master key) or `"ready"` (full boot).
    pub state: String,
}

/// Parse a single stdout line from the core-server. Returns `None` (never an
/// error, never a panic) unless the line is exactly the delimiter-anchored
/// handshake with a valid port, a non-empty token and a known `state`. Log
/// output that merely *starts* with the prefix is rejected — the trailing-space
/// anchor is what makes `[P2P_HUB_READYING]` and `[P2P_HUB_READY]{...}`
/// distinguishable from `[P2P_HUB_READY] {...}`.
pub fn parse_ready_line(line: &str) -> Option<SidecarConfig> {
    let trimmed = line.trim();
    let payload = trimmed.strip_prefix(SIDECAR_READY_PREFIX)?;
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let port = value.get("port")?.as_u64()?;
    if port == 0 || port > u64::from(u16::MAX) {
        return None;
    }
    let token = value.get("token")?.as_str()?;
    if token.is_empty() {
        return None;
    }
    let state = value.get("state")?.as_str()?;
    if state != "locked" && state != "ready" {
        return None;
    }
    Some(SidecarConfig {
        port: port as u16,
        token: token.to_string(),
        state: state.to_string(),
    })
}

/// A spawned core-server plus a drainer thread that forwards its stdout log
/// lines to stderr (so a chatty server can never block on a full pipe).
/// Dropping the handle kills the child and joins the drainer.
pub struct SidecarHandle {
    child: Child,
    config: SidecarConfig,
    drainer: Option<std::thread::JoinHandle<()>>,
}

impl SidecarHandle {
    /// The config reported over the ready handshake.
    pub fn config(&self) -> &SidecarConfig {
        &self.config
    }

    /// Kill the child if it is still running and wait for it to exit.
    pub fn stop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

impl Drop for SidecarHandle {
    fn drop(&mut self) {
        self.stop();
        if let Some(drainer) = self.drainer.take() {
            let _ = drainer.join();
        }
    }
}

/// The name of the SEA sidecar binary produced by `npm run build:sea`.
///
/// It is what Tauri's `bundle.externalBin` bundles next to the app executable
/// in a release bundle, and also the name the dev build drops into
/// `src-tauri/bin/` (triple-suffixed). Deliberately not the shell's own name:
/// the binary IS the core-server, not a second copy of the shell.
const SEA_BIN_NAME: &str = "p2p-hub-core";

/// Resolve the program + arguments that start the core-server.
///
/// Resolution order:
///   1. `P2P_HUB_CORE_BIN` env var — an explicit override. This is the escape
///      hatch for anything the built-in search misses (a manually placed
///      binary, a remote/debug build, a script, …).
///   2. In **release** builds: the Single Executable Application binary
///      (`p2p-hub-core`) produced by `npm run build:sea` and bundled by Tauri
///      (`bundle.externalBin`). A shipped desktop app has no Node — the SEA
///      binary is the only thing that can run there. The node-script dev
///      layouts below remain a fallback so a release binary still boots on a
///      machine that has the monorepo checked out.
///   3. In **debug** builds: the dev layouts (`node <repo>/core-server/dist/
///      index.js`), which are always current after `npm run build`. The SEA
///      binary is accepted as a fallback so `cargo tauri dev` after a
///      `build:sea` works the same way.
pub fn resolve_core_command() -> Result<(String, Vec<String>), String> {
    if let Ok(bin) = std::env::var("P2P_HUB_CORE_BIN") {
        if !bin.is_empty() {
            return Ok((bin, Vec::new()));
        }
    }

    let mut sea: Vec<PathBuf> = Vec::new();
    let mut scripts: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            sea.extend(find_sea_binary_in(exe_dir));
            // Bundled resources layout (Tauri `resources`, macOS Contents/Resources).
            sea.extend(find_sea_binary_in(&exe_dir.join("../resources")));
            // Dev build output: <shell>/src-tauri/bin/<p2p-hub-core-<triple>>.
            sea.extend(find_sea_binary_in(&exe_dir.join("../../bin")));

            // <shell>/src-tauri/target/debug/p2p-hub-shell -> <repo>/core-server/dist/index.js
            scripts.push(exe_dir.join("../../../../core-server/dist/index.js"));
            // cargo test binary: target/debug/deps/... -> one level deeper
            scripts.push(exe_dir.join("../../../../../../core-server/dist/index.js"));
            // bundled layout: <app-dir>/core-server/dist/index.js
            scripts.push(exe_dir.join("../core-server/dist/index.js"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        // `npm run dev` from apps/desktop-shell
        scripts.push(cwd.join("../core-server/dist/index.js"));
        // from the repo root
        scripts.push(cwd.join("core-server/dist/index.js"));
    }

    let mut attempts: Vec<String> = Vec::new();

    match pick_entrypoint(&sea, &scripts, cfg!(debug_assertions)) {
        Some(command) => Ok(command),
        None => {
            attempts.extend(
                sea.iter()
                    .map(|p| format!("SEA candidate (not present): {}", p.display()))
                    .chain(
                        scripts.iter().map(|p| {
                            format!("node script candidate (not present): {}", p.display())
                        }),
                    ),
            );
            Err(format!(
                "no core-server entrypoint found (set P2P_HUB_CORE_BIN); tried: {}",
                attempts.join("; ")
            ))
        }
    }
}

/// Given the discovered SEA binaries and node-script layouts, pick the command
/// that boots the core-server.
///
/// `release` mirrors `cfg!(debug_assertions)` at the call site:
/// * **release** — the SEA binary wins (a shipped app has no Node); the node
///   script remains a fallback so a release binary still boots on a dev
///   machine with the monorepo checked out.
/// * **debug** — the node script wins (always current after `npm run build`);
///   the SEA binary is the fallback so `cargo tauri dev` against a built
///   binary behaves like release.
fn pick_entrypoint(
    sea: &[PathBuf],
    scripts: &[PathBuf],
    release: bool,
) -> Option<(String, Vec<String>)> {
    let sea_cmd = || {
        sea.iter()
            .find(|bin| bin.exists())
            .map(|bin| (bin.display().to_string(), Vec::new()))
    };
    let script_cmd = || {
        scripts
            .iter()
            .find(|p| p.exists())
            .map(|script| ("node".to_string(), vec![script.display().to_string()]))
    };
    if release {
        sea_cmd().or_else(script_cmd)
    } else {
        script_cmd().or_else(sea_cmd)
    }
}

/// Look for a runnable `p2p-hub-core` binary inside `dir`.
///
/// Prefers the bare Tauri-bundled name (`p2p-hub-core[.exe]`), then any
/// `p2p-hub-core*` file in the directory (the SEA build writes the
/// triple-suffixed `p2p-hub-core-<target-triple>` name into `src-tauri/bin/`;
/// scanning for the prefix avoids baking every target-triple into Rust).
fn find_sea_binary_in(dir: &Path) -> Vec<PathBuf> {
    let exe_ext = if cfg!(windows) { ".exe" } else { "" };
    let bare = dir.join(format!("{SEA_BIN_NAME}{exe_ext}"));
    if bare.exists() {
        return vec![bare];
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(SEA_BIN_NAME))
        })
        .collect();
    found.sort();
    found
}

/// Environment for the sidecar child: inherit the parent's `P2P_HUB_*`
/// settings (plugins dir, vault key, networking flags, …) so the server behaves
/// exactly as in the old `npm run dev` flow, then force the sidecar-relevant
/// ones: bind loopback only, OS-assigned port, ready-handshake enabled.
fn sidecar_env(data_dir: Option<&PathBuf>) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars()
        .filter(|(k, _)| k.starts_with("P2P_HUB_"))
        .collect();
    if let Some(dir) = data_dir {
        env.insert("P2P_HUB_DATA_DIR".to_string(), dir.display().to_string());
    }
    env.insert("P2P_HUB_HOST".to_string(), "127.0.0.1".to_string());
    env.insert("P2P_HUB_PORT".to_string(), "0".to_string());
    env.insert("P2P_HUB_SIDECAR_READY".to_string(), "1".to_string());
    env
}

/// Default data directory, matching the Node side's `$HOME/.p2p-hub`.
pub fn default_data_dir() -> PathBuf {
    match std::env::var("P2P_HUB_DATA_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => std::env::var("HOME")
            .map(|home| PathBuf::from(home).join(".p2p-hub"))
            .unwrap_or_else(|_| PathBuf::from(".p2p-hub")),
    }
}

/// Spawn the core-server as a sidecar and block (bounded by [`READY_TIMEOUT`])
/// until its `[P2P_HUB_READY]` handshake line arrives or it fails to boot.
pub fn spawn_core_sidecar(data_dir: Option<PathBuf>) -> Result<SidecarHandle, String> {
    let (program, args) = resolve_core_command()?;

    let mut command = Command::new(&program);
    command
        .args(&args)
        .envs(sidecar_env(data_dir.as_ref()))
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn core sidecar ({program}): {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "core sidecar stdout was not piped".to_string())?;

    let (tx, rx) = mpsc::channel::<String>();
    let drainer = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.starts_with(SIDECAR_READY_PREFIX) {
                // Only handshake candidates reach the main thread; everything
                // else is log output drained straight to stderr.
                if tx.send(line).is_err() {
                    break;
                }
            } else {
                eprintln!("[core-server] {line}");
            }
        }
    });

    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let mut handle = SidecarHandle {
                child,
                config: SidecarConfig {
                    port: 0,
                    token: String::new(),
                    state: "locked".to_string(),
                },
                drainer: Some(drainer),
            };
            handle.stop();
            return Err("timed out waiting for the core sidecar ready handshake".to_string());
        }

        match rx.recv_timeout(remaining) {
            Ok(line) => match parse_ready_line(&line) {
                Some(config) => {
                    return Ok(SidecarHandle {
                        child,
                        config,
                        drainer: Some(drainer),
                    });
                }
                None => {
                    // Looks like the handshake but does not parse: log and keep
                    // waiting — never accept a half handshake as ready.
                    eprintln!("[core-server] ignoring malformed ready line: {line}");
                }
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let mut handle = SidecarHandle {
                    child,
                    config: SidecarConfig {
                        port: 0,
                        token: String::new(),
                        state: "locked".to_string(),
                    },
                    drainer: Some(drainer),
                };
                handle.stop();
                return Err("timed out waiting for the core sidecar ready handshake".to_string());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("core sidecar exited before signalling readiness".to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_the_exact_handshake_line() {
        let line = "[P2P_HUB_READY] {\"port\":44619,\"token\":\"abc123\",\"state\":\"ready\"}";
        assert_eq!(
            parse_ready_line(line),
            Some(SidecarConfig {
                port: 44619,
                token: "abc123".to_string(),
                state: "ready".to_string(),
            })
        );
    }

    #[test]
    fn parse_distinguishes_locked_from_ready() {
        let locked = parse_ready_line(
            "[P2P_HUB_READY] {\"port\":44619,\"token\":\"abc123\",\"state\":\"locked\"}",
        );
        assert_eq!(
            locked,
            Some(SidecarConfig {
                port: 44619,
                token: "abc123".to_string(),
                state: "locked".to_string(),
            })
        );
    }

    #[test]
    fn parse_is_delimiter_anchored_on_prefix_plus_space() {
        // A bare prefix match must not leak: `[P2P_HUB_READYING]` and
        // `[P2P_HUB_READY]{` are NOT the handshake (CLAUDE.md principle #2).
        assert_eq!(
            parse_ready_line("[P2P_HUB_READYING] {\"port\":1,\"token\":\"x\"}"),
            None
        );
        assert_eq!(
            parse_ready_line("[P2P_HUB_READY]{\"port\":1,\"token\":\"x\"}"),
            None
        );
    }

    #[test]
    fn parse_rejects_malformed_handshakes_fail_closed() {
        assert_eq!(parse_ready_line(""), None);
        assert_eq!(parse_ready_line("[P2P_HUB_READY] not json"), None);
        assert_eq!(parse_ready_line("[P2P_HUB_READY] []"), None);
        assert_eq!(parse_ready_line("[P2P_HUB_READY] {\"port\":0,\"token\":\"x\"}"), None);
        assert_eq!(parse_ready_line("[P2P_HUB_READY] {\"port\":65536,\"token\":\"x\"}"), None);
        assert_eq!(parse_ready_line("[P2P_HUB_READY] {\"port\":44619}"), None);
        assert_eq!(parse_ready_line("[P2P_HUB_READY] {\"port\":44619,\"token\":\"\"}"), None);
        assert_eq!(
            parse_ready_line("[P2P_HUB_READY] {\"port\":\"44619\",\"token\":\"x\"}"),
            None
        );
    }

    #[test]
    fn parse_rejects_an_unknown_or_missing_boot_state() {
        // `state` is the vault lock gate; an unrecognised value is never
        // half-accepted as if the host knew what it meant (CLAUDE.md #2/#7).
        assert_eq!(
            parse_ready_line("[P2P_HUB_READY] {\"port\":1,\"token\":\"x\"}"),
            None
        );
        assert_eq!(
            parse_ready_line("[P2P_HUB_READY] {\"port\":1,\"token\":\"x\",\"state\":\"unlocking\"}"),
            None
        );
        assert_eq!(
            parse_ready_line("[P2P_HUB_READY] {\"port\":1,\"token\":\"x\",\"state\":true}"),
            None
        );
    }

    #[test]
    fn parse_tolerates_whitespace_around_the_line() {
        // read_line keeps the trailing `\n`; JSON whitespace after the delimiter
        // is fine — the port/token checks are the fail-closed part.
        assert_eq!(
            parse_ready_line("[P2P_HUB_READY]   {\"port\":1,\"token\":\"x\",\"state\":\"ready\"}\n"),
            Some(SidecarConfig {
                port: 1,
                token: "x".to_string(),
                state: "ready".to_string(),
            })
        );
    }

    #[test]
    fn stop_kills_a_live_child_process() {
        // Quit-from-tray is `SidecarHandle::stop()` + app exit; close-to-tray
        // never touches the handle. This proves stop() actually reaps a live
        // child (the core-server), not just a bookkeeping flag.
        let child = Command::new("sleep").arg("30").spawn().expect("spawn sleep");
        let mut handle = SidecarHandle {
            child,
            config: SidecarConfig {
                port: 0,
                token: String::new(),
                state: "locked".to_string(),
            },
            drainer: None,
        };
        handle.stop();
        assert!(
            handle.child.try_wait().ok().flatten().is_some(),
            "stop() must kill and reap the child process"
        );
    }

    #[test]
    fn sidecar_env_forces_loopback_port_zero_and_handshake() {
        let env = sidecar_env(None);
        assert_eq!(env.get("P2P_HUB_HOST").map(String::as_str), Some("127.0.0.1"));
        assert_eq!(env.get("P2P_HUB_PORT").map(String::as_str), Some("0"));
        assert_eq!(env.get("P2P_HUB_SIDECAR_READY").map(String::as_str), Some("1"));
        assert!(!env.contains_key("P2P_HUB_SIDECAR_READY") || env["P2P_HUB_SIDECAR_READY"] == "1");
    }

    // ------------------------------------------------------------------
    // SEA binary resolution
    // ------------------------------------------------------------------

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "p2p-hub-sidecar-test-{}-{name}",
            std::process::id()
        ))
    }

    #[test]
    fn sea_binary_search_prefers_the_bare_tauri_name_over_the_triple_name() {
        let dir = temp_dir("prefers-bare");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let bare = dir.join("p2p-hub-core");
        let triple = dir.join("p2p-hub-core-x86_64-unknown-linux-gnu");
        std::fs::write(&bare, "").expect("write bare");
        std::fs::write(&triple, "").expect("write triple");

        let found = find_sea_binary_in(&dir);
        assert_eq!(
            found.first().map(|p| p.file_name().unwrap().to_str().unwrap()),
            Some("p2p-hub-core"),
            "the Tauri-bundled bare name must win over the triple-suffixed dev copy"
        );
    }

    #[test]
    fn sea_binary_search_falls_back_to_the_triple_suffixed_dev_copy() {
        let dir = temp_dir("triple-fallback");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let triple = dir.join("p2p-hub-core-aarch64-apple-darwin");
        std::fs::write(&triple, "").expect("write triple");

        let found = find_sea_binary_in(&dir);
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].file_name().unwrap().to_str().unwrap(),
            "p2p-hub-core-aarch64-apple-darwin"
        );
    }

    #[test]
    fn sea_binary_search_ignores_unrelated_files() {
        let dir = temp_dir("ignores-unrelated");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        // A sibling binary that happens to live in the same dir must NOT be
        // picked up — only the p2p-hub-core family is a valid core-server.
        std::fs::write(dir.join("other-tool"), "").expect("write other");
        std::fs::write(dir.join("p2p-hub-core"), "").expect("write core");

        let found = find_sea_binary_in(&dir);
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].file_name().unwrap().to_str().unwrap(),
            "p2p-hub-core"
        );
    }

    #[test]
    fn sea_binary_search_is_empty_for_a_dir_without_a_binary() {
        let dir = temp_dir("no-binary");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        assert!(find_sea_binary_in(&dir).is_empty());
        // A missing dir is the same as an empty one — never an error.
        assert!(find_sea_binary_in(&dir.join("does-not-exist")).is_empty());
    }

    // ------------------------------------------------------------------
    // entrypoint selection (release vs debug profile)
    // ------------------------------------------------------------------

    fn named(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "").expect("write fixture");
        p
    }

    #[test]
    fn release_prefers_the_sea_binary_over_a_present_node_script() {
        let dir = temp_dir("release-prefers-sea");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let sea = vec![named(&dir, "p2p-hub-core")];
        let scripts = vec![named(&dir, "index.js")];

        let (program, args) = pick_entrypoint(&sea, &scripts, true).unwrap();
        assert_eq!(program, sea[0].display().to_string());
        assert!(args.is_empty(), "a SEA binary takes no arguments");
    }

    #[test]
    fn release_falls_back_to_the_node_script_when_no_sea_binary_exists() {
        let dir = temp_dir("release-fallback-script");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let script = named(&dir, "index.js");

        let (program, args) = pick_entrypoint(&[], &vec![script.clone()], true).unwrap();
        assert_eq!(program, "node");
        assert_eq!(args, vec![script.display().to_string()]);
    }

    #[test]
    fn debug_prefers_the_node_script_over_a_present_sea_binary() {
        let dir = temp_dir("debug-prefers-script");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let sea = vec![named(&dir, "p2p-hub-core")];
        let scripts = vec![named(&dir, "index.js")];

        let (program, args) = pick_entrypoint(&sea, &scripts, false).unwrap();
        assert_eq!(program, "node");
        assert_eq!(args, vec![scripts[0].display().to_string()]);
    }

    #[test]
    fn debug_falls_back_to_the_sea_binary_when_no_node_script_exists() {
        let dir = temp_dir("debug-fallback-sea");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let sea = vec![named(&dir, "p2p-hub-core")];

        let (program, args) = pick_entrypoint(&sea, &[], false).unwrap();
        assert_eq!(program, sea[0].display().to_string());
        assert!(args.is_empty());
    }

    #[test]
    fn both_profiles_fail_closed_when_nothing_is_found() {
        let dir = temp_dir("nothing-found");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let missing = vec![dir.join("does-not-exist")];
        assert!(pick_entrypoint(&missing, &missing, true).is_none());
        assert!(pick_entrypoint(&missing, &missing, false).is_none());
    }

    #[test]
    fn a_missing_node_script_is_skipped_in_favor_of_the_next_candidate() {
        let dir = temp_dir("skip-missing-script");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let present = named(&dir, "present.js");
        let scripts = vec![dir.join("missing.js"), present.clone()];

        let (_program, args) = pick_entrypoint(&[], &scripts, false).unwrap();
        assert_eq!(args, vec![present.display().to_string()]);
    }
}
