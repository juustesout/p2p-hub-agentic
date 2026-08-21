import { useEffect, useRef } from "react";
import { CORE_ORIGIN, pluginBridge } from "../services/plugin-bridge";
import type { CapabilityPlugin } from "../types";

/**
 * Renders a plugin's bundled UI in a sandboxed iframe loaded from the
 * core-server origin (never the shell's own origin, so the plugin UI can never
 * reach the shell DOM).
 *
 * Sandbox flags: `allow-scripts` to run the plugin's UI, and
 * `allow-same-origin` so the document keeps a real (core-server) origin — the
 * `/ui` responses carry `script-src 'self'`, which cannot match an opaque
 * origin. `allow-top-navigation`, `allow-forms` and `allow-popups` are NOT
 * granted. Because the frame is cross-origin with the shell, `allow-same-origin`
 * does not expose the parent: the plugin UI shares an origin only with the
 * core-server, whose `/api/*` all require the per-boot token (never present in
 * the iframe URL) and whose `/ui` responses set `connect-src 'none'`.
 */
export function PluginWindow({ plugin }: { plugin: CapabilityPlugin }) {
  const ref = useRef<HTMLIFrameElement>(null);

  // Bind this exact iframe window as the authorized bridge source for the
  // plugin's id. The bridge then accepts postMessage calls only from windows
  // the shell itself bound — see plugin-bridge.ts.
  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    const onLoad = () => {
      const win = iframe.contentWindow;
      if (win) pluginBridge.bindSource(plugin.id, win);
    };
    iframe.addEventListener("load", onLoad);
    return () => iframe.removeEventListener("load", onLoad);
  }, [plugin.id]);

  return (
    <iframe
      ref={ref}
      src={`${CORE_ORIGIN}/ui/${plugin.id}/`}
      title={plugin.name}
      sandbox="allow-scripts allow-same-origin"
      className="h-full w-full border-0 bg-white"
    />
  );
}
