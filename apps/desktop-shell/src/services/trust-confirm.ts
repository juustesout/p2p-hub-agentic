/**
 * Native (Tauri host) tier-2 confirmation.
 *
 * A tier-2 change (aggregate `critical`) must be confirmed by an explicit,
 * out-of-band native prompt — never a JavaScript `window.confirm`. This helper
 * delegates to the `request_tier2_confirmation` Tauri command. When the command
 * is unavailable (plain-browser dev mode, or the host refuses to prompt), it
 * fails closed by returning `false`.
 */
export async function confirmTier2(summary: string): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("request_tier2_confirmation", { summary });
  } catch {
    return false;
  }
}
