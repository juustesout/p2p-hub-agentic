import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_WEBSITE_ASSET_BYTES } from "@p2p-hub/sdk";
import {
  mirrorDestination,
  mirrorFetchAndStore,
  type SiteAssetFetcher,
} from "./site-mirror";

test("mirrorDestination accepts a plain relative sub-path", () => {
  const dest = mirrorDestination("/mirror", "a/b.css");
  assert.equal(dest, path.join(path.resolve("/mirror"), "a", "b.css"));
});

test("mirrorDestination rejects traversal, dotfiles, backslashes and NUL", () => {
  const root = "/mirror";
  for (const bad of [
    "..",
    "../secret",
    "a/../../secret",
    ".env",
    "sub/.env",
    ".hidden",
    "a\\b",
    "a\0b",
    "a/..",
    "a/../..",
  ]) {
    assert.equal(mirrorDestination(root, bad), null, `expected "${bad}" denied`);
  }
});

test("mirrorDestination keeps absolute paths inside the root", () => {
  const dest = mirrorDestination("/mirror", "/etc/passwd");
  // The leading slash is not a segment; the path stays anchored under the root.
  assert.equal(dest, path.join(path.resolve("/mirror"), "etc", "passwd"));
});

test("mirrorFetchAndStore writes decoded bytes byte-exact", async () => {
  const mirrorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mirror-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x7f]);
  const fetcher: SiteAssetFetcher = async () => ({
    ok: true,
    contentType: "image/png",
    data: png.toString("base64"),
    name: "untrusted-name.png",
  });
  const stored = await mirrorFetchAndStore({
    fetcher,
    mirrorRoot,
    peerId: "a".repeat(64),
    path: "img/logo.png",
  });
  assert.ok(stored);
  const written = await fs.readFile(stored);
  assert.deepEqual(Buffer.from(written), png);
});

test("mirrorFetchAndStore derives the destination from the requested path only", async () => {
  const mirrorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mirror-"));
  const fetcher: SiteAssetFetcher = async () => ({
    ok: true,
    contentType: "text/html",
    data: Buffer.from("<h1>x</h1>").toString("base64"),
    name: "../../evil.html",
  });
  const stored = await mirrorFetchAndStore({
    fetcher,
    mirrorRoot,
    peerId: "a".repeat(64),
    path: "index.html",
  });
  assert.ok(stored);
  assert.equal(stored, path.join(mirrorRoot, "index.html"));
  assert.equal(
    await fs.readFile(path.join(mirrorRoot, "index.html"), "utf8"),
    "<h1>x</h1>",
  );
  // The untrusted name never produced a file.
  await assert.rejects(() => fs.stat(path.join(mirrorRoot, "evil.html")));
});

test("mirrorFetchAndStore returns null for a denied path", async () => {
  const mirrorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mirror-"));
  const fetcher: SiteAssetFetcher = async () => ({
    ok: true,
    contentType: "text/html",
    data: "aGk=",
    name: "x",
  });
  assert.equal(
    await mirrorFetchAndStore({
      fetcher,
      mirrorRoot,
      peerId: "a".repeat(64),
      path: "../escape",
    }),
    null,
  );
});

test("mirrorFetchAndStore returns null when the peer fails the request", async () => {
  const mirrorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mirror-"));
  const fetcher: SiteAssetFetcher = async () => ({ ok: false, code: "unauthorized" });
  assert.equal(
    await mirrorFetchAndStore({
      fetcher,
      mirrorRoot,
      peerId: "a".repeat(64),
      path: "index.html",
    }),
    null,
  );
});

test("mirrorFetchAndStore rejects an oversized payload on the consuming side", async () => {
  const mirrorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mirror-"));
  const big = Buffer.alloc(MAX_WEBSITE_ASSET_BYTES + 1, 0x61);
  const fetcher: SiteAssetFetcher = async () => ({
    ok: true,
    contentType: "application/octet-stream",
    data: big.toString("base64"),
    name: "big.bin",
  });
  assert.equal(
    await mirrorFetchAndStore({
      fetcher,
      mirrorRoot,
      peerId: "a".repeat(64),
      path: "big.bin",
    }),
    null,
  );
});
