import { CORE_ORIGIN } from "../services/plugin-bridge";

/**
 * Renders a remote peer's mirrored website (fetched over the P2P website
 * capability) in a sandboxed iframe pointed at the core-server's
 * `/remote-site/<peerId>/` origin.
 *
 * The security posture mirrors {@link PluginWindow} but is deliberately even
 * narrower:
 *
 * - The same `allow-scripts` + `allow-same-origin` sandbox, without
 *   `allow-top-navigation`, `allow-forms` or `allow-popups`. The frame shares
 *   an origin with the core-server but never carries the boot token, and the
 *   `/remote-site` responses set `connect-src 'none'` + `form-action 'none'`,
 *   so an attacker-controlled page cannot phone home or drive the bridge.
 * - Unlike plugin UI, this window is **never** passed to
 *   `pluginBridge.bindSource`, so its postMessage calls can never reach the
 *   shell bridge even though they share the core-server origin with plugin UI.
 */
export function SiteViewer({ peerId }: { peerId: string }) {
  return (
    <iframe
      src={`${CORE_ORIGIN}/remote-site/${peerId}/`}
      title="Remote site"
      sandbox="allow-scripts allow-same-origin"
      className="h-full w-full border-0 bg-white"
    />
  );
}
