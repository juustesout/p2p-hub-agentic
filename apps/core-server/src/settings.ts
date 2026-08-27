import * as path from "node:path";
import { atomicWriteFile, readJsonFile } from "@p2p-hub/core";
import { normalizeSettings } from "@p2p-hub/sdk";
import type { EffectiveSettings } from "@p2p-hub/sdk";

/** Path of the minimal settings file (only the effective security flags). */
export function settingsFile(dataDir: string): string {
  return path.join(dataDir, "settings.json");
}

export async function loadSettings(dataDir: string): Promise<EffectiveSettings> {
  const stored = await readJsonFile<Partial<EffectiveSettings>>(
    settingsFile(dataDir),
  );
  return normalizeSettings(stored ?? undefined);
}

export async function saveSettings(
  dataDir: string,
  settings: EffectiveSettings,
): Promise<void> {
  await atomicWriteFile(settingsFile(dataDir), JSON.stringify(settings));
}
