import type { PluginContext } from "@p2p-hub/core";

/**
 * Trust & Governance UI (Stap 6).
 *
 * The *UI* is the plugin: a sandboxed iframe (see `src/ui/`) that renders the
 * per-peer permission matrix and the trust-state topology. The *admin bridge*
 * skills it calls (`governance-ui.listPermissions`, `governance-ui.registerSkills`)
 * are registered by core-server, not by this plugin — they wrap the
 * `GovernanceService`, which a plugin must never reach directly (the matrix is
 * platform-owned, tier-2 confirmed, and validated against the live
 * manifest-exposed catalog). The manifest still declares them in `ui.skills`
 * with matching `network:http:*` permissions so the shell builds the bridge
 * allowlist from the structured contract.
 *
 * This entry module therefore registers nothing on the broker. It activates so
 * the UI is loadable and exposes an informational API (`describe`), so the
 * plugin has an honest shape instead of an empty shell.
 */
export interface GovernanceUiPluginApi {
  describe(): {
    id: "governance-ui";
    adminSkills: ["governance-ui.listPermissions", "governance-ui.registerSkills"];
  };
}

export default function activate(_ctx: PluginContext): GovernanceUiPluginApi {
  return {
    describe: () => ({
      id: "governance-ui",
      adminSkills: [
        "governance-ui.listPermissions",
        "governance-ui.registerSkills",
      ],
    }),
  };
}
