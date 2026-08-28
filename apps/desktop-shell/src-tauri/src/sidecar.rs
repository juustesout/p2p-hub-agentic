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
use std::path::PathBuf;
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

/// Resolve the program + arguments that start the core-server.
///
/// Resolution order:
///   1. `P2P_HUB_CORE_BIN` env var — an explicit override. This is also the
///      future Single-Executable-Application path (a node-wrapped binary set
///      here); packaging that SEA is a documented open follow-up, not built in
///      this slice.
///   2. Dev layouts: `node <repo>/core-server/dist/index.js`, discovered from
///      the shell executable's own directory (and the process cwd as a
///      fallback). This mirrors the pre-sidecar `npm run dev` flow.
pub fn resolve_core_command() -> Result<(String, Vec<String>), String> {
    if let Ok(bin) = std::env::var("P2P_HUB_CORE_BIN") {
        if !bin.is_empty() {
            return Ok((bin, Vec::new()));
        }
    }

    let mut scripts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
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

    for script in &scripts {
        if script.exists() {
            return Ok(("node".to_string(), vec![script.display().to_string()]));
        }
    }

    Err(format!(
        "no core-server entrypoint found (set P2P_HUB_CORE_BIN); tried: {}",
        scripts
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
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
}
