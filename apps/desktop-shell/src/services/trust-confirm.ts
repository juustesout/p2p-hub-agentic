/**
 * Native (Tauri host) tier-2 confirmation.
 *
 * A tier-2 change (aggregate `critical`) must be confirmed by an explicit,
 * out-of-band native prompt — never a JavaScript `window.confirm`. This helper
 * delegates to the `request_tier2_confirmation` Tauri command. When the command
 * is unavailable (plain-browser dev mode, or the host refuses to prompt), or
 * when it does not resolve within a bounded window (e.g. the native dialog
 * blocks the OS main loop), it fails closed by returning `false`.
 *
 * The request is a discriminated union so the host can render the right dialog
 * with the right fields. This mirrors `ConfirmationRequest` in
 * `@p2p-hub/core` (the shell only depends on the SDK, so the shape is declared
 * locally rather than imported).
 */

export type ConfirmationRequest =
  | { kind: "critical-settings"; summary: string }
  | {
      kind: "peer-access-request";
      peerId: string;
      claim: string;
      expiresInMs: number;
    };

const CONFIRM_TIMEOUT_MS = 60_000;

export async function confirmTier2(
  request: ConfirmationRequest,
): Promise<boolean> {
  let timer: number | undefined;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const confirmed = await Promise.race([
      invoke<boolean>("request_tier2_confirmation", { request }),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("tier-2 confirmation timed out")),
          CONFIRM_TIMEOUT_MS,
        );
      }),
    ]);
    return confirmed;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }
}
