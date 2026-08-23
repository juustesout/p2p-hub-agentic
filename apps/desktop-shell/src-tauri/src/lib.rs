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
///
/// Every variant carries a mandatory `initiator` — `"operator"` or
/// `"agent:<label>"` — set by the platform, never by a caller-supplied field.
/// The dialog must surface an agent initiator by name ("Agent <label> wants
/// to ...") so an agent-initiated action can never be mistaken for an
/// operator-initiated one.
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

    let (message, title) = prompt_for(&request);

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
}
