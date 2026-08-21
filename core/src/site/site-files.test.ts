import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isPathInsideDataDir, resolveAndContainFile, validateSiteRoot } from "./site-files";
import { canCreateSymlinksSync } from "../test-support";

const SYMLINKS_OK = canCreateSymlinksSync();

async function makeDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("validateSiteRoot returns the canonical realpath of a valid root", async () => {
  const root = await makeDir("sitefiles-root-");
  const dataDir = await makeDir("sitefiles-data-");
  assert.equal(validateSiteRoot(root, dataDir), fs.realpathSync(root));
});

test("validateSiteRoot rejects a missing root", () => {
  assert.throws(
    () => validateSiteRoot(path.join(os.tmpdir(), "nope-xyz"), "/tmp"),
    /does not exist or cannot be resolved/,
  );
});

test("validateSiteRoot rejects a root equal to the data directory", async () => {
  const dataDir = await makeDir("sitefiles-data-");
  assert.throws(() => validateSiteRoot(dataDir, dataDir), /data directory/);
});

test("validateSiteRoot rejects a root inside the data directory (prefix-anchored)", async () => {
  const dataDir = await makeDir("sitefiles-data-");
  const inside = path.join(dataDir, "nested");
  await fsp.mkdir(inside, { recursive: true });
  assert.throws(() => validateSiteRoot(inside, dataDir), /data directory/);

  // The prefix must be anchored on the separator: a sibling whose name merely
  // starts with the data-dir name is NOT inside the data directory.
  const sibling = `${dataDir}-evil`;
  await fsp.mkdir(sibling, { recursive: true });
  assert.equal(validateSiteRoot(sibling, dataDir), fs.realpathSync(sibling));
});

test("Fase 2B: isPathInsideDataDir anchors on the trailing separator", async () => {
  const dataDir = await makeDir("sitefiles-data-");

  assert.equal(isPathInsideDataDir(dataDir, dataDir), true);
  assert.equal(isPathInsideDataDir(path.join(dataDir, "nested"), dataDir), true);

  const sibling = `${dataDir}-evil`;
  await fsp.mkdir(sibling, { recursive: true });
  assert.equal(isPathInsideDataDir(sibling, dataDir), false);
  assert.equal(isPathInsideDataDir("/tmp", dataDir), false);
});

test("Fase 2B: isPathInsideDataDir is realpath-aware (symlink escapes the data dir)", {
  skip: !SYMLINKS_OK && "symlinks unavailable in this environment",
}, async () => {
  const dataDir = await makeDir("sitefiles-data-");
  const outside = await makeDir("sitefiles-out-");
  await fsp.writeFile(path.join(outside, "secret.txt"), "top secret");
  const link = path.join(dataDir, "leak");
  await fsp.symlink(outside, link, "dir");

  // A path that lexically lives inside the data dir but realpaths outside it
  // must be reported as NOT inside — the check must see through the symlink.
  assert.equal(isPathInsideDataDir(link, dataDir), false);
  assert.equal(isPathInsideDataDir(path.join(link, "secret.txt"), dataDir), false);
});

test("resolveAndContainFile resolves nested files and directories to index.html", async () => {
  const root = await makeDir("sitefiles-root-");
  await fsp.writeFile(path.join(root, "index.html"), "<h1>root</h1>");
  await fsp.mkdir(path.join(root, "sub"), { recursive: true });
  await fsp.writeFile(path.join(root, "sub", "index.html"), "<h1>sub</h1>");

  assert.equal(
    resolveAndContainFile(root, "index.html"),
    fs.realpathSync(path.join(root, "index.html")),
  );
  assert.equal(
    resolveAndContainFile(root, "sub/index.html"),
    fs.realpathSync(path.join(root, "sub", "index.html")),
  );
  assert.equal(
    resolveAndContainFile(root, "sub"),
    fs.realpathSync(path.join(root, "sub", "index.html")),
  );
});

test("resolveAndContainFile denies traversal, dotfiles and backslashes", async () => {
  const root = await makeDir("sitefiles-root-");
  await fsp.writeFile(path.join(root, "index.html"), "hi");
  await fsp.writeFile(path.join(root, ".env"), "SECRET=1");

  for (const p of [
    "..",
    "../etc/passwd",
    "a/../../etc/passwd",
    ".env",
    ".git/config",
    "..\\secret.txt",
    "a\\..\\..\\etc\\passwd",
    "\0",
  ]) {
    assert.equal(resolveAndContainFile(root, p), null, `expected null for ${JSON.stringify(p)}`);
  }
});

test("resolveAndContainFile denies a symlink escaping the root", { skip: !SYMLINKS_OK && "symlinks unavailable in this environment" }, async () => {
  const root = await makeDir("sitefiles-root-");
  const outside = await makeDir("sitefiles-out-");
  await fsp.writeFile(path.join(outside, "secret.txt"), "top secret");
  await fsp.symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));

  assert.equal(resolveAndContainFile(root, "leak.txt"), null);
});

test("resolveAndContainFile returns null for a missing root or file", async () => {
  const root = await makeDir("sitefiles-root-");
  assert.equal(resolveAndContainFile(root, "missing.txt"), null);
  assert.equal(
    resolveAndContainFile(path.join(os.tmpdir(), "gone-root-xyz"), "index.html"),
    null,
  );
  assert.equal(resolveAndContainFile(root, 42 as unknown as string), null);
});
