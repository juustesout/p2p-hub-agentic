import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Probe whether the current environment can actually create symlinks.
 *
 * On Windows, `fs.symlink` throws `EPERM` unless the process is elevated or
 * Developer Mode is enabled; on any platform a restricted sandbox can refuse
 * them too. Tests that assert symlink handling must gate on this instead of a
 * hardcoded `process.platform` check, so environments where symlinks do work
 * (Windows with Developer Mode, normal POSIX) keep their coverage.
 */
export function canCreateSymlinksSync(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p2p-hub-symlink-probe-"));
  const target = path.join(dir, "target.txt");
  const link = path.join(dir, "link.txt");
  try {
    fs.writeFileSync(target, "probe");
    fs.symlinkSync(target, link);
    return fs.readFileSync(link, "utf8") === "probe";
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; the probe must not fail on a dirty tmpdir.
    }
  }
}
