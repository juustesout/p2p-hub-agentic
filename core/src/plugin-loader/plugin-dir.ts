/**
 * Plugin-directory symlink containment.
 *
 * The plugin-loader and the sandbox runner both resolve a plugin's entry to a
 * path and then check it stays inside the plugin directory. That check is
 * lexical (`startsWith(pluginDir + sep)`), which is exactly the discipline
 * CLAUDE.md principle #3 asks for — but a lexical check is blind to symlinks:
 * a `node_modules` link, a `.bin` shim or a crafted `entry` that is a symlink
 * to `/etc/passwd` resolves *through* the check and is then loaded as the
 * plugin's code. Under the Node Permission Model this is worse still: the model
 * follows symlinks even out of the granted path (documented limitation), so a
 * symlink inside a plugin dir would widen a scoped fs grant.
 *
 * This module walks a plugin directory *without* following links (lstat) and
 * rejects it when any symlink resolves to a target outside the directory. It is
 * the read-side mirror of the PeerSite realpath containment: both canonicalize
 * and both fail closed. Directories reached only through a symlink are never
 * recursed into (that would follow the link); the real directory is walked in
 * its own right, so nothing inside a plugin dir escapes scanning.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Raised when a plugin directory contains a symlink that resolves outside the
 * directory (or that cannot be resolved). Loading is refused — a plugin
 * directory must be self-contained.
 */
export class PluginDirSymlinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginDirSymlinkError";
  }
}

/**
 * Reject `pluginDir` when it contains a symlink whose realpath escapes the
 * directory. A dangling symlink (realpath fails) is rejected too: it is at best
 * a broken install and at worst an escape that materialises once its target is
 * created. Iterative walk, no link following, so deep trees and link loops are
 * handled without recursion.
 */
export async function assertPluginDirNoEscapingSymlinks(
  pluginDir: string,
): Promise<void> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(pluginDir);
  } catch {
    throw new PluginDirSymlinkError(
      `plugin directory "${pluginDir}" cannot be resolved to a realpath`,
    );
  }
  const rootPrefix = realRoot + path.sep;

  const pending: string[] = [realRoot];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw new PluginDirSymlinkError(
        `cannot read plugin directory "${dir}": ${(err as Error).message}`,
      );
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        await rejectIfEscaping(full, realRoot, rootPrefix);
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(full);
      }
    }
  }
}

async function rejectIfEscaping(
  linkPath: string,
  realRoot: string,
  rootPrefix: string,
): Promise<void> {
  let target: string;
  try {
    target = await fs.realpath(linkPath);
  } catch {
    throw new PluginDirSymlinkError(
      `plugin directory contains an unresolvable symlink "${linkPath}"`,
    );
  }
  if (target !== realRoot && !target.startsWith(rootPrefix)) {
    throw new PluginDirSymlinkError(
      `plugin directory contains a symlink "${linkPath}" that resolves ` +
        `outside the plugin directory (-> "${target}")`,
    );
  }
}
