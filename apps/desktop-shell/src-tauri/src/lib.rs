// The desktop shell is a thin native wrapper around the React frontend. All
// logic lives in @p2p-hub/core (reached over HTTP/WebSocket via the
// core-server), so adding plugins never requires a Rust recompile — the
// frontend and the core server discover everything through /api/capabilities.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use serde::Deserialize;
use serde::Serialize;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tauri::State;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

mod sidecar;
mod update_guard;

/// A native tier-2 confirmation request. Mirrors the `ConfirmationRequest`
/// discriminated union in `@p2p-hub/core`; the `kind` tag selects which dialog
/// to render and which fields are meaningful.
///
/// Every variant carries a mandatory `initiator` — `"operator"` or
/// `"agent:<label>"` — set by the platform, never by a caller-supplied field.
/// The dialog must surface an agent initiator by name ("Agent <label> wants
/// to ...") so an agent-initiated action can never be mistaken for an
/// operator-initiated one.
/// The device class a media-access request asks for. Mirrors the SDK's
/// `MediaKind` (`"camera" | "microphone"`); there is deliberately no `"both"`
/// value — a request for both device classes is two separate requests.
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum MediaKind {
    Camera,
    Microphone,
}

impl std::fmt::Display for MediaKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            MediaKind::Camera => "camera",
            MediaKind::Microphone => "microphone",
        })
    }
}

/// Requested stream parameters, every field optional. Mirrors the SDK's
/// `MediaStreamParams`; a bare kind is a valid request for the default.
#[derive(Deserialize)]
struct MediaStreamParams {
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default, rename = "frameRate")]
    frame_rate: Option<u32>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum ConfirmationRequest {
    CriticalSettings {
        summary: String,
        initiator: String,
    },
    PeerAccessRequest {
        #[serde(rename = "peerId")]
        peer_id: String,
        claim: String,
        #[serde(rename = "expiresInMs")]
        expires_in_ms: u64,
        initiator: String,
    },
    AgentTaskApproval {
        #[serde(rename = "taskId")]
        task_id: String,
        skill: String,
        #[serde(rename = "agentLabel")]
        agent_label: String,
        #[serde(rename = "peerId")]
        peer_id: String,
        initiator: String,
    },
    MediaAccessRequest {
        #[serde(rename = "peerId")]
        peer_id: String,
        #[serde(rename = "mediaKind")]
        media_kind: MediaKind,
        #[serde(default)]
        requested: Option<MediaStreamParams>,
        summary: String,
        #[serde(rename = "expiresInMs")]
        expires_in_ms: u64,
        initiator: String,
    },
}

/// Render "who wants this" from the platform-set `initiator` field. An
/// operator-initiated change is phrased impersonally; an agent-initiated one
/// names the agent so the operator can never mistake it for their own action.
fn initiator_wants(initiator: &str) -> String {
    match initiator.strip_prefix("agent:") {
        Some(label) => format!("Agent {label} wants to"),
        None => "You are about to".to_string(),
    }
}

/// Build the native dialog message + title for a confirmation request. Pure so
/// the agent/operator phrasing is unit-testable without a Tauri window.
fn prompt_for(request: &ConfirmationRequest) -> (String, String) {
    match request {
        ConfirmationRequest::CriticalSettings { summary, initiator } => (
            format!("{} apply: {summary}", initiator_wants(initiator)),
            "Apply high-risk security settings?".to_string(),
        ),
        ConfirmationRequest::PeerAccessRequest {
            peer_id,
            claim,
            expires_in_ms,
            initiator,
        } => {
            let seconds = expires_in_ms / 1000;
            (
                format!(
                    "{} grant peer {peer_id} access ({claim}).\n\nGrant access for {seconds} seconds?",
                    initiator_wants(initiator)
                ),
                "Allow peer access to your site?".to_string(),
            )
        }
        ConfirmationRequest::AgentTaskApproval {
            task_id,
            skill,
            agent_label,
            peer_id,
            initiator,
        } => {
            let who = match initiator.strip_prefix("agent:") {
                Some(label) => format!("Agent {label}"),
                None => format!("Agent {agent_label}"),
            };
            (
                format!(
                    "{who} wants to run the skill \"{skill}\" (task {task_id}) as peer {peer_id}.\n\nApprove this action?"
                ),
                "Approve agent action?".to_string(),
            )
        }
        ConfirmationRequest::MediaAccessRequest {
            peer_id,
            media_kind,
            requested,
            summary,
            expires_in_ms,
            initiator,
        } => {
            let device = media_kind.to_string();
            let settings = match requested {
                Some(MediaStreamParams { width: Some(w), height: Some(h), frame_rate, .. }) => {
                    match frame_rate {
                        Some(fps) => format!(" at {w}x{h}, {fps} fps"),
                        None => format!(" at {w}x{h}"),
                    }
                }
                _ => String::new(),
            };
            let seconds = expires_in_ms / 1000;
            (
                format!(
                    "{} grant peer {peer_id} access to the {device}{settings}.\n\n{summary}\n\nGrant access for {seconds} seconds?",
                    initiator_wants(initiator)
                ),
                "Allow media access?".to_string(),
            )
        }
    }
}

