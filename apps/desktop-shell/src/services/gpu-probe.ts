import type { ClientGpuProbe } from "@p2p-hub/sdk";

/**
 * GPU probe for the desktop-shell webview (HelpCenter Pijler C / Brief 7C).
 *
 * The core-server is a headless Node process and cannot see the GPU, so the
 * snapshot's `webglRenderer`/`hardwareAcceleration`/`windowScaleFactor` hooks
 * stay null on the server-only GET path. The desktop shell *does* run inside a
 * webview, so it can ask WebGL who actually renders frames and feed the answer
 * back through the diagnostics API, where the shared SDK sanitizer bounds and
 * validates it.
 *
 * Privacy-first invariant: the probe describes the *local* GPU only — vendor,
 * renderer, one acceleration boolean and the device-pixel ratio. No identity,
 * no secrets, no network calls. All reads are read-only context queries; the
 * whole probe is best-effort and fails closed to an all-null payload (which
 * the server treats as absent).
 */

/**
 * Probe WebGL for the unmasked vendor/renderer + acceleration status.
 * Runs synchronously at most once; further calls return the cached result so
 * a health poll or a second HelpCenter open never re-creates a GL context.
 *
 * Fails closed:
 * - no canvas / no WebGL context → null fields (headless CI, blocked GPU);
 * - `WEBGL_debug_renderer_info` unavailable → null strings;
 * - an empty renderer string is not a result.
 */
export function probeWebglGpu(): ClientGpuProbe {
  if (probeCache !== null) {
    return probeCache;
  }
  probeCache = readWebglGpu();
  return probeCache;
}

let probeCache: ClientGpuProbe | null = null;

/** Test-only hook: forget the cached probe so the next call re-reads the DOM. */
export function __resetGpuProbeCache(): void {
  probeCache = null;
}

/**
 * Pure normalization used by {@link readWebglGpu}: turn the raw WebGL readouts
 * into a `ClientGpuProbe`. Kept pure (no DOM) so it is unit-testable in node.
 */
export function buildGpuProbe(input: {
  gl: WebGLRenderingContext | null;
  devicePixelRatio: number;
}): ClientGpuProbe {
  const { gl, devicePixelRatio } = input;
  const fallback: ClientGpuProbe = {
    vendor: null,
    renderer: null,
    hardwareAcceleration: null,
    windowScaleFactor: finiteRatio(devicePixelRatio),
  };
  if (!gl) {
    return fallback;
  }
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  if (!debugInfo) {
    return fallback;
  }
  const vendorRaw = String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? "");
  const rendererRaw = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? "");
  const renderer = rendererRaw.trim();
  const vendor = vendorRaw.trim();
  if (!renderer) {
    // A blank renderer string is not a usable result → keep everything null so
    // the server sees "absent", never a fabricated value.
    return {
      vendor: null,
      renderer: null,
      hardwareAcceleration: null,
      windowScaleFactor: fallback.windowScaleFactor,
    };
  }
  return {
    vendor: vendor || null,
    renderer,
    hardwareAcceleration: accelerationHint(renderer),
    windowScaleFactor: fallback.windowScaleFactor,
  };
}

/** A device-pixel ratio is only useful when it is a sane finite number. */
function finiteRatio(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

/**
 * Best-effort acceleration hint. Software renderers advertise themselves in
 * the renderer string ("llvmpipe", "SwiftShader", "Software", "Basic Render
 * Driver"). Never false without a software-renderer marker, so a headless/
 * blocked probe does not masquerade as "acceleration off". Only meaningful
 * when a renderer string is actually present.
 */
function accelerationHint(renderer: string): boolean {
  const lower = renderer.toLowerCase();
  if (
    lower.includes("llvmpipe") ||
    lower.includes("swiftshader") ||
    lower.includes("software") ||
    lower.includes("basic render driver") ||
    lower.includes("microsoft basic") ||
    lower.includes("mesa offscreen")
  ) {
    return false;
  }
  return true;
}

/**
 * Create a throwaway WebGL context and read the unmasked vendor/renderer.
 * Returns null on any failure (no `document`/`canvas`, context creation
 * blocked, `getContext` throws) — the caller fails closed.
 */
export function readWebglGpu(): ClientGpuProbe {
  if (typeof document === "undefined") {
    return allNullProbe();
  }
  try {
    const canvas = document.createElement("canvas");
    const attrs: WebGLContextAttributes = {
      // `failIfMajorPerformanceCaveat` unset: we want a readout even when the
      // only path is software rendering — that IS the diagnostic.
      antialias: false,
      depth: false,
      stencil: false,
    };
    const gl = (canvas.getContext("webgl", attrs) ??
      canvas.getContext("experimental-webgl", attrs)) as WebGLRenderingContext | null;
    return buildGpuProbe({ gl, devicePixelRatio: window.devicePixelRatio });
  } catch {
    return allNullProbe();
  }
}

function allNullProbe(): ClientGpuProbe {
  return {
    vendor: null,
    renderer: null,
    hardwareAcceleration: null,
    windowScaleFactor: null,
  };
}
