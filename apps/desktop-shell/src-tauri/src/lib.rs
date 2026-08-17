// The desktop shell is a thin native wrapper around the React frontend. All
// logic lives in @p2p-hub/core (reached over HTTP/WebSocket via the
// core-server), so adding plugins never requires a Rust recompile — the
// frontend and the core server discover everything through /api/capabilities.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
