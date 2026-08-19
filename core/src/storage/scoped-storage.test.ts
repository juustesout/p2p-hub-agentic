import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ScopedStorage } from "./scoped-storage";
import { StorageCorruptionError } from "./atomic-write";

async function makeTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("corrupt storage file throws StorageCorruptionError, not silent empty", async () => {
  const dir = await makeTmpDir("scoped-storage-");
  const file = path.join(dir, "demo.json");
  const corrupt = '{"broken":';
  await fs.writeFile(file, corrupt, "utf8");

  const storage = new ScopedStorage("demo", dir);

  await assert.rejects(() => storage.get("k"), StorageCorruptionError);
  await assert.rejects(() => storage.list(), StorageCorruptionError);

  assert.equal(
    await fs.readFile(file, "utf8"),
    corrupt,
    "corrupt bytes must remain untouched on disk",
  );
});

test("a write on a corrupt store fails without overwriting the corrupt file", async () => {
  const dir = await makeTmpDir("scoped-storage-");
  const file = path.join(dir, "demo.json");
  const corrupt = '{"broken":';
  await fs.writeFile(file, corrupt, "utf8");

  const storage = new ScopedStorage("demo", dir);

  await assert.rejects(() => storage.set("k", "v"), StorageCorruptionError);

  assert.equal(
    await fs.readFile(file, "utf8"),
    corrupt,
    "a failed read-modify-write must not silently reset the corrupt store",
  );
});

test("missing storage file is an empty store, not an error", async () => {
  const dir = await makeTmpDir("scoped-storage-");
  const storage = new ScopedStorage("demo", dir);

  assert.equal(await storage.get("k"), undefined);
  assert.deepEqual(await storage.list(), []);
});

test("concurrent set calls to one instance commit every key (no lost update)", async () => {
  const dir = await makeTmpDir("scoped-storage-");
  const storage = new ScopedStorage("demo", dir);

  await Promise.all(
    Array.from({ length: 50 }, (_, i) => storage.set(`key-${i}`, `value-${i}`)),
  );

  const keys = await storage.list();
  assert.equal(keys.length, 50, "every concurrent write must be persisted");
  for (let i = 0; i < 50; i++) {
    assert.equal(await storage.get(`key-${i}`), `value-${i}`);
  }
});
