import type { HelpNavRequest, HelpTabId } from "../types";

/**
 * HelpCenter navigation request bus (Brief 7C).
 *
 * The HelpCenter window is a normal ManagedWindow whose render closure is
 * created once when the window opens — so callers cannot push a new
 * tab/source selection through props after the fact. This tiny pub/sub lets
 * any surface (taskbar, sidebar, start menu, an error toast's "Toon details")
 * request a *targeted* view — e.g. "open Logs with the `network-light` source
 * selected" — and the mounted HelpCenterWindow reacts by switching tabs, even
 * if it was already open. If no window is mounted yet, the App registers an
 * opener via {@link registerHelpCenterOpener} and the window reads
 * {@link currentHelpRequest} on mount.
 *
 * Fail-closed default: an absent request resolves to the Diagnose tab, never
 * to a source-specific view with no source selected.
 */

export type { HelpNavRequest, HelpTabId };

const DEFAULT_REQUEST: HelpNavRequest = { tab: "diagnose" };

let current: HelpNavRequest = DEFAULT_REQUEST;
const listeners = new Set<(request: HelpNavRequest) => void>();
let opener: ((request: HelpNavRequest) => void) | null = null;

/** The most recent requested view (diagnose by default). */
export function currentHelpRequest(): HelpNavRequest {
  return current;
}

/** Subscribe to view requests. Returns an unsubscribe function. */
export function subscribeHelp(listener: (request: HelpNavRequest) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * App-side registration: what should happen when {@link openHelpCenter} is
 * called while no HelpCenter window is mounted. Pass `null` to unregister.
 */
export function registerHelpCenterOpener(fn: ((request: HelpNavRequest) => void) | null): void {
  opener = fn;
}

/**
 * Entry points call this to open/steer the HelpCenter. Stores the request for
 * a not-yet-mounted window and publishes it to every mounted window; if no
 * window exists and the App registered an opener, the opener creates one.
 */
export function openHelpCenter(request: HelpNavRequest = { tab: "diagnose" }): void {
  const normalized: HelpNavRequest = {
    tab: request.tab,
    ...(request.sourceId ? { sourceId: request.sourceId } : {}),
  };
  current = normalized;
  for (const listener of listeners) {
    listener(normalized);
  }
  opener?.(normalized);
}
