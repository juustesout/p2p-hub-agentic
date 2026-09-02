import type { DiagnosticBundle } from "../../types";

/**
 * Browser-side export actions for the HelpCenter bundle flow (Pijler B.2 /
 * Brief 7C). The bundle API returns the JSON + a `clipboardText` + a preview;
 * the *shell* owns the last two steps — copy to the OS clipboard and save as a
 * local file. There is no automatic upload: nothing leaves the machine until
 * the user acts on this output.
 *
 * Everything fails gracefully (returns `false`) instead of throwing: a denied
 * clipboard permission or a headless/CI environment must never take down the
 * window. The DOM accessors are parameterized so the node:test suites can
 * inject fakes without a browser.
 */

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/** A minimal `document` + `window` pair used to trigger a file download. */
export interface DownloadEnv {
  createElement: (tag: string) => {
    href: string;
    download: string;
    click: () => void;
  };
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

function browserClipboard(): ClipboardLike | null {
  const nav = (globalThis as { navigator?: { clipboard?: ClipboardLike } }).navigator;
  return nav?.clipboard ?? null;
}

/**
 * Copy text to the OS clipboard. Returns true on success, false when no
 * clipboard is available or the write is denied — never throws.
 */
export async function copyToClipboard(
  text: string,
  clipboard: ClipboardLike | null = null,
): Promise<boolean> {
  const target = clipboard ?? browserClipboard();
  if (!target) {
    return false;
  }
  try {
    await target.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Download a Blob-backed text file with a `<a download>` click. */
export function downloadTextFile(
  filename: string,
  text: string,
  env?: DownloadEnv,
): boolean {
  let blob: Blob;
  try {
    blob = new Blob([text], { type: "application/json;charset=utf-8" });
  } catch {
    return false;
  }
  const doc = env ?? browserEnv();
  if (!doc) {
    return false;
  }
  try {
    const url = doc.createObjectURL(blob);
    const anchor = doc.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    doc.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

function browserEnv(): DownloadEnv | null {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return null;
  }
  return {
    createElement: (tag) => {
      const el = document.createElement(tag);
      return {
        href: "",
        download: "",
        click: () => el.click(),
      };
    },
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  };
}

/**
 * A stable, filesystem-friendly bundle filename with a UTC timestamp, e.g.
 * `p2p-hub-bundel-20260902-153045.json`.
 */
export function bundleFilename(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    "-",
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join("");
  return `p2p-hub-bundel-${stamp}.json`;
}

/** The pretty JSON form of a bundle (what "download" saves). */
export function bundleJson(bundle: DiagnosticBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
