import { isLoopbackHost } from "./host";
import { evaluateSettingsRisk } from "@p2p-hub/sdk";
import type { EffectiveSettings } from "@p2p-hub/sdk";

/**
 * Decide the LAN exposure posture for the static site, `/ui`, `/remote-site`
 * and `/peersite` surfaces. The site root itself is owned by the `peersite`
 * plugin (see `effectiveSiteRoot`); this only decides whether those surfaces
 * may be served beyond loopback.
 *
 * Loopback serving is always allowed. Serving beyond loopback is an explicit
 * opt-in: it requires both `peersiteEnabled` and `peersiteLanExposed` from
 * the persisted settings, and when enabled it logs a loud exposure + risk
 * warning (CLAUDE.md principle #8 — no silent widening).
 */
export async function decideSiteExposure(
  bindHost: string,
  load: () => Promise<EffectiveSettings>,
): Promise<boolean> {
  if (isLoopbackHost(bindHost)) {
    return true;
  }
  const settings = await load();
  if (!settings.peersiteEnabled || !settings.peersiteLanExposed) {
    console.warn(
      "[core-server] PeerSite: the bridge is not bound to loopback and " +
        "peersiteEnabled/peersiteLanExposed are not both enabled; static + " +
        "/peersite serving is refused (loopback-only).",
    );
    return false;
  }
  const risk = evaluateSettingsRisk(settings).aggregate;
  console.warn(
    `[core-server] PeerSite: EXPOSING the static site and /peersite API on ` +
      `non-loopback "${bindHost}". Anyone who can reach this port can read the ` +
      `published site and call the scoped peersite API. Active risk level: ` +
      `${risk}. Keep the site token secret and treat the network as untrusted.`,
  );
  return true;
}
