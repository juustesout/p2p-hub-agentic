import * as fs from "node:fs/promises";
import { writeAtomicFile } from "./atomic";

/**
 * Callback used to surface a corruption event to the rest of the platform. The
 * host wires this to `HookRegistry.emit` so plugins can observe
 * `system:storageCorrupted`; standalone callers (tests) may leave it unset, in
 * which case only the `console.warn` is produced.
 */
export type StorageWarningHandler = (
  event: string,
  payload: unknown,
) => void | Promise<void>;

/**
 * Read `filePath` and parse it as JSON, degrading gracefully when the file is
 * missing or corrupted:
 *
 * 1. Missing file → return `fallback` (silent — this is the normal first-run).
 * 2. Parse/read failure → emit `system:storageCorrupted`, then try `${path}.bak`.
 *    - Backup valid → restore the primary from it and return the backup data.
 *    - Backup missing/invalid → quarantine the corrupt file to
 *      `${path}.corrupt.<ts>` and return `fallback`.
 *
 * It never throws on corruption, so a torn write can never crash boot.
 */
export async function safeReadJson<T>(
  filePath: string,
  fallback: T,
  onWarning?: StorageWarningHandler,
): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    return recoverFromCorruption(filePath, fallback, err as Error, onWarning);
  }
}

async function recoverFromCorruption<T>(
  filePath: string,
  fallback: T,
  error: Error,
  onWarning?: StorageWarningHandler,
): Promise<T> {
  const backupPath = `${filePath}.bak`;
  try {
    const raw = await fs.readFile(backupPath, "utf8");
    const parsed = JSON.parse(raw) as T;
    // Restore the primary from the backup. `backup: false` stops the restore
    // from rotating the corrupt primary over the only good copy we have.
    await writeAtomicFile(filePath, parsed, { backup: false });
    await warn(onWarning, filePath, error, true, null);
    return parsed;
  } catch {
    // No usable backup — fall through to quarantine.
  }

  const quarantinedPath = await quarantine(filePath);
  await warn(onWarning, filePath, error, false, quarantinedPath);
  return fallback;
}

/** Move the corrupt file out of the way so boot cannot trip on it repeatedly. */
async function quarantine(filePath: string): Promise<string | null> {
  const quarantinePath = `${filePath}.corrupt.${Date.now()}`;
  try {
    await fs.rename(filePath, quarantinePath);
    return quarantinePath;
  } catch {
    // Could not move it (already gone, or the FS refused). Leave it in place;
    // returning null just means "not quarantined".
    return null;
  }
}

async function warn(
  onWarning: StorageWarningHandler | undefined,
  filePath: string,
  error: Error,
  recoveredFromBackup: boolean,
  quarantinedPath: string | null,
): Promise<void> {
  console.warn(
    `[storage] corrupted storage file "${filePath}": ${error.message}; ` +
      (recoveredFromBackup
        ? "recovered from backup"
        : quarantinedPath
          ? `quarantined to "${quarantinedPath}"`
          : "no backup available, falling back"),
  );

  if (!onWarning) {
    return;
  }
  try {
    await onWarning("system:storageCorrupted", {
      filePath,
      error: error.message,
      recoveredFromBackup,
      quarantinedPath,
    });
  } catch {
    // A broken observer must never break recovery.
  }
}
