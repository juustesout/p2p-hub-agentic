import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  atomicWriteFile,
  atomicWriteFileWith,
  type AtomicWriteFs,
} from "./atomic-write";

async function makeTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function listNames(dir: string): Promise<string[]> {
  return fs.readdir(dir);
}

test("atomicWriteFile writes exact content and leaves no temp file behind", async () => {
  const dir = await makeTmpDir("atomic-write-");
  const file = path.join(dir, "data.json");

  await atomicWriteFile(file, '{"ok":true}\n');

  assert.equal(await fs.readFile(file, "utf8"), '{"ok":true}\n');
  assert.ok(
    (await listNames(dir)).every((name) => !name.includes(".tmp-")),
    "no temp file may remain after a successful write",
  );

  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600, "default mode must be owner-only 0600");
});

test("a write that fails before rename leaves the target unchanged", async () => {
  const dir = await makeTmpDir("atomic-write-");
  const file = path.join(dir, "data.json");
  await fs.writeFile(file, "old valid data", "utf8");

  const crashingFs: AtomicWriteFs = {
    async open() {
      return {
        async writeFile() {},
        async sync() {
          throw new Error("simulated crash: fsync failed");
        },
        async close() {},
      };
    },
    async rename() {
      throw new Error("rename must not be reached after a failed sync");
    },
  };

  await assert.rejects(
    () => atomicWriteFileWith(file, "new data", 0o600, crashingFs),
    /simulated crash/,
  );

  assert.equal(
    await fs.readFile(file, "utf8"),
    "old valid data",
    "target must be untouched after a failed write",
  );
});

test("a failure at the rename step also leaves the target unchanged", async () => {
  const dir = await makeTmpDir("atomic-write-");
  const file = path.join(dir, "data.json");
  await fs.writeFile(file, "still the old bytes", "utf8");

  const renameFails: AtomicWriteFs = {
    async open() {
      return {
        async writeFile() {},
        async sync() {},
        async close() {},
      };
    },
    async rename() {
      throw new Error("simulated crash: rename failed");
    },
  };

  await assert.rejects(
    () => atomicWriteFileWith(file, "would-be new bytes", 0o600, renameFails),
    /rename failed/,
  );

  assert.equal(await fs.readFile(file, "utf8"), "still the old bytes");
});

test("two consecutive writes: the second fully replaces the first", async () => {
  const dir = await makeTmpDir("atomic-write-");
  const file = path.join(dir, "data.json");

  await atomicWriteFile(file, "first");
  await atomicWriteFile(file, "second");

  assert.equal(await fs.readFile(file, "utf8"), "second");
});