/// Resolved backend coordinates handed to the frontend by
/// `get_backend_config`: the core-server's actual bound port (OS-assigned,
/// because the sidecar runs with `P2P_HUB_PORT=0`) and the per-boot token that
/// guards `/api/*` and `/ws`. The token travels the same out-of-band channel
/// family as `get_boot_token` — it is never exposed over HTTP. `locked` is the
/// vault lock gate reported by the boot handshake (`state: "locked"`).
#[derive(Clone, Serialize)]
struct BackendConfig {
    port: u16,
    token: String,
    locked: bool,
}

/// Owns the live core-server sidecar child. `None` means the sidecar failed to
/// boot; dropping the state (on app exit) kills the child via
/// [`sidecar::SidecarHandle`]'s `Drop`.
struct SidecarState(Mutex<Option<sidecar::SidecarHandle>>);

/// Raised when the user chooses Quit from the tray. The close-to-tray hook
/// consults it: while `false`, a window close hides to tray instead of exiting;
/// once `true`, the window is allowed to close and the process exits after the
/// sidecar has been stopped.
struct QuitState(AtomicBool);

/// Return the core-server's bound port + boot token as reported by the
/// `[P2P_HUB_READY]` stdout handshake. This is the frontend's entry point for
/// the backend address; it replaces hard-coded `localhost:8787` assumptions.
#[tauri::command]
fn get_backend_config(state: State<SidecarState>) -> Result<BackendConfig, String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "sidecar state poisoned".to_string())?;
    match guard.as_ref().and_then(|h| {
        let config = h.config();
        Some(BackendConfig {
            port: config.port,
            token: config.token.clone(),
            locked: config.state == "locked",
        })
    }) {
        Some(config) => Ok(config),
        None => Err("core server is not ready".to_string()),
    }
}

/// Return the per-boot token the core-server writes to `<data-dir>/boot-token`.
/// The frontend sends it as an `Authorization` header on `/api/*` requests and
/// a `?token=` query on the `/ws` upgrade; the token is never exposed over the
/// HTTP API itself, only read here out-of-band by the local shell.
#[tauri::command]
fn get_boot_token() -> Result<String, String> {
    let data_dir = match std::env::var("P2P_HUB_DATA_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => sidecar::default_data_dir(),
    };
    fs::read_to_string(data_dir.join("boot-token"))
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("failed to read boot token: {e}"))
}

/// Native tier-2 confirmation for high-risk security changes.
///
/// A `critical` change (settings or an incoming peer-access request) may only be
/// applied after a fresh, explicit host-level prompt — the JavaScript layer has
/// no `window.confirm` fallback (the frontend wrapper fails closed if this
/// command is unavailable). The command is additionally scoped to the main
/// window: plugin panels are iframes inside the main window, not separate Tauri
/// webviews, and cannot reach this command in the first place, but the label is
/// re-checked defensively.
#[tauri::command]
fn request_tier2_confirmation(
    window: tauri::Window,
    request: ConfirmationRequest,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("tier-2 confirmation is only available from the main window".into());
    }

    let (message, title) = prompt_for(&request);

    let confirmed = window
        .dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show();

    Ok(confirmed)
}

// ---------------------------------------------------------------------
// Systray + OS notifications + window lifecycle (Slice 2)
// ---------------------------------------------------------------------

