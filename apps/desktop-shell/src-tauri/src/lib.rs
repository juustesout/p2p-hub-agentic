// The desktop shell is a thin native wrapper around the React frontend. All
// logic lives in @p2p-hub/core (reached over HTTP/WebSocket via the
// core-server), so adding plugins never requires a Rust recompile — the
// frontend and the core server discover everything through /api/capabilities.

use std::fs;
use std::path::PathBuf;
use serde::Deserialize;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

/// A native tier-2 confirmation request. Mirrors the `ConfirmationRequest`
/// discriminated union in `@p2p-hub/core`; the `kind` tag selects which dialog
/// to render and which fields are meaningful.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum ConfirmationRequest {
    CriticalSettings {
        summary: String,
    },
    PeerAccessRequest {
        #[serde(rename = "peerId")]
        peer_id: String,
        claim: String,
        #[serde(rename = "expiresInMs")]
        expires_in_ms: u64,
    },
}

/// Return the per-boot token the core-server writes to `<data-dir>/boot-token`.
/// The frontend sends it as an `Authorization` header on `/api/*` requests and
/// a `?token=` query on the `/ws` upgrade; the token is never exposed over the
/// HTTP API itself, only read here out-of-band by the local shell.
#[tauri::command]
fn get_boot_token() -> Result<String, String> {
    let data_dir = match std::env::var("P2P_HUB_DATA_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => {
            let home =
                std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            PathBuf::from(home).join(".p2p-hub")
        }
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

    let (message, title) = match request {
        ConfirmationRequest::CriticalSettings { summary } => {
            (summary, "Apply high-risk security settings?".to_string())
        }
        ConfirmationRequest::PeerAccessRequest {
            peer_id,
            claim,
            expires_in_ms,
        } => {
            let seconds = expires_in_ms / 1000;
            (
                format!(
                    "Peer {peer_id} requests access ({claim}).\n\nGrant access for {seconds} seconds?"
                ),
                "Allow peer access to your site?".to_string(),
            )
        }
    };

    let confirmed = window
        .dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show();

    Ok(confirmed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_boot_token,
            request_tier2_confirmation
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
