/**
 * Client-side GPU probe contract between the desktop shell and the
 * diagnostics snapshot/bundle API.
 *
 * The core-server runs headless and cannot see the GPU through a window
 * manager, so snapshot hardware fields like `webglRenderer` are fill-in hooks
 * (null by default). The desktop shell *does* run in a webview, so it can
 * probe WebGL (`WEBGL_debug_renderer_info`) and feed the readouts back. This
 * file is the single shared shape + sanitizer for that payload — the shell
 * builds it, the server validates it. Privacy-first invariant: these fields
 * describe the *local* GPU only, never an identity or a secret.
 *
 * The payload is strictly optional: a probe that fails (no WebGL, headless
 * CI, blocked context) yields `null` fields and the snapshot keeps its
 * server-side defaults. All fields are bounded so a hostile or corrupted
 * payload can never inflate a snapshot or overflow a log line.
 */

/** Maximum byte length accepted for a GPU renderer/vendor string. */
export const GPU_STRING_MAX_LENGTH = 300;

/** Sanity bounds for a window device-pixel-ratio value. */
export const GPU_WINDOW_SCALE_MIN = 0.1;
export const GPU_WINDOW_SCALE_MAX = 10;

/** Cap the number of keys the sanitizer will copy from a hostile payload. */
const GPU_MAX_INPUT_KEYS = 16;

/** WebGL vendor/renderer readout as reported by the desktop-shell webview. */
export interface ClientGpuProbe {
  /** `UNMASKED_VENDOR_WEBGL` (e.g. "Google Inc. (NVIDIA)"). Null when absent. */
  vendor: string | null;
  /** `UNMASKED_RENDERER_WEBGL` (e.g. "ANGLE (NVIDIA, NVIDIA GeForce ...)"). */
  renderer: string | null;
  /** False when the browser reports software rendering / acceleration off. */
  hardwareAcceleration: boolean | null;
  /** `window.devicePixelRatio` — null when unavailable or not a number. */
  windowScaleFactor: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > GPU_STRING_MAX_LENGTH) {
    return null;
  }
  // Strip control characters that could corrupt a log line / terminal view.
  return trimmed.replace(/[\u0000-\u001f\u007f]/g, " ");
}

function cleanBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function cleanScale(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value < GPU_WINDOW_SCALE_MIN || value > GPU_WINDOW_SCALE_MAX) {
    return null;
  }
  return value;
}

/**
 * Validate + normalize an unknown payload into a well-formed `ClientGpuProbe`.
 * Unknown keys are dropped, malformed fields fall back to null, never throw.
 * Returns null only for a non-object payload (a caller bug, not hostile data).
 */
export function sanitizeClientGpu(input: unknown): ClientGpuProbe | null {
  if (!isRecord(input)) {
    return null;
  }
  const probe: ClientGpuProbe = {
    vendor: null,
    renderer: null,
    hardwareAcceleration: null,
    windowScaleFactor: null,
  };
  let seen = 0;
  for (const key of Object.keys(input)) {
    if (seen >= GPU_MAX_INPUT_KEYS) {
      break;
    }
    seen += 1;
    const value = input[key];
    switch (key) {
      case "vendor":
        probe.vendor = cleanString(value);
        break;
      case "renderer":
        probe.renderer = cleanString(value);
        break;
      case "hardwareAcceleration":
        probe.hardwareAcceleration = cleanBoolean(value);
        break;
      case "windowScaleFactor":
        probe.windowScaleFactor = cleanScale(value);
        break;
      default:
        break;
    }
  }
  return probe;
}