/// Tray menu item identifiers. Menu rebuilds (via `set_tray_state`) keep the
/// same ids so `tray_action_for` dispatch stays stable.
const TRAY_ID: &str = "p2p-hub-main";
const TRAY_STATUS_ID: &str = "tray-status";
const TRAY_OPEN_ID: &str = "tray-open";
const TRAY_LOCK_ID: &str = "tray-lock";
const TRAY_PAUSE_ID: &str = "tray-pause";
const TRAY_QUIT_ID: &str = "tray-quit";

/// Events emitted to the webview when the operator uses a tray quick action.
/// The webview owns the actual HTTP calls (`/api/vault/lock`, network pause)
/// so the JS tests can cover them; the tray only forwards the intent.
const EVT_LOCK_VAULT: &str = "p2p:lock-vault";
const EVT_TOGGLE_NETWORK: &str = "p2p:toggle-network";

/// The label of the Pause/Resume toggle — the only tray text that changes
/// based on state. Pure so it is unit-testable without a live tray.
fn pause_toggle_label(network_paused: bool) -> &'static str {
    if network_paused {
        "Resume Network"
    } else {
        "Pause Network"
    }
}

/// What a tray menu id asks the shell to do. Unknown ids (tray internals,
/// future items) map to `None` — never a surprising action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayAction {
    OpenDashboard,
    LockVault,
    ToggleNetwork,
    Quit,
}

fn tray_action_for(id: &str) -> Option<TrayAction> {
    match id {
        TRAY_OPEN_ID => Some(TrayAction::OpenDashboard),
        TRAY_LOCK_ID => Some(TrayAction::LockVault),
        TRAY_PAUSE_ID => Some(TrayAction::ToggleNetwork),
        TRAY_QUIT_ID => Some(TrayAction::Quit),
        _ => None,
    }
}

/// Window-close handling: hide to tray unless the user chose Quit. Pure so the
/// close-vs-quit decision is testable (the brief's "close ≠ quit" invariant).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseDecision {
    HideToTray,
    Quit,
}

fn decide_close(quitting: bool) -> CloseDecision {
    if quitting {
        CloseDecision::Quit
    } else {
        CloseDecision::HideToTray
    }
}

/// Show and focus the main window (notification click, Open Dashboard, and the
/// tray's focus-on-click). A window that was hidden to tray must come back to
/// the foreground, not just `show()` in the background.
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Stop the managed core sidecar (Quit path). `None` (boot failure) is a
/// no-op. Kept separate so the quit flow is testable against a real child.
fn stop_managed_sidecar(state: &SidecarState) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "sidecar state poisoned".to_string())?;
    if let Some(handle) = guard.as_mut() {
        handle.stop();
    }
    Ok(())
}

/// Quit from the tray: mark the close-to-tray hook as quitting, SIGTERM the
/// core sidecar, then exit the process.
fn quit_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(state) = app.try_state::<QuitState>() {
        state.0.store(true, Ordering::SeqCst);
    }
    if let Some(state) = app.try_state::<SidecarState>() {
        let _ = stop_managed_sidecar(&state);
    }
    app.exit(0);
}

/// Build the tray menu. The first item is a disabled status line (updated via
/// `set_tray_state`); the rest are the brief's quick actions.
fn build_tray_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    status: &str,
    network_paused: bool,
) -> tauri::Result<Menu<R>> {
    let status_item = MenuItem::with_id(app, TRAY_STATUS_ID, status, false, None::<&str>)?;
    let open = MenuItem::with_id(app, TRAY_OPEN_ID, "Open Dashboard", true, None::<&str>)?;
    let lock = MenuItem::with_id(app, TRAY_LOCK_ID, "Lock Vault", true, None::<&str>)?;
    let pause = MenuItem::with_id(
        app,
        TRAY_PAUSE_ID,
        pause_toggle_label(network_paused),
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit P2P Hub", true, None::<&str>)?;
    let items: &[&dyn IsMenuItem<R>] = &[
        &status_item,
        &PredefinedMenuItem::separator(app)?,
        &open,
        &lock,
        &pause,
        &PredefinedMenuItem::separator(app)?,
        &quit,
    ];
    Menu::with_items(app, items)
}

/// Replace the tray menu, preserving ids, with a fresh status + toggle label.
#[tauri::command]
fn set_tray_state(
    app: tauri::AppHandle,
    status: String,
    network_paused: bool,
) -> Result<(), String> {
    let menu = build_tray_menu(&app, &status, network_paused).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Show an OS notification. The webview is the sole caller and has already
/// sanitized the title/body (no message text, no secret values); this command
/// is deliberately dumb — it never reads vault state.
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())
}

