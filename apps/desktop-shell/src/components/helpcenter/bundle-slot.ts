/**
 * Shared in-memory slot for the most recently generated diagnosis bundle
 * (Brief 7D). The Diagnose tab stores the redacted clipboard text here when a
 * bundle is built; the "Chat met ons" tab reads it for its "Plak bundel"
 * action, so the operator can send the support desk exactly the bundle that
 * was generated — without the two tabs needing to share React state. Deliberately
 * small and client-only: nothing is persisted, and it never holds secrets
 * (bundles are always redacted).
 */

let lastBundleText: string | null = null;

/** Remember the redacted clipboard text of a freshly built bundle. */
export function rememberLastBundle(text: string): void {
  lastBundleText = text;
}

/** The last generated bundle's clipboard text, or null when none exists. */
export function lastBundleClipboardText(): string | null {
  return lastBundleText;
}