/// Bring the main window to the foreground — the notification click handler.
#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Auto-update (Brief 4, supply-chain hardening). The plugin refuses
        // unsigned artifacts (Ed25519/minisign verification against the pubkey
        // baked into `plugins.updater.pubkey`) and non-HTTPS endpoints in
        // release builds. The `default_version_comparator` adds the downgrade /
        // re-install gate: only a strictly newer version is ever offered. The
        // gate runs inside `Updater::check`, so it cannot be bypassed by
        // calling the plugin's `plugin:updater|*` commands from the frontend.
        .plugin(
            tauri_plugin_updater::Builder::new()
                .default_version_comparator(update_guard::should_offer_update)
                .build(),
        )
        .on_window_event(|window, event| {
            // Close-to-tray (Slice 2): the window close button hides the shell
            // instead of exiting — the sidecar keeps running. Only a tray Quit
            // (which sets QuitState and stops the sidecar first) lets the
            // window actually close.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let quitting = window
                    .app_handle()
                    .try_state::<QuitState>()
                    .map(|s| s.0.load(Ordering::SeqCst))
                    .unwrap_or(false);
                if decide_close(quitting) == CloseDecision::HideToTray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // Boot the core-server sidecar before the window is shown so the
            // frontend's first `get_backend_config` call always finds a config.
            // A boot failure is loud (stderr) and leaves the state `None`; the
            // frontend then reports the backend as offline instead of crashing.
            let data_dir = sidecar::default_data_dir();
            let state = match sidecar::spawn_core_sidecar(Some(data_dir)) {
                Ok(handle) => SidecarState(Mutex::new(Some(handle))),
                Err(err) => {
                    eprintln!("[p2p-hub-shell] core sidecar failed to start: {err}");
                    SidecarState(Mutex::new(None))
                }
            };
            app.manage(state);
            app.manage(QuitState(AtomicBool::new(false)));

            // Systray: a disabled status line on top, then the quick actions.
            // The initial "connecting…" status is replaced by the webview the
            // moment it reads health (via `set_tray_state`).
            let menu = build_tray_menu(
                app.handle(),
                "P2P Hub — connecting…",
                false,
            )?;
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("P2P Hub")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match tray_action_for(event.id().as_ref()) {
                    Some(TrayAction::OpenDashboard) => show_main_window(app),
                    Some(TrayAction::LockVault) => {
                        let _ = app.emit_to("main", EVT_LOCK_VAULT, ());
                    }
                    Some(TrayAction::ToggleNetwork) => {
                        let _ = app.emit_to("main", EVT_TOGGLE_NETWORK, ());
                    }
                    Some(TrayAction::Quit) => quit_app(app),
                    None => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_boot_token,
            get_backend_config,
            request_tier2_confirmation,
            notify,
            focus_main_window,
            set_tray_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_critical_settings_from_the_wire_shape() {
        // Literal wire form as produced by `trust-confirm.ts`.
        let request: ConfirmationRequest = serde_json::from_str(
            r#"{"kind":"critical-settings","summary":"Rotate master key","initiator":"operator"}"#,
        )
        .expect("critical-settings wire form must parse");
        assert!(matches!(
            request,
            ConfirmationRequest::CriticalSettings { summary, initiator }
                if summary == "Rotate master key" && initiator == "operator"
        ));
    }

    #[test]
    fn deserializes_peer_access_request_with_exact_camel_case_fields() {
        // Literal wire form as produced by `trust-confirm.ts`: `peerId` and
        // `expiresInMs` are camelCase. The per-field `#[serde(rename = ...)]`
        // attributes on `peer_id` / `expires_in_ms` are what make this parse.
        let request: ConfirmationRequest = serde_json::from_str(
            r#"{"kind":"peer-access-request","peerId":"abc123","claim":"show my site","expiresInMs":60000,"initiator":"operator"}"#,
        )
        .expect("peer-access-request wire form must parse");
        assert!(matches!(
            request,
            ConfirmationRequest::PeerAccessRequest {
                peer_id,
                claim,
                expires_in_ms,
                initiator,
            } if peer_id == "abc123"
                && claim == "show my site"
                && expires_in_ms == 60_000
                && initiator == "operator"
        ));
    }

    #[test]
    fn deserializes_agent_task_approval_with_an_agent_initiator() {
        // Literal wire form as produced by an AgentRuntime confirm call.
        let request: ConfirmationRequest = serde_json::from_str(
            r#"{"kind":"agent-task-approval","taskId":"task-9","skill":"mail.send","agentLabel":"agent-alice","peerId":"abc123","initiator":"agent:agent-alice"}"#,
        )
        .expect("agent-task-approval wire form must parse");
        assert!(matches!(
            request,
            ConfirmationRequest::AgentTaskApproval {
                task_id,
                skill,
                agent_label,
                peer_id,
                initiator,
            } if task_id == "task-9"
                && skill == "mail.send"
                && agent_label == "agent-alice"
                && peer_id == "abc123"
                && initiator == "agent:agent-alice"
        ));
    }

    #[test]
    fn rejects_snake_case_fields_that_do_not_match_the_wire_shape() {
        // The wire contract sends camelCase `peerId` / `expiresInMs`. A
        // snake_case fixture must fail to deserialize — this is exactly what
        // the per-field serde renames enforce. If the `#[serde(rename = ...)]`
        // attributes were removed, this test would still fail (correctly), but
        // the camelCase test above would then fail instead, which is the real
        // regression signal.
        let snake_case_fields = serde_json::from_str::<ConfirmationRequest>(
            r#"{"kind":"peer-access-request","peer_id":"abc123","claim":"show my site","expires_in_ms":60000,"initiator":"operator"}"#,
        );
        assert!(
            snake_case_fields.is_err(),
            "snake_case field names must not match the wire contract"
        );

        let snake_case_kind = serde_json::from_str::<ConfirmationRequest>(
            r#"{"kind":"peer_access_request","peerId":"abc123","claim":"show my site","expiresInMs":60000,"initiator":"operator"}"#,
        );
        assert!(
            snake_case_kind.is_err(),
            "snake_case kind tag must not match the kebab-case wire contract"
        );
    }

    #[test]
    fn a_missing_initiator_fails_deserialization() {
        // `initiator` is a mandatory field — a confirm call that omits who
        // initiated the change must never be shown as operator-initiated.
        let missing = serde_json::from_str::<ConfirmationRequest>(
            r#"{"kind":"critical-settings","summary":"Rotate master key"}"#,
        );
        assert!(
            missing.is_err(),
            "a confirmation without an initiator must be rejected"
        );
    }

    #[test]
    fn deserializes_media_access_request_with_exact_camel_case_fields() {
        // Literal wire form as produced by `media-gate.ts` /
        // `confirmMediaRequest`: `peerId`, `mediaKind`, `expiresInMs` and the
        // nested `frameRate` are camelCase. Per-field renames make this parse.
        let request: ConfirmationRequest = serde_json::from_str(
            r#"{"kind":"media-access-request","peerId":"abc123","mediaKind":"camera","requested":{"width":1280,"height":720,"frameRate":60},"summary":"camera access","expiresInMs":60000,"initiator":"operator"}"#,
        )
        .expect("media-access-request wire form must parse");
        assert!(matches!(
            request,
            ConfirmationRequest::MediaAccessRequest {
                peer_id,
                media_kind,
                requested,
                summary,
                expires_in_ms,
                initiator,
            } if peer_id == "abc123"
                && matches!(media_kind, MediaKind::Camera)
                && matches!(requested, Some(MediaStreamParams { width: Some(1280), height: Some(720), frame_rate: Some(60) }))
                && summary == "camera access"
                && expires_in_ms == 60_000
                && initiator == "operator"
        ));
    }

    #[test]
    fn rejects_snake_case_media_fields_that_do_not_match_the_wire_shape() {
        // Same discipline as the peer-access fixture: snake_case field names
        // must not parse, and an unknown `mediaKind` value must not parse.
        let snake_case_fields = serde_json::from_str::<ConfirmationRequest>(
            r#"{"kind":"media-access-request","peer_id":"abc123","media_kind":"camera","summary":"camera access","expires_in_ms":60000,"initiator":"operator"}"#,
        );
        assert!(
            snake_case_fields.is_err(),
            "snake_case field names must not match the wire contract"
        );

        let unknown_kind = serde_json::from_str::<ConfirmationRequest>(
            r#"{"kind":"media-access-request","peerId":"abc123","mediaKind":"both","summary":"camera access","expiresInMs":60000,"initiator":"operator"}"#,
        );
        assert!(
            unknown_kind.is_err(),
            "an unknown mediaKind must not parse (no \"both\" on the wire)"
        );
    }

    #[test]
    fn media_access_prompt_names_the_device_and_duration() {
        let request = ConfirmationRequest::MediaAccessRequest {
            peer_id: "abc123".to_string(),
            media_kind: MediaKind::Camera,
            requested: Some(MediaStreamParams {
                width: Some(1280),
                height: Some(720),
                frame_rate: Some(60),
            }),
            summary: "camera access".to_string(),
            expires_in_ms: 60_000,
            initiator: "operator".to_string(),
        };
        let (message, title) = prompt_for(&request);
        assert!(message.contains("peer abc123 access to the camera at 1280x720, 60 fps"));
        assert!(message.contains("camera access"));
        assert!(message.contains("Grant access for 60 seconds?"));
        assert_eq!(title, "Allow media access?");
    }

    #[test]
    fn agent_initiated_prompts_name_the_agent() {
        let request = ConfirmationRequest::AgentTaskApproval {
            task_id: "task-9".to_string(),
            skill: "mail.send".to_string(),
            agent_label: "agent-alice".to_string(),
            peer_id: "abc123".to_string(),
            initiator: "agent:agent-alice".to_string(),
        };
        let (message, title) = prompt_for(&request);
        assert!(
            message.starts_with("Agent agent-alice wants to"),
            "the dialog must name the agent, got: {message}"
        );
        assert!(message.contains("mail.send"));
        assert_eq!(title, "Approve agent action?");

        let critical = ConfirmationRequest::CriticalSettings {
            summary: "Rotate master key".to_string(),
            initiator: "agent:agent-alice".to_string(),
        };
        let (message, _) = prompt_for(&critical);
        assert!(
            message.starts_with("Agent agent-alice wants to apply"),
            "agent-initiated settings must be shown as agent-initiated, got: {message}"
        );
    }

    #[test]
    fn operator_initiated_prompts_are_impersonal() {
        let critical = ConfirmationRequest::CriticalSettings {
            summary: "Rotate master key".to_string(),
            initiator: "operator".to_string(),
        };
        let (message, _) = prompt_for(&critical);
        assert!(
            !message.contains("Agent "),
            "an operator-initiated prompt must not claim an agent did it, got: {message}"
        );
    }

    #[test]
    fn tray_action_for_maps_every_quick_action_id() {
        assert_eq!(tray_action_for("tray-open"), Some(TrayAction::OpenDashboard));
        assert_eq!(tray_action_for("tray-lock"), Some(TrayAction::LockVault));
        assert_eq!(tray_action_for("tray-pause"), Some(TrayAction::ToggleNetwork));
        assert_eq!(tray_action_for("tray-quit"), Some(TrayAction::Quit));
        // Unknown ids (tray internals, future items) never map to an action.
        assert_eq!(tray_action_for("tray-status"), None);
        assert_eq!(tray_action_for(""), None);
    }

    #[test]
    fn pause_toggle_label_flips_with_network_state() {
        assert_eq!(pause_toggle_label(false), "Pause Network");
        assert_eq!(pause_toggle_label(true), "Resume Network");
    }

    #[test]
    fn decide_close_hides_to_tray_unless_quitting() {
        // The brief's core invariant: the window close button must hide the
        // shell (sidecar keeps running), only a tray Quit must exit.
        assert_eq!(decide_close(false), CloseDecision::HideToTray);
        assert_eq!(decide_close(true), CloseDecision::Quit);
    }

    #[test]
    fn stop_managed_sidecar_is_a_noop_when_none_and_errs_on_poisoned_state() {
        let empty = SidecarState(Mutex::new(None));
        assert_eq!(stop_managed_sidecar(&empty), Ok(()));

        let poisoned = SidecarState(Mutex::new(None));
        // Poison the mutex by panicking while *holding* the guard (dropping it
        // during unwind is what poisons the lock).
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = poisoned.0.lock().unwrap();
            panic!("poison");
        }));
        assert!(stop_managed_sidecar(&poisoned).is_err());
    }
}
